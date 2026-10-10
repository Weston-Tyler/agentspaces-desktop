import { createHash } from "node:crypto";
// Bounded direct room delivery only; no work claims, scheduler or idle models.
export async function routeConversation(engine, { codexAgents, channels }, group, message) {
  if (!message || engine.discussions.group(group.id) !== group || !group.messages.includes(message)) return;
  const policy = engine.discussions.policy(group);
  const permitted = sessionId => {
    try { engine.discussions.context(group.id, { sessionId }); return true; }
    catch { return false; }
  };
  const ancestry = item => {
    let depth = 0, current = item; const visited = new Set();
    while (current?.replyTo) {
      if (visited.has(current.id) || depth++ > 100) return null;
      visited.add(current.id); current = group.messages.find(candidate => candidate.id === current.replyTo);
    }
    if (!current || current.synthetic) return null;
    if (current.source && !policy.agentInitiation) return null;
    return { root: current, depth };
  };
  const blocked = status => {
    message.routing ??= { status, allocated: true };
    message.routing.status = status;
    message.wire.metadata.routingStatus = status;
    for (const target of message.targets ?? []) if (!target.routingAttempted) {
      target.routingAttempted = true; target.status = status;
    }
    engine.store.save();
  };
  const chain = ancestry(message);
  if (!chain) { blocked(message.source && !message.replyTo ? "agent-initiation-disabled" : "invalid-or-unapproved-ancestry"); return; }
  if (chain.root.source && group.messages.indexOf(message) < (group.policy?.agentInitiationFromMessage ?? 0)) {
    blocked("message-predates-room-activation"); return;
  }
  if (message.source && (!permitted(message.source.sessionId) || !permitted(chain.root.source?.sessionId ?? message.source.sessionId))) {
    blocked("participant-access-unavailable"); return;
  }
  if (chain.depth > policy.maxForwardHops) { blocked("forward-hop-limit-reached"); return; }
  // Allocation is durable even when no target is selected. Policy changes and
  // transport reconnects never reinterpret and replay historical messages.
  if (!message.routing) {
    const used = group.messages.filter(item => item !== message && ancestry(item)?.root.id === chain.root.id)
      .reduce((count, item) => count + (item.targets?.length ?? 0), 0);
    const remaining = Math.max(0, policy.maxDeliveries - used);
    const existing = message.targets ?? [];
    let candidates = existing;
    if (message.source && !existing.length) {
      const aliases = [...message.text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)].map(match => match[1]);
      // Status posts remain in the room; waking every peer requires an explicit address.
      const broadcast = aliases.includes("all");
      candidates = group.members.filter(member => member.sessionId !== message.source.sessionId &&
        (broadcast || aliases.includes(member.alias)) && permitted(member.sessionId))
        .map(member => ({ sessionId: member.sessionId, alias: member.alias, status: "connecting-native-agent" }));
    }
    message.targets = candidates.slice(0, remaining);
    message.routing = { rootId: chain.root.id, depth: chain.depth, allocated: true,
      status: candidates.length > remaining ? "target-budget-exhausted" : message.targets.length ? "targets-allocated" : "no-addressed-targets",
      maxForwardHops: policy.maxForwardHops, maxDeliveries: policy.maxDeliveries };
    message.wire.metadata.targets = JSON.stringify(message.targets.map(target => target.sessionId));
    message.wire.metadata.routingStatus = message.routing.status;
    if (message.source && message.targets.length) group.version++;
    engine.store.save();
  }
  for (const target of message.targets) {
    if (target.routingAttempted) continue;
    if (message.source?.sessionId === target.sessionId) continue;
    const requestId = createHash("sha256").update(group.id + message.id + target.sessionId).digest("hex");
    // Adopt old transport receipts without redispatching a legacy message.
    const previous = engine.store.data.codexDiscussionDeliveries?.[requestId] ?? engine.store.data.channelReceipts?.[requestId];
    target.routingAttempted = true; target.requestId = requestId;
    if (previous) { target.status = previous.status; engine.store.save(); continue; }
    target.status = "dispatch-allocated"; engine.store.save();
    try {
      const currentPolicy = engine.discussions.policy(group);
      if ((chain.root.source && (!currentPolicy.agentInitiation || group.messages.indexOf(message) < (group.policy?.agentInitiationFromMessage ?? 0))) || chain.depth > currentPolicy.maxForwardHops) {
        target.status = "room-policy-changed; not dispatched"; engine.store.save(); continue;
      }
      if (!permitted(target.sessionId) || (message.source && !permitted(message.source.sessionId)))
        throw new Error("Room access changed");
      if (chain.root.source && !permitted(chain.root.source.sessionId)) throw new Error("Initiating participant access changed");
      const source = engine.session(target.sessionId);
      if (!source.fixture && source.provider === "codex") target.status = codexAgents.dispatch({ sessionId: source.id,
        discussionId: group.id, messageId: message.id, text: message.text, requestId }).status;
      else if (channels.isConnected(target.sessionId) || channels.canQueue?.(target.sessionId)) target.status = (await channels.deliver({ sessionId: target.sessionId,
        discussionId: group.id, messageId: message.id, text: message.text, requestId })).status;
      else target.status = "participant transport unavailable; not dispatched";
    } catch { target.status = "native agent unavailable or access changed"; }
    engine.store.save();
  }
}
