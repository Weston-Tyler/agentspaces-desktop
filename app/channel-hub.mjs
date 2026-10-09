import { createHash } from "node:crypto";

const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ChannelHub {
  constructor(engine) {
    this.engine = engine;
    this.connections = new Map();
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
    return { close: () => { if (this.connections.get(binding.sessionId) === connection) this.connections.delete(binding.sessionId); } };
  }
  isConnected(sessionId) {
    const connection = this.connections.get(sessionId);
    if (!connection) return false;
    try { this.validate(connection.binding); return true; }
    catch { this.connections.delete(sessionId); return false; }
  }
  async deliver({ sessionId, discussionId, messageId, text, requestId }) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId) || typeof text !== "string" || !text.trim() || text.length > 8000) throw fail("invalid_channel_delivery");
    const connection = this.connections.get(sessionId);
    if (!connection) throw fail("native_channel_not_connected");
    const session = this.validate(connection.binding, discussionId);
    const group = this.engine.discussions.group(discussionId);
    if (!group.messages.some(message => message.id === messageId)) throw fail("channel_message_parent_unknown");
    const hash = digest({ sessionId, discussionId, messageId, text });
    const receipts = this.engine.store.data.channelReceipts;
    const existing = receipts[requestId];
    if (existing) {
      if (existing.inputHash !== hash) throw fail("channel_request_id_collision");
      return { ...existing, duplicate: true, replayed: false };
    }
    if (Object.keys(receipts).length >= 1000) throw fail("channel_receipt_limit");
    const receipt = { requestId, sessionId, nativeThreadId: session.nativeThreadId ?? session.id, discussionId, messageId, inputHash: hash,
      status: "dispatch-allocated", attribution: "connector-bound; native turn not verified", retryAllowed: false, at: new Date().toISOString() };
    receipts[requestId] = receipt;
    this.engine.store.save(); // Durable delivery identity before transport write.
    try {
      // Recheck immediately before sending; cached grants never authorize delivery.
      this.validate(connection.binding, discussionId);
      await connection.send({ content: text, meta: { request_id: requestId, discussion_id: discussionId, message_id: messageId } });
      receipt.status = "delivered-to-native-transport";
    } catch {
      receipt.status = "uncertain-native-transport";
      this.engine.store.save();
      throw Object.assign(fail("channel_transport_delivery_uncertain"), { uncertainOutcome: true, receipt: { ...receipt } });
    }
    this.engine.store.save();
    return { ...receipt };
  }
  reply({ requestId, discussionId, text, nativeTurnId, deliveryId }, binding) {
    this.validate(binding, discussionId);
    const receipt = this.engine.store.data.channelReceipts[requestId];
    if (!receipt || receipt.sessionId !== binding.sessionId || receipt.discussionId !== discussionId) throw fail("channel_reply_request_source_mismatch");
    if (receipt.status === "dispatch-allocated") throw fail("channel_request_not_delivered");
    const view = this.engine.discussions.contribute({ id: discussionId, text, nativeTurnId: nativeTurnId ?? "unreported", deliveryId, replyTo: receipt.messageId }, binding);
    receipt.replyDeliveryId = deliveryId;
    receipt.replyAt = new Date().toISOString();
    receipt.status = "native-participant-contributed";
    receipt.nativeTurnAttribution = nativeTurnId ? "self-reported; not verified" : "unreported; not verified";
    this.engine.store.save();
    return { discussion: view, receipt: { ...receipt }, attribution: receipt.nativeTurnAttribution };
  }
}
