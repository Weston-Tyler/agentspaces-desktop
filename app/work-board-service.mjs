import {progressContinuation,continuationView} from './work-continuation.mjs';
import { machineFields, machineChange, machineView } from './machine-queue.mjs';
import { decisionFields, decisionChange, decisionView, approvalCheck } from './coordination-records.mjs';
import { Identity, Peer, cbor, spaceIdLocal } from '@agentspaces/client';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TYPES } from './fabric.mjs';
import { projectWorkBoard } from './work-board.mjs';
import { protectStateDirectory } from './state-security.mjs';

const pathsOverlap = (left, right) => {
  const a = left.split(/\r?\n/).map(x => x.trim()).filter(Boolean), b = right.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return a.some(x => b.some(y => /[*?\[\]{}]/.test(x + y) || x === y || x.startsWith(y.replace(/\/$/,'') + '/') || y.startsWith(x.replace(/\/$/,'') + '/')));
};
const ownedPaths = value => {
  const paths = bounded(value, 4000, 'allowedFiles').split(/\r?\n/).map(x => x.trim().replace(/\\/g, '/')).filter(Boolean);
  if (!paths.length || paths.some(x => x.startsWith('/') || /^[A-Za-z]:/.test(x) || x.split('/').includes('..'))) throw new Error('Use repository-relative allowed paths');
  return [...new Set(paths)].join('\n');
};
const SPACE = 'desktop-work-board', RETENTION = 30 * 86400000;
const bounded = (v, n, name, empty = false) => {
  if (typeof v !== 'string' || v.length > n || (!empty && !v.trim())) throw new Error(`Invalid ${name}`);
  return v;
};
export class WorkBoard {
  constructor(engine) {
    this.engine = engine;
    this.root = join(engine.store.root, 'work-board');
    this.path = join(this.root, 'replica.cbor');
    this.peer = null; this.identity = null; this.agents = new Map(); this.tail = Promise.resolve();
  }
  open() {
    if (this.peer) return;
    protectStateDirectory(this.root, ['identity','agents','replica.cbor','replica.cbor.tmp','writer.lock']);
    this.identity = Identity.loadOrCreate(join(this.root, 'identity'));
    this.group = spaceIdLocal(`desktop-work-board/${this.identity.peerId}`);
    this.peer = new Peer(this.identity, this.group, this.engine.clock);
    this.receipts = {}; this.scope = null;
    try { if (existsSync(this.path)) {
      const bytes = readFileSync(this.path);
      if (bytes.length > 32 * 1024 * 1024) throw new Error('Work board exceeds storage limit');
      const saved = cbor.loads(bytes);
      if (saved.version !== 1) throw new Error('Unsupported work-board snapshot');
      this.peer.restoreSnapshot(saved.replica);
      this.receipts = saved.receipts; this.scope = saved.scope;
      if (this.peer.states.size !== saved.replica.states.length) {
        this.peer = null; throw new Error('Work-board snapshot verification failed; preserve the file for recovery');
      }
    } } catch (error) { this.peer = null; throw error; }
  }
  access(binding, { create = false } = {}) {
    const p = this.engine.workspace.index?.profile;
    if (!p?.active || p.policy !== 'local-retrieval') throw new Error('Connect an active local-retrieval workspace for the work board');
    const actor = binding ? this.engine.discussions.participant(binding) : null;
    if (actor && (actor.scopeId !== p.id || actor.account !== p.account)) throw new Error('Work-board scope denied');
    // A disabled/replaced scope never silently inherits another scope's work.
    if (this.scope && (this.scope.id !== p.id || this.scope.account !== p.account)) throw new Error('Work board belongs to another workspace scope');
    if (!this.scope && create) this.scope = { id: p.id, account: p.account };
    return actor?.id ?? 'desktop-owner';
  }
  agent(id) {
    if (!this.agents.has(id)) {
      const name = createHash('sha256').update(id).digest('hex').slice(0, 60);
      const key = Identity.agentKeys(join(this.root, 'agents'), this.identity.peerId, name);
      this.agents.set(id, this.identity.renewingSubordinate(name, 'PT24H', key, this.engine.clock));
    }
    return this.agents.get(id);
  }
  view(binding, options = {}) {
    if (Object.keys(options).some(k => k !== 'limit')) throw new Error('Unknown work-board list field');
    const { limit = 100 } = options;
    // Check grants before opening a private replica.
    this.access(binding);
    if (this.writing) throw new Error('Work board is saving; refresh shortly');
    this.peer = null; this.open(); this.access(binding);
    const result = projectWorkBoard({ groupId: this.group, space: SPACE,
      states: this.peer.states, claims: this.peer.claims, now: this.engine.clock(), limit });
    const labels = new Map(Object.values(this.receipts).filter(r => r.result.holder && r.result.holderSource).map(r => [r.result.holder, r.result.holderSource]));
    for (const item of result.items) {
      const source = labels.get(item.holder);
      item.holderLabel = source === 'desktop-owner' ? 'Desktop owner' : this.engine.catalog.find(s => s.id === source)?.title ?? source ?? item.holder;
    }
    return { ...result, scope: this.scope, mode: 'single-companion',
      coverage: { ...result.coverage, synchronized: true, source: 'durable companion-owned AgentSpaces replica' },
      capabilities: { create: true, claim: true, update: true, complete: true, modelExecution: false } };
  }
  continuations(binding, options = {}) { return continuationView(this,binding,options); }
  machines(binding, options = {}) { return machineView(this, binding, options); }
  decisions(binding, options = {}) { return decisionView(this, binding, options); }
  async verifyApproval(binding,input) {
    approvalCheck(this,binding,input);
    const deliveryId='verify-'+createHash('sha256').update(JSON.stringify([input.entryId,input.requestHash,input.receiptId])).digest('hex');
    const receipt=await this.mutate({action:'decision_verify',deliveryId,...input},binding);
    // Re-read after persistence even on duplicate/restart. Revocation and expiry never cache.
    return {...approvalCheck(this,binding,input),verificationEntryId:receipt.verificationEntryId};
  }
  mutate(input, binding, ownerProof = null) {
    const operation = this.tail.then(async () => {
      this.access(binding);
      protectStateDirectory(this.root, ['identity','agents','replica.cbor','replica.cbor.tmp','writer.lock']);
      const lock = join(this.root, 'writer.lock'); let fd;
      try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Work-board writer busy or interrupted; preserve the lock until its owner is confirmed stopped');
        throw error;
      }
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid }));
        this.writing = true; this.peer = null;
        return await this.apply(input, binding, ownerProof);
      } finally { this.writing = false; closeSync(fd); unlinkSync(lock); }
    });
    this.tail = operation.catch(() => {}); return operation;
  }
  async apply(input, binding, ownerProof) {
    const { action, deliveryId } = input;
    if (!['create', 'claim', 'renew', 'update', 'complete', ...Object.keys(decisionFields), ...Object.keys(machineFields)].includes(action)) throw new Error('Unknown work-board action');
    bounded(deliveryId, 100, 'deliveryId');
    if (!/^[A-Za-z0-9-]{8,100}$/.test(deliveryId)) throw new Error('Stable deliveryId required');
    const allowed = ['action','deliveryId', ...(decisionFields[action] ?? machineFields[action] ?? (action === 'create' ? ['title','brief','repository','base','allowedFiles'] : ['claim','renew'].includes(action) ? ['entryId','leaseMinutes'] : ['entryId','status','summary','branch','head','evidence','continuation']))];
    if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('Unknown work-board field');
    this.access(binding); this.open();
    const actor = this.access(binding), key = createHash('sha256').update(`${actor}:${deliveryId}`).digest('hex');
    const digest = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b]) => a.localeCompare(b))))).digest('hex');
    const prior = this.receipts[key];
    if (prior) {
      if (prior.digest !== digest) throw new Error('deliveryId reused with different work');
      return { ...prior.result, duplicate: true };
    }
    if (Object.keys(this.receipts).length >= 10000 || this.peer.states.size >= 10000) throw new Error('Work-board capacity reached; archive through an explicit maintenance operation');
    const before = this.peer.exportSnapshot(), oldScope = this.scope;
    try {
      this.access(binding, { create: true });
      const agent = this.agent(actor);
      let entryId = input.entryId, result;
      if (machineFields[action]) {
        result = await machineChange(this,input,binding,actor,agent);
      } else if (decisionFields[action]) {
        result = await decisionChange(this,input,binding,actor,agent,ownerProof);
      } else if (action === 'create') {
        const value = { title: bounded(input.title, 200, 'title'), brief: bounded(input.brief, 12000, 'brief'),
          repository: bounded(input.repository, 2000, 'repository').trim().replace(/\/+$/, ''), base: bounded(input.base, 200, 'base'),
          allowedFiles: ownedPaths(input.allowedFiles), createdBy: actor,
          createdAt: new Date(this.engine.clock()).toISOString(), authority: 'coordination brief; native authorization remains required' };
        entryId = this.peer.writeEntry(SPACE, TYPES.request, value, 'owner', RETENTION, agent);
        result = { entryId, status: 'available' };
      } else {
        bounded(entryId, 100, 'entryId');
        const dto = this.peer.states.get(entryId), record = dto?.record;
        if (!record || record.type !== TYPES.request || record.spaceId !== spaceIdLocal(`${this.group}/${SPACE}`)) throw new Error('Unknown work item');
        if (dto.completed) throw new Error('Work item already completed');
        if (Number(dto.leaseValue?.expiresAtMillis ?? record.lease?.expiresAtMillis) <= this.engine.clock()) throw new Error('Work item expired');
        if (action === 'claim' || action === 'renew') {
          const minutes = input.leaseMinutes ?? 15;
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Claim lease must be 1–60 minutes');
          if (action === 'claim') {
            const value = cbor.loads(Buffer.from(record.payload));
            for (const [otherId, other] of this.peer.states) {
              if (otherId === entryId || other.completed || other.record?.type !== TYPES.request) continue;
              const lease = this.peer.claims.get(otherId)?.claim;
              if (!lease || Number(lease.expiresAtMillis) <= this.engine.clock()) continue;
              const otherValue = cbor.loads(Buffer.from(other.record.payload));
              if (value.repository === otherValue.repository && pathsOverlap(value.allowedFiles, otherValue.allowedFiles)) throw new Error('Another live work claim overlaps these repository paths');
            }
          }
          if (action === 'renew') this.peer.renewClaim(SPACE, entryId, minutes * 60000, agent);
          const held = action === 'renew' ? entryId : await this.peer.takeEntry(SPACE, TYPES.request, 'worker', minutes * 60000, 0, 700, agent, entryId);
          if (held !== entryId) throw new Error('Work item is already claimed or unavailable');
          const claim = this.peer.claims.get(entryId).claim;
          result = { entryId, status: 'claimed', holder: agent.agentId, holderSource: actor, expiresAt: Number(claim.expiresAtMillis) };
        } else {
          this.peer.requireHeld(SPACE, entryId, agent);
          const status = action === 'complete' ? 'completed' : input.status;
          if (!['in_progress','blocked','completed'].includes(status) || action === 'update' && status === 'completed') throw new Error('Invalid progress status');
          const sequence = [...this.peer.states.values()].filter(s => s.record?.type === TYPES.result && cbor.loads(Buffer.from(s.record.payload)).requestEntryId === entryId).length + 1;
          const continuation=input.continuation===undefined?undefined:progressContinuation(this,input,binding);
          const value = { requestEntryId: entryId, sequence, status,...(continuation?{continuation}:{}), summary: bounded(input.summary, 8000, 'summary'),
            branch: bounded(input.branch, 300, 'branch'), head: bounded(input.head, 200, 'head'),
            evidence: bounded(input.evidence, 12000, 'evidence', action !== 'complete'), actor,
            claimStamp: this.peer.claims.get(entryId).claim.stamp,
            at: new Date(this.engine.clock()).toISOString() };
          const resultEntryId = this.peer.writeEntry(SPACE, TYPES.result, value, 'worker', RETENTION, agent);
          if (action === 'complete') this.peer.completeEntry(SPACE, entryId, agent);
          result = { entryId, resultEntryId, status };
        }
      }
      this.access(binding);
      if (this.peer.states.size > 10000) throw new Error('Work-board record capacity reached');
      this.receipts[key] = { digest, result };
      const bytes = cbor.dumps({ version: 1, scope: this.scope, receipts: this.receipts, replica: this.peer.exportSnapshot() });
      if (bytes.length > 32 * 1024 * 1024) throw new Error('Work board exceeds storage limit');
      const temporary = this.path + '.tmp';
      writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, this.path);
      return result;
    } catch (error) {
      this.peer = new Peer(this.identity, this.group, this.engine.clock);
      this.peer.restoreSnapshot(before); this.scope = oldScope; delete this.receipts[key];
      throw error;
    }
  }
}
