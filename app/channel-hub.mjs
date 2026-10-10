import { createHash } from "node:crypto";

const fail = code => Object.assign(new Error(code), { code });
const boundary = session => ({ account: session.account, project: session.project, scopeId: session.scopeId ?? null, host: session.host ?? "local" });
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ChannelHub {
  constructor(engine) {
    this.engine = engine;
    this.connections = new Map(); this.flushing = new Map();
    engine.store.data.channelTransports ??= {};
    engine.store.data.channelReceipts ??= {};
  }
  validate(binding, discussionId) {
    if (!binding || !Object.values(this.engine.store.data.connectors).some(item => item === binding)) throw fail("channel_connector_revoked");
    const session = this.engine.session(binding.sessionId), grant = this.engine.permissions(session);
    if (session.provider !== "claude" || session.project !== binding.project || session.account !== binding.account || (session.scopeId ?? null) !== (binding.scopeId ?? null)) throw fail("channel_binding_stale");
    if (!grant.enrolled || !grant.retrieve || !grant.share) throw fail("channel_participation_grant_denied");
    if (discussionId) this.engine.discussions.context(discussionId, binding);
    return session;
  }
  connect(binding, send) {
    this.validate(binding);
    if (typeof send !== "function") throw fail("channel_transport_required");
    const connection = { binding, send };
    this.connections.set(binding.sessionId, connection);
    // Retain only a reference to an already admitted connector, never its token.
    const connectorKey = Object.entries(this.engine.store.data.connectors).find(([, value]) => value === binding)?.[0];
    this.engine.store.data.channelTransports[binding.sessionId] = { connectorKey };
    this.engine.store.save();
    void this.flush(binding.sessionId).catch(() => {});
    return { close: () => { if (this.connections.get(binding.sessionId) === connection) this.connections.delete(binding.sessionId); } };
  }
  isConnected(sessionId) {
    const connection = this.connections.get(sessionId);
    if (!connection) return false;
    try { this.validate(connection.binding); return true; }
    catch { this.connections.delete(sessionId); return false; }
  }
  knownBinding(sessionId) {
    const key = this.engine.store.data.channelTransports[sessionId]?.connectorKey;
    const binding = this.engine.store.data.connectors[key];
    if (!binding || binding.sessionId !== sessionId) throw fail('native_channel_not_connected');
    this.validate(binding); return binding;
  }
  canQueue(sessionId) {
    try { this.knownBinding(sessionId); return true; } catch { return false; }
  }
  health() {
    const receipts = Object.values(this.engine.store.data.channelReceipts);
    return { connected: [...this.connections.keys()].filter(id => this.isConnected(id)).length,
      waiting: receipts.filter(receipt => receipt.status === 'waiting-for-native-transport').length,
      uncertain: receipts.filter(receipt => ['dispatch-allocated', 'uncertain-native-transport'].includes(receipt.status)).length };
  }
  message(receipt, binding) {
    this.validate(binding, receipt.discussionId);
    const group = this.engine.discussions.group(receipt.discussionId);
    const message = group.messages.find(item => item.id === receipt.messageId);
    if (!message) throw fail('channel_message_parent_unknown');
    let root = message, depth = 0; const seen = new Set();
    while (root) {
      if (root.source) this.engine.discussions.context(group.id, { sessionId: root.source.sessionId });
      if (!root.replyTo) break;
      if (seen.has(root.id) || depth++ > 100) throw fail('channel_message_ancestry_invalid');
      seen.add(root.id); root = group.messages.find(item => item.id === root.replyTo);
    }
    const policy = this.engine.discussions.policy(group);
    if (!root || root.synthetic || depth > policy.maxForwardHops || (root.source && (!policy.agentInitiation || group.messages.indexOf(message) < (group.policy?.agentInitiationFromMessage ?? 0)))) throw fail('channel_room_policy_changed');
    return message;
  }
  update(receipt, status) {
    receipt.status = status;
    const message = this.engine.discussions.group(receipt.discussionId).messages.find(item => item.id === receipt.messageId);
    const target = message?.targets?.find(item => item.sessionId === receipt.sessionId);
    if (target) target.status = status;
    this.engine.store.save();
  }
  async deliver({ sessionId, discussionId, messageId, text, requestId }) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId) || typeof text !== "string" || !text.trim() || text.length > 8000) throw fail("invalid_channel_delivery");
    const binding = this.connections.get(sessionId)?.binding ?? this.knownBinding(sessionId);
    const session = this.validate(binding, discussionId);
    const hash = digest({ sessionId, discussionId, messageId, text });
    const receipts = this.engine.store.data.channelReceipts, existing = receipts[requestId];
    if (existing) {
      if (existing.inputHash !== hash) throw fail("channel_request_id_collision");
      return { ...existing, duplicate: true, replayed: false };
    }
    const receipt = { requestId, sessionId, nativeThreadId: session.nativeThreadId ?? session.id, discussionId, messageId, inputHash: hash, boundary: boundary(session),
      status: "waiting-for-native-transport", attribution: "connector-bound; native turn not verified", retryAllowed: false, at: new Date().toISOString() };
    const message = this.message(receipt, binding);
    // The room already owns the text. Reconnect may only recover that exact
    // persisted message, not an unrecorded or subsequently edited payload.
    if (message.text !== text) throw fail('channel_message_content_mismatch');
    if (Object.keys(receipts).length >= 1000) throw fail("channel_receipt_limit");
    receipts[requestId] = receipt; this.engine.store.save();
    if (this.connections.has(sessionId)) await this.sendPending(receipt);
    return { ...receipt };
  }
  async sendPending(receipt) {
    // Change this durable state before calling transport, including a transport
    // that throws synchronously. Never retry an allocated/uncertain send.
    if (receipt.status !== 'waiting-for-native-transport') return;
    const connection = this.connections.get(receipt.sessionId); if (!connection) return;
    let message;
    try {
      message = this.message(receipt, connection.binding);
      const session = this.validate(connection.binding, receipt.discussionId);
      if (digest(boundary(session)) !== digest(receipt.boundary) || (session.nativeThreadId ?? session.id) !== receipt.nativeThreadId || receipt.inputHash !== digest({ sessionId: receipt.sessionId, discussionId: receipt.discussionId, messageId: receipt.messageId, text: message.text })) throw fail('channel_message_content_mismatch');
    } catch { this.update(receipt, 'channel-access-changed; not dispatched'); return; }
    this.update(receipt, 'dispatch-allocated');
    try {
      await connection.send({ content: message.text, meta: { request_id: receipt.requestId, discussion_id: receipt.discussionId, message_id: receipt.messageId } });
      this.update(receipt, 'delivered-to-native-transport');
    } catch {
      this.update(receipt, 'uncertain-native-transport');
      throw Object.assign(fail('channel_transport_delivery_uncertain'), { uncertainOutcome: true, receipt: { ...receipt } });
    }
  }
  flush(sessionId) {
    if (this.flushing.has(sessionId)) return this.flushing.get(sessionId).then(() => this.flush(sessionId));
    const run = Promise.resolve().then(async () => {
      for (const receipt of Object.values(this.engine.store.data.channelReceipts)) {
        if (receipt.sessionId !== sessionId || receipt.status !== 'waiting-for-native-transport') continue;
        try { await this.sendPending(receipt); } catch { break; }
      }
    }).finally(() => this.flushing.delete(sessionId));
    this.flushing.set(sessionId, run); return run;
  }
  reply({ requestId, discussionId, text, nativeTurnId, deliveryId }, binding) {
    this.validate(binding, discussionId);
    const receipt = this.engine.store.data.channelReceipts[requestId];
    if (!receipt || receipt.sessionId !== binding.sessionId || receipt.discussionId !== discussionId) throw fail("channel_reply_request_source_mismatch");
    if (["dispatch-allocated", "waiting-for-native-transport", "channel-access-changed; not dispatched"].includes(receipt.status)) throw fail("channel_request_not_delivered");
    const view = this.engine.discussions.contribute({ id: discussionId, text, nativeTurnId: nativeTurnId ?? "unreported", deliveryId, replyTo: receipt.messageId }, binding);
    receipt.replyDeliveryId = deliveryId;
    receipt.replyAt = new Date().toISOString();
    receipt.status = "native-participant-contributed";
    receipt.nativeTurnAttribution = nativeTurnId ? "self-reported; not verified" : "unreported; not verified";
    this.engine.store.save();
    return { discussion: view, receipt: { ...receipt }, attribution: receipt.nativeTurnAttribution };
  }
}
