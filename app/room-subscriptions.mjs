import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid ${name}`);
  return value.trim();
};
const strict = (input, fields) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw Error('Unknown subscription/digest field');
};
export function subscriptionMatches(subscription, text) {
  if (!subscription || subscription.mode !== 'wake') return false;
  const normalized = text.toLowerCase();
  return subscription.topics.some(topic => normalized.includes(topic)) || !!subscription.workEntryId &&
    text.split(/\s+/).some(word => word.replace(/^[([{`]|[)\]},.;:`]$/g, '') === subscription.workEntryId);
}
export function implicitRoomWake(group, sessionId, text, { peer = false, messageIndex = group.messages.length } = {}) {
  const subscription = group.subscriptions?.find(item => item.sessionId === sessionId);
  // Existing owner openings retain their original default; peer openings require
  // an explicit subscription. Replies never reach this helper for peer delivery.
  return subscription ? messageIndex >= subscription.fromMessage && subscriptionMatches(subscription, text) : !peer;
}
export class RoomSubscriptions {
  constructor(engine) { this.engine = engine; }
  access(binding) {
    if (binding) this.engine.discussions.participant(binding);
    this.engine.workBoard.access(binding);
  }
  room(id, binding) {
    bounded(id, 100, 'discussion id'); this.access(binding);
    const group = this.engine.discussions.group(id);
    const profile = this.engine.workspace.index.profile;
    if (group.members.some(member => member.scopeId !== profile.id || member.account !== profile.account)) throw Error('Discussion workspace scope denied');
    const view = this.engine.discussions.context(id, binding ?? {sessionId:group.members[0]?.sessionId});
    if (!view.available) throw Error('Discussion unavailable');
    return group;
  }
  list(input, binding = null) {
    strict(input, ['id']);
    const group = this.room(input.id, binding);
    return {id:group.id,items:(group.subscriptions ?? []).filter(item => !binding || item.sessionId === binding.sessionId),
      defaultOwnerWake:'all eligible members until a preference is set',defaultPeerWake:'explicit addresses only',
      authority:'Delivery preferences only; native authorization and room grants remain authoritative'};
  }
  change(input, binding = null) {
    strict(input, ['id','sessionId','mode','topics','workEntryId']);
    const group = this.room(input.id, binding), sessionId = binding?.sessionId ?? input.sessionId;
    if (binding && input.sessionId !== undefined && input.sessionId !== binding.sessionId) throw Error('May change only your own subscription');
    if (!group.members.some(member => member.sessionId === sessionId)) throw Error('Subscription target must be a discussion participant');
    if (!['wake','digest','off'].includes(input.mode)) throw Error('Invalid subscription mode');
    if (!Array.isArray(input.topics) || input.topics.length > 12) throw Error('Use at most 12 topics');
    const topics = [...new Set(input.topics.map(topic => bounded(topic,80,'topic').toLowerCase()))];
    const workEntryId = input.workEntryId === undefined ? null : bounded(input.workEntryId,100,'workEntryId');
    if (workEntryId && !this.engine.workBoard.view(binding,{limit:200}).items.some(row => row.entryId === workEntryId && row.status !== 'expired')) throw Error('Unknown, expired or outside bounded view work item');
    if (input.mode !== 'off' && !topics.length && !workEntryId) throw Error('Choose at least one topic or brief');
    const value = {sessionId,mode:input.mode,topics,workEntryId};
    const before = group.subscriptions?.find(item => item.sessionId === sessionId);
    if (before?.hash !== hash(value)) {
      const saved = {...value,fromMessage:group.messages.length,hash:hash(value),changedBy:binding?.sessionId ?? 'desktop-owner',updatedAt:new Date(this.engine.clock()).toISOString()};
      group.subscriptions = [...(group.subscriptions ?? []).filter(item => item.sessionId !== sessionId),saved];
      group.version++; this.engine.store.save();
      this.engine.store.audit('Room subscription changed',{discussionId:group.id,sessionId,mode:input.mode,hash:saved.hash});
    }
    return this.list({id:group.id},binding);
  }
  digest(input = {}, binding = null) {
    strict(input,['since','query','limit','discussionId']); this.access(binding);
    const {limit=100,query=''}=input;
    if (!Number.isInteger(limit) || limit<1 || limit>200) throw Error('Digest limit must be 1–200');
    if (typeof query !== 'string' || query.length>200) throw Error('Invalid digest query');
    if (input.since !== undefined && (typeof input.since !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(input.since) || !Number.isFinite(Date.parse(input.since)))) throw Error('Invalid since timestamp');
    if (input.discussionId !== undefined) this.room(input.discussionId,binding);
    const since = input.since === undefined ? -Infinity : Date.parse(input.since), records=[];
    const add = (kind,id,at,title,text,provenance,extra={}) => {
      const timestamp = typeof at === 'number' ? at : Date.parse(at);
      if (!Number.isFinite(timestamp) || timestamp<since || ![title,text].join(' ').toLowerCase().includes(query.toLowerCase())) return;
      records.push({kind,id,at:new Date(timestamp).toISOString(),title:String(title).slice(0,200),text:String(text).slice(0,2000),textTruncated:String(text).length>2000,provenance,...extra,authority:'untrusted coordination evidence'});
    };
    let roomTruncated=false, roomsObserved=0;
    for (const group of this.engine.store.data.discussions ?? []) {
      if (input.discussionId && group.id !== input.discussionId) continue;
      try { this.room(group.id,binding); } catch { continue; }
      if (++roomsObserved>200) { roomTruncated=true; break; }
      roomTruncated ||= group.messages.length>1000;
      for (const message of group.messages.slice(-1000)) if (!message.synthetic) add('message',message.id,message.at,group.title,message.text,
        {store:'discussion',discussionId:group.id,messageId:message.id,sourceId:message.source?.sessionId ?? 'desktop-owner',hash:hash(message),hashBasis:'JSON stored message record'},
        {replyTo:message.replyTo ?? null});
    }
    // These are projections from the owning, verified replica, not a second ledger.
    const work=this.engine.workBoard.view(binding,{limit:200}), decisions=this.engine.workBoard.decisions(binding,{limit:200});
    for (const row of work.items) {
      add('work',row.entryId,row.value.createdAt,row.value.title,row.value.brief,{store:'AgentSpaces work replica',entryId:row.entryId,hash:row.hash,hashBasis:'CBOR record payload',sourceId:row.value.createdBy},{status:row.status});
      for (const result of row.results) add('work-result',result.entryId,result.value.at,row.value.title,result.value.summary+'\n'+result.value.evidence,
        {store:'AgentSpaces work replica',entryId:result.entryId,workEntryId:row.entryId,hash:result.hash,hashBasis:'CBOR record payload',sourceId:result.value.actor},{status:result.value.status});
    }
    for (const row of decisions.items) {
      add('decision',row.entryId,row.value.createdAt,row.value.title,row.value.question,{store:'AgentSpaces coordination replica',entryId:row.entryId,hash:row.hash,hashBasis:'CBOR record payload',sourceId:row.value.createdBy},{status:row.status});
      for (const answer of [row.answer,row.revocation].filter(Boolean)) add('decision-answer',answer.entryId,answer.value.at ?? answer.value.answeredAt ?? answer.value.verification?.verifiedAt,row.value.title,answer.value.rationale ?? answer.value.outcome ?? answer.value.status,
        {store:'AgentSpaces coordination replica',entryId:answer.entryId,decisionId:row.entryId,hash:answer.hash,hashBasis:'CBOR record payload',sourceId:answer.value.actor ?? 'desktop-owner'});
    }
    // Reuse the owning artifact-drop projection when that integration is installed.
    // Its read path checks author grants, room membership, expiry and content hashes.
    const drops=typeof this.engine.workBoard.artifacts === 'function' ? this.engine.workBoard.artifacts(binding,{limit:200}) : null;
    for (const row of drops?.items ?? []) add('artifact-drop',row.entryId,row.value.createdAt,row.value.name,
      `Version ${row.value.version} · ${row.value.artifact.mediaType} · ${row.value.artifact.bytes} bytes`,
      {store:'AgentSpaces finding replica',entryId:row.entryId,hash:row.hash,hashBasis:'CBOR record payload',sourceId:row.value.source.participantId,
        artifactHash:row.value.artifact.digest,version:row.value.version,workEntryId:row.value.workEntryId,discussionId:row.value.discussionId,messageId:row.value.messageId});
    const artifacts=this.engine.workspace.search({kind:'artifact',query,limit:50});
    for (const node of artifacts.items) add('artifact',node.id,node.modifiedAt,node.title,node.path,
      {store:'workspace index',nodeId:node.id,host:node.host,path:node.path,hash:node.hash ?? hash(node),hashBasis:node.hash?'indexed file bytes; not re-read':'JSON indexed metadata',observedAt:artifacts.observedAt,stale:artifacts.stale});
    records.sort((a,b)=>b.at.localeCompare(a.at)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
    return {observedAt:new Date(this.engine.clock()).toISOString(),scopeId:this.engine.workspace.index.profile.id,items:records.slice(0,limit),
      coverage:{artifactDropAvailable:drops!==null,matchingObserved:records.length,truncated:records.length>limit||roomTruncated||work.coverage.truncated||work.items.some(row=>row.resultsTruncated)||decisions.truncated||artifacts.total>50||drops?.truncated===true,
        bounds:{rooms:200,messagesPerRoom:1000,workItems:200,resultsPerWork:20,decisions:200,artifacts:50,artifactDrops:200,returned:limit}},
      modelCalls:0,authority:'Read-only digest of permitted persisted evidence. No acceptance, owner approval, execution or file freshness is inferred.'};
  }
}
