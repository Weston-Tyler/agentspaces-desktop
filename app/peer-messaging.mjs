import { createHash } from "node:crypto";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
const pendingByEngine = new WeakMap();
const canonical = source => source && !source.fixture && ["codex", "claude"].includes(source.provider)
  && ["local", "remote"].includes(source.host) && UUID.test(source.nativeThreadId ?? "")
  && source.id === source.provider + "@" + source.host + ":" + source.nativeThreadId;

export class PeerMessaging {
  constructor(engine, { resolveTarget } = {}) {
    if (!engine?.discussions || !engine?.store || resolveTarget !== undefined && typeof resolveTarget !== "function") throw fail("invalid_peer_messaging_configuration");
    Object.assign(this, { engine, resolveTarget });
    // Private effect receipts protect group/post identity across crashes. They
    // carry no work claims, scheduler state, message text or credentials.
    engine.store.data.peerMessageReceipts ??= {};
    if (!pendingByEngine.has(engine)) pendingByEngine.set(engine, new Map());
    this.pending = pendingByEngine.get(engine);
  }
  validate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["sessionId", "nativeThreadId", "host", "provider", "text", "nativeTurnId", "deliveryId", "title"].includes(key))
      || (input.sessionId !== undefined) === (input.nativeThreadId !== undefined)
      || input.sessionId !== undefined && (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 300)
      || input.nativeThreadId !== undefined && !UUID.test(input.nativeThreadId ?? "")
      || input.host !== undefined && !["local", "remote"].includes(input.host)
      || input.provider !== undefined && !["codex", "claude"].includes(input.provider)
      || typeof input.text !== "string" || !input.text.trim() || input.text.length > 8000
      || typeof input.nativeTurnId !== "string" || !input.nativeTurnId || input.nativeTurnId.length > 200
      || !/^[a-zA-Z0-9-]{8,100}$/.test(input.deliveryId ?? "")
      || input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 80)) throw fail("bounded_peer_message_required");
    return { ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : { nativeThreadId: input.nativeThreadId.toLowerCase() }),
      ...(input.host !== undefined ? { host: input.host } : {}), ...(input.provider !== undefined ? { provider: input.provider } : {}),
      text: input.text, nativeTurnId: input.nativeTurnId, deliveryId: input.deliveryId,
      title: input.title?.trim() ?? "Peer conversation" };
  }
  targetAllowed(target, caller) {
    if (!canonical(target) || target.id === caller.id) throw fail("eligible_native_peer_required");
    this.engine.discussions.sharingBoundary(caller, [target.id]);
    return target;
  }
  async target(input, caller) {
    let target;
    if (input.sessionId !== undefined) target = this.engine.session(input.sessionId);
    else {
      const matches = this.engine.catalog.filter(source => canonical(source)
        && source.nativeThreadId.toLowerCase() === input.nativeThreadId
        && (input.host === undefined || source.host === input.host)
        && (input.provider === undefined || source.provider === input.provider));
      if (matches.length > 1) throw fail("peer_native_identity_ambiguous");
      if (matches.length === 1) target = this.engine.session(matches[0].id);
      else {
        if (!this.resolveTarget) throw fail("peer_target_unavailable");
        const host = input.host ?? caller.host, provider = input.provider ?? caller.provider;
        let observed;
        try { observed = await this.resolveTarget({ nativeThreadId: input.nativeThreadId, host, provider }); }
        catch { throw fail("peer_target_unavailable"); }
        const id = typeof observed === "string" ? observed : observed?.sessionId;
        if (typeof id !== "string") throw fail("peer_target_unavailable");
        target = this.engine.session(id);
        if (target.host !== host || target.provider !== provider) throw fail("peer_target_identity_mismatch");
      }
    }
    if (input.nativeThreadId !== undefined && target.nativeThreadId?.toLowerCase() !== input.nativeThreadId
      || input.host !== undefined && target.host !== input.host
      || input.provider !== undefined && target.provider !== input.provider) throw fail("peer_target_identity_mismatch");
    return this.targetAllowed(target, caller);
  }
  reusable(group, caller, target) {
    const policy = this.engine.discussions.policy(group);
    if (!policy.agentInitiation || !policy.selfRegistration || group.members.length !== 2 || group.messages.length >= 100
      || !group.members.some(member => member.sessionId === caller.id) || !group.members.some(member => member.sessionId === target.id)) return false;
    try { return this.engine.discussions.context(group.id, { sessionId: caller.id }).available === true; }
    catch { return false; }
  }
  async send(input, binding) {
    const request = this.validate(input), caller = this.engine.discussions.participant(binding);
    const key = hash([caller.id, request.deliveryId]), fingerprint = hash({ sourceId: caller.id, request });
    const existing = this.engine.store.data.peerMessageReceipts[key];
    if (existing && (existing.sourceId !== caller.id || existing.fingerprint !== fingerprint)) throw fail("peer_delivery_id_conflict");
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw fail("peer_delivery_id_conflict");
      return pending.operation;
    }
    const operation = this.perform(request, binding, caller, key, fingerprint);
    this.pending.set(key, { fingerprint, operation });
    try { return await operation; }
    finally { if (this.pending.get(key)?.operation === operation) this.pending.delete(key); }
  }
  async perform(request, binding, caller, key, fingerprint) {
    const receipts = this.engine.store.data.peerMessageReceipts;
    let receipt = receipts[key];
    const target = receipt ? this.targetAllowed(this.engine.session(receipt.targetSessionId), caller) : await this.target(request, caller);
    caller = this.engine.discussions.participant(binding); this.targetAllowed(target, caller);
    if (!receipt) {
      if (Object.keys(receipts).length >= 2000) throw fail("peer_message_receipt_limit_reached");
      receipt = receipts[key] = { sourceId: caller.id, deliveryId: request.deliveryId, fingerprint,
        targetSessionId: target.id, groupDeliveryId: "peer-group-" + key, messageDeliveryId: "peer-message-" + key, state: "prepared" };
      this.engine.store.save();
    }
    let group = receipt.discussionId ? this.engine.discussions.group(receipt.discussionId) : null;
    if (!group) {
      const previouslyCreated = this.engine.store.data.discussions.find(item => item.creation?.sessionId === caller.id && item.creation.deliveryId === receipt.groupDeliveryId);
      group = previouslyCreated ?? this.engine.store.data.discussions.find(item => this.reusable(item, caller, target));
      if (!group) {
        const created = this.engine.discussions.createFor({ title: request.title, sessionIds: [target.id], deliveryId: receipt.groupDeliveryId }, binding);
        group = this.engine.discussions.group(created.id); receipt.createdGroup = true;
      } else receipt.createdGroup = !!previouslyCreated;
      receipt.discussionId = group.id; this.engine.store.save();
    }
    const existing = group.messages.find(message => message.deliveryId === receipt.messageDeliveryId);
    this.engine.discussions.context(group.id, binding);
    if (!existing && !this.reusable(group, caller, target)) throw fail("peer_discussion_no_longer_eligible");
    // append() persists the new message before contribute() adds its input hash.
    // The durable receipt and exact fields make that narrow crash recoverable.
    if (existing && !existing.inputHash) {
      if (existing.source?.sessionId !== caller.id || existing.text !== request.text || existing.turnId !== request.nativeTurnId || existing.replyTo !== null) throw fail("peer_delivery_id_conflict");
      existing.inputHash = hash({ text: request.text, nativeTurnId: request.nativeTurnId, replyTo: null, sessionId: caller.id });
      this.engine.store.save();
    }
    this.engine.discussions.contribute({ id: group.id, text: request.text, nativeTurnId: request.nativeTurnId, deliveryId: receipt.messageDeliveryId }, binding);
    const message = group.messages.find(item => item.deliveryId === receipt.messageDeliveryId);
    if (!message.routing) {
      const member = group.members.find(item => item.sessionId === target.id);
      if (!member) throw fail("peer_discussion_no_longer_eligible");
      // Select the peer explicitly. User text and later room membership cannot
      // turn a direct message into an implicit broadcast.
      message.targets = [{ sessionId: target.id, alias: member.alias, status: "pending native eligibility check; no wake dispatched" }];
      message.wire.metadata.targets = JSON.stringify([target.id]);
    }
    receipt.messageId = message.id; receipt.state = "posted"; this.engine.store.save();
    return { discussionId: group.id, messageId: message.id, targetSessionId: target.id,
      createdGroup: !!receipt.createdGroup, duplicate: !!existing };
  }
}
