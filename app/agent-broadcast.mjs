import { createHash } from "node:crypto";
import { parseAgentSelectors, selectAgents, selectAgentsForOwner } from "./agent-selection.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = code => Object.assign(new Error(code), { code });
const pendingByEngine = new WeakMap();
const identity = source => ({ id: source.id, nativeThreadId: source.nativeThreadId, provider: source.provider,
  host: source.host, account: source.account, project: source.project, scopeId: source.scopeId ?? null });

export class AgentBroadcast {
  constructor(engine) {
    if (!engine?.discussions || !engine?.store) throw fail("invalid_agent_broadcast_configuration");
    this.engine = engine;
    // Minimal delivery receipts retain the approved recipient snapshot. Native
    // dispatch, work authority and scheduling stay in their existing owners.
    engine.store.data.agentBroadcastReceipts ??= {};
    if (!pendingByEngine.has(engine)) pendingByEngine.set(engine, new Map());
    this.pending = pendingByEngine.get(engine);
  }
  validate(input, { owner = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["text", "nativeTurnId", "deliveryId", "query", "activeWithinDays", "sessionIds", "nativeThreadIds", "discussionId"].includes(key))
      || typeof input.text !== "string" || !input.text.trim() || input.text.length > 8000
      || !owner && (typeof input.nativeTurnId !== "string" || !input.nativeTurnId || input.nativeTurnId.length > 200)
      || owner && (input.nativeTurnId !== undefined || input.discussionId === undefined)
      || !/^[a-zA-Z0-9-]{8,100}$/.test(input.deliveryId ?? "")
      || input.query !== undefined && (typeof input.query !== "string" || input.query.length > 500)
      || input.activeWithinDays !== undefined && (!Number.isInteger(input.activeWithinDays) || input.activeWithinDays < 1 || input.activeWithinDays > 3650)
      || input.sessionIds !== undefined && (!Array.isArray(input.sessionIds) || !input.sessionIds.length || input.sessionIds.length > 200 || input.sessionIds.some(id => typeof id !== "string" || !id || id.length > 300))
      || input.nativeThreadIds !== undefined && (!Array.isArray(input.nativeThreadIds) || !input.nativeThreadIds.length || input.nativeThreadIds.length > 200 || input.nativeThreadIds.some(id => !UUID.test(id ?? "")))
      || input.discussionId !== undefined && !UUID.test(input.discussionId ?? "")) throw fail("bounded_agent_broadcast_required");
    const parsed = parseAgentSelectors(input.text);
    if (!parsed.text) throw fail("agent_broadcast_message_required");
    return { ...input, text: parsed.text, originalText: input.text, parsedCriteria: parsed.criteria };
  }
  snapshot(request, binding, caller, key, ownerBoundary = null) {
    let origin;
    if (request.discussionId) {
      if (!ownerBoundary && !this.engine.discussions.contextOrJoin(request.discussionId, binding).available) throw fail("broadcast_origin_unavailable");
      origin = this.engine.discussions.group(request.discussionId);
      if (!ownerBoundary && !this.engine.discussions.policy(origin).agentInitiation) throw fail("broadcast_origin_agent_initiation_disabled");
    }
    const parsed = request.parsedCriteria, sessionIds = new Set(request.sessionIds ?? []);
    const nativeThreadIds = new Set([...(request.nativeThreadIds ?? []), ...(parsed.nativeThreadIds ?? [])].map(id => id.toLowerCase()));
    const query = [request.query, parsed.query].filter(value => value?.trim()).join(" ");
    const windows = [request.activeWithinDays, parsed.activeWithinDays].filter(value => value !== undefined);
    const activeWithinDays = windows.length ? Math.min(...windows) : undefined;
    const catalogSelector = !!query || activeWithinDays !== undefined || sessionIds.size > 0 || nativeThreadIds.size > 0;
    const aliases = [...request.text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)].map(match => match[1]);
    if (parsed.all && !origin) throw fail("broadcast_all_requires_discussion");
    if (origin) {
      for (const alias of aliases) {
        const member = origin.members.find(item => item.alias === alias);
        if (!member) throw fail("broadcast_unknown_room_alias");
        sessionIds.add(member.sessionId);
      }
      if (parsed.all || !catalogSelector && !aliases.length) for (const member of origin.members) if (member.sessionId !== caller.id) sessionIds.add(member.sessionId);
    } else if (!catalogSelector) throw fail("agent_broadcast_selector_required");
    if (origin && (parsed.all || !catalogSelector) && !sessionIds.size && !nativeThreadIds.size) sessionIds.add(caller.id);
    const criteria = {
      ...(sessionIds.size ? { sessionIds: [...sessionIds] } : {}), ...(nativeThreadIds.size ? { nativeThreadIds: [...nativeThreadIds] } : {}),
      ...(query ? { query } : {}), ...(activeWithinDays !== undefined ? { activeWithinDays } : {}), limit: 200,
    };
    const selection = ownerBoundary ? selectAgentsForOwner(this.engine, criteria, ownerBoundary) : selectAgents(this.engine, binding, criteria);
    const selected = selection.matches.map(identity), ids = selected.map(source => source.id), batches = [];
    if (ids.length && origin && new Set([...origin.members.map(member => member.sessionId), ...ids]).size <= 12) {
      batches.push({ targetSessionIds: ids, discussionId: origin.id, createdGroup: false, origin: true });
    } else for (let index = 0; index < ids.length; index += 11) batches.push({ targetSessionIds: ids.slice(index, index + 11), createdGroup: true, origin: false });
    for (const [index, batch] of batches.entries()) {
      batch.groupDeliveryId = "broadcast-group-" + hash([key, index]);
      batch.messageDeliveryId = "broadcast-message-" + hash([key, index]);
    }
    return { selected, coverage: selection.coverage, omitted: selection.omitted, matchedCount: selection.matchedCount, batches };
  }
  ownerBoundary(discussionId) {
    const group = this.engine.discussions.group(discussionId), first = group.members[0];
    if (!first || !group.members.every(member => this.engine.discussions.allowed(member)) || !this.engine.discussions.view(group).available
      || !group.members.every(member => member.account === first.account)) throw fail("broadcast_owner_origin_unavailable");
    if (first.scopeId && group.members.every(member => member.scopeId === first.scopeId)) return { account: first.account, scopeId: first.scopeId };
    if (group.members.every(member => member.project === first.project)) return { account: first.account, project: first.project };
    throw fail("broadcast_owner_boundary_unavailable");
  }
  recheckOwner(receipt) {
    const boundary = this.ownerBoundary(receipt.originId);
    if (!receipt.selected.length) { selectAgentsForOwner(this.engine, { sessionIds: ["owner"] }, boundary); return; }
    const selection = selectAgentsForOwner(this.engine, { sessionIds: receipt.selected.map(source => source.id) }, boundary);
    const current = new Map(selection.matches.map(source => [source.id, identity(source)]));
    for (const saved of receipt.selected) if (hash(current.get(saved.id) ?? null) !== hash(saved)) throw fail("broadcast_recipient_identity_or_grant_changed");
  }
  async sendOwner(input) {
    const request = this.validate(input, { owner: true }), boundary = this.ownerBoundary(request.discussionId);
    const key = hash(["owner", request.discussionId, request.deliveryId]), fingerprint = hash({ owner: true, request });
    const existing = this.engine.store.data.agentBroadcastReceipts[key];
    if (existing && (!existing.owner || existing.fingerprint !== fingerprint)) throw fail("agent_broadcast_delivery_id_conflict");
    const pending = this.pending.get(key);
    if (pending) { if (pending.fingerprint !== fingerprint) throw fail("agent_broadcast_delivery_id_conflict"); return pending.operation; }
    const operation = Promise.resolve().then(() => this.performOwner(request, boundary, key, fingerprint));
    this.pending.set(key, { fingerprint, operation });
    try { return await operation; }
    finally { if (this.pending.get(key)?.operation === operation) this.pending.delete(key); }
  }
  performOwner(request, boundary, key, fingerprint) {
    const receipts = this.engine.store.data.agentBroadcastReceipts;
    let receipt = receipts[key], duplicate = receipt?.state === "posted";
    if (!receipt) {
      if (Object.keys(receipts).length >= 1000) throw fail("agent_broadcast_receipt_limit_reached");
      const snapshot = this.snapshot(request, null, { id: "owner" }, key, boundary);
      // Keep the human's original room visibly informed even when selection
      // fans out into other rooms, or no eligible peer matches.
      if (!snapshot.batches.some(batch => batch.discussionId === request.discussionId)) snapshot.batches.unshift({ discussionId: request.discussionId, targetSessionIds: [], createdGroup: false, origin: true });
      for (const batch of snapshot.batches) if (batch.origin) batch.messageDeliveryId = request.deliveryId;
      receipt = receipts[key] = { owner: true, sourceId: "owner", originId: request.discussionId, deliveryId: request.deliveryId, fingerprint, ...snapshot, state: "prepared" };
      this.engine.store.save();
    }
    this.recheckOwner(receipt);
    for (const [index, batch] of receipt.batches.entries()) {
      let group = batch.discussionId ? this.engine.discussions.group(batch.discussionId) : this.engine.store.data.discussions.find(item => item.creation?.owner && item.creation.deliveryId === batch.groupDeliveryId);
      if (!group) {
        const created = this.engine.discussions.create({ title: "Owner broadcast " + index, sessionIds: batch.targetSessionIds, agentInitiation: true, selfRegistration: true }, { owner: true, deliveryId: batch.groupDeliveryId, fingerprint });
        group = this.engine.discussions.group(created.id);
      }
      if (!batch.discussionId) { batch.discussionId = group.id; this.engine.store.save(); }
      for (const id of batch.targetSessionIds) if (!group.members.some(member => member.sessionId === id)) this.engine.discussions.inviteOwner({ id: group.id, sessionId: id });
      this.recheckOwner(receipt);
      const existing = group.messages.find(message => message.deliveryId === batch.messageDeliveryId);
      if (existing && !existing.inputHash) {
        if (existing.source || existing.text !== request.text.trim() || existing.turnId !== null || existing.replyTo !== null) throw fail("agent_broadcast_delivery_id_conflict");
        existing.inputHash = hash({ text: request.text.trim(), targets: group.members.filter(member => batch.targetSessionIds.includes(member.sessionId)).map(member => member.sessionId), fixtureDialogueTurns: 0 }); this.engine.store.save();
      }
      this.engine.discussions.post({ id: group.id, text: request.text, targets: batch.targetSessionIds, deliveryId: batch.messageDeliveryId }, { exactTargets: true });
      const message = group.messages.find(item => item.deliveryId === batch.messageDeliveryId);
      if (!message.routing) {
        message.wire.metadata.originalSelectorText = request.originalText;
        message.wire.metadata.agentSelection = JSON.stringify(batch.targetSessionIds);
        message.wire.metadata.agentSelectionCoverage = JSON.stringify({ selectedCount: receipt.selected.length, batchCount: receipt.batches.filter(item => item.targetSessionIds.length).length, coverage: receipt.coverage, omitted: receipt.omitted });
      }
      batch.messageId = message.id; this.engine.store.save();
    }
    receipt.state = "posted"; this.engine.store.save();
    return this.result(receipt, duplicate);
  }
  recheck(selected, binding) {
    const caller = this.engine.discussions.participant(binding);
    for (const saved of selected) {
      const current = this.engine.session(saved.id);
      if (hash(identity(current)) !== hash(saved)) throw fail("broadcast_recipient_identity_changed");
      this.engine.discussions.sharingBoundary(caller, [current.id]);
    }
    return caller;
  }
  async send(input, binding) {
    const request = this.validate(input), caller = this.engine.discussions.participant(binding);
    const key = hash([caller.id, request.deliveryId]), fingerprint = hash({ sourceId: caller.id, request });
    const existing = this.engine.store.data.agentBroadcastReceipts[key];
    if (existing && existing.fingerprint !== fingerprint) throw fail("agent_broadcast_delivery_id_conflict");
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw fail("agent_broadcast_delivery_id_conflict");
      return pending.operation;
    }
    const operation = Promise.resolve().then(() => this.perform(request, binding, caller, key, fingerprint));
    this.pending.set(key, { fingerprint, operation });
    try { return await operation; }
    finally { if (this.pending.get(key)?.operation === operation) this.pending.delete(key); }
  }
  perform(request, binding, caller, key, fingerprint) {
    const receipts = this.engine.store.data.agentBroadcastReceipts;
    let receipt = receipts[key], duplicate = receipt?.state === "posted";
    if (!receipt) {
      if (Object.keys(receipts).length >= 1000) throw fail("agent_broadcast_receipt_limit_reached");
      receipt = receipts[key] = { sourceId: caller.id, deliveryId: request.deliveryId, fingerprint,
        ...this.snapshot(request, binding, caller, key), state: "prepared" };
      this.engine.store.save();
    }
    this.recheck(receipt.selected, binding);
    for (const [index, batch] of receipt.batches.entries()) {
      const selected = receipt.selected.filter(source => batch.targetSessionIds.includes(source.id));
      this.recheck(selected, binding);
      let group;
      if (batch.discussionId) group = this.engine.discussions.group(batch.discussionId);
      else {
        const created = this.engine.discussions.createFor({ title: "Agent broadcast " + (index + 1), sessionIds: batch.targetSessionIds, deliveryId: batch.groupDeliveryId }, binding);
        group = this.engine.discussions.group(created.id); batch.discussionId = group.id; this.engine.store.save();
      }
      for (const id of batch.targetSessionIds) if (!group.members.some(member => member.sessionId === id)) this.engine.discussions.invite({ id: group.id, sessionId: id }, binding);
      this.recheck(selected, binding);
      if (!this.engine.discussions.policy(group).agentInitiation) throw fail("broadcast_room_agent_initiation_disabled");
      const existing = group.messages.find(message => message.deliveryId === batch.messageDeliveryId);
      if (existing && !existing.inputHash) {
        if (existing.source?.sessionId !== caller.id || existing.text !== request.text || existing.turnId !== request.nativeTurnId || existing.replyTo !== null) throw fail("agent_broadcast_delivery_id_conflict");
        existing.inputHash = hash({ text: request.text, nativeTurnId: request.nativeTurnId, replyTo: null, sessionId: caller.id }); this.engine.store.save();
      }
      this.engine.discussions.contribute({ id: group.id, text: request.text, nativeTurnId: request.nativeTurnId, deliveryId: batch.messageDeliveryId }, binding);
      const message = group.messages.find(item => item.deliveryId === batch.messageDeliveryId);
      if (!message.routing) {
        message.targets = batch.targetSessionIds.map(id => ({ sessionId: id, alias: group.members.find(member => member.sessionId === id).alias, status: "pending native eligibility check; no wake dispatched" }));
        message.wire.metadata.targets = JSON.stringify(batch.targetSessionIds);
        message.wire.metadata.originalSelectorText = request.originalText;
        message.wire.metadata.agentSelection = JSON.stringify(batch.targetSessionIds);
        message.wire.metadata.agentSelectionCoverage = JSON.stringify({ selectedCount: receipt.selected.length, batchCount: receipt.batches.filter(item => item.targetSessionIds.length).length, coverage: receipt.coverage, omitted: receipt.omitted });
      }
      batch.messageId = message.id; this.engine.store.save();
    }
    receipt.state = "posted"; this.engine.store.save();
    return this.result(receipt, duplicate);
  }
  result(receipt, duplicate) {
    return { deliveryId: receipt.deliveryId, selectedSourceIds: receipt.selected.map(source => source.id),
      selected: structuredClone(receipt.selected), coverage: structuredClone(receipt.coverage), omitted: structuredClone(receipt.omitted),
      matchedCount: receipt.matchedCount, batches: receipt.batches.map(batch => ({ discussionId: batch.discussionId, messageId: batch.messageId, targetSessionIds: [...batch.targetSessionIds], createdGroup: batch.createdGroup })), duplicate: !!duplicate };
  }
}
