import { createHash } from "node:crypto";
// Bounded conversation delivery only; no work claims, scheduling or idle models.
export async function routeConversation(engine, { codexAgents, channels }, group, message) {
  if (!message) return;
  const ancestry = item => {
    let depth = 0, current = item; const visited = new Set();
    while (current?.replyTo) {
      if (visited.has(current.id) || depth++ > 100) return null;
      visited.add(current.id); current = group.messages.find(candidate => candidate.id === current.replyTo);
    }
    return current && !current.source && !current.synthetic ? { root: current, depth } : null;
  };
  const chain = ancestry(message);
  if (!chain) return;
  if (message.source && !message.targets.length && chain.depth <= 2) {
    const used = group.messages.filter(item => ancestry(item)?.root.id === chain.root.id).reduce((count, item) => count + (item.targets?.length ?? 0), 0);
    const remaining = Math.max(0, 16 - used);
    const aliases = [...message.text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)].map(match => match[1]);
    message.targets = group.members.filter(member => member.sessionId !== message.source.sessionId && aliases.includes(member.alias)).slice(0, remaining).map(member => ({ sessionId: member.sessionId, alias: member.alias, status: "connecting-native-agent" }));
    if (message.targets.length) { message.wire.metadata.targets = JSON.stringify(message.targets.map(target => target.sessionId)); group.version++; engine.store.save(); }
  }
  for (const target of message.targets) {
    const requestId = createHash("sha256").update(group.id + message.id + target.sessionId).digest("hex");
    try {
      const source = engine.session(target.sessionId);
      if (!source.fixture && source.provider === "codex") target.status = codexAgents.dispatch({ sessionId: source.id, discussionId: group.id, messageId: message.id, text: message.text, requestId }).status;
      else if (channels.isConnected(target.sessionId)) target.status = (await channels.deliver({ sessionId: target.sessionId, discussionId: group.id, messageId: message.id, text: message.text, requestId })).status;
    } catch { target.status = "native agent unavailable or access changed"; }
  }
  engine.store.save();
}
