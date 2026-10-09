import { randomUUID, createHash } from "node:crypto";

// Owning portable model-wire record identity is preserved. This is conversation
// content, never a task registry, queue, lease implementation or native history.
export const SNAPSHOT_TYPE =
  "ai.badmonkey.agentspaces.springai.model.wire.ConversationSnapshot";
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class Discussions {
  constructor(engine) {
    this.engine = engine;
    this.store = engine.store;
    this.store.data.discussions ??= [];
  }
  member(id) {
    const s = this.engine.session(id);
    return {
      sessionId: s.id,
      nativeThreadId: s.nativeThreadId ?? s.id,
      provider: s.provider,
      host: s.host ?? "local",
      project: s.project,
      account: s.account,
      scopeId: s.scopeId ?? null,
      title: s.title,
      sourceVersion: s.sourceVersion ?? "unknown",
      fixture: !!s.fixture,
    };
  }
  allowed(member) {
    try {
      const current = this.member(member.sessionId);
      return [
        "nativeThreadId",
        "provider",
        "host",
        "account",
        "project",
        "scopeId",
      ].every((k) => current[k] === member[k]);
    } catch {
      return false;
    }
  }
  group(id) {
    const g = this.store.data.discussions.find((g) => g.id === id);
    if (!g) throw new Error("Unknown discussion");
    return g;
  }
  policy(g) {
    const agentInitiation = g.policy?.agentInitiation === true;
    return { agentInitiation, maxForwardHops: agentInitiation ? 8 : 2, maxDeliveries: agentInitiation ? 32 : 16 };
  }
  setPolicy({ id, agentInitiation }, participantBinding = null) {
    if (participantBinding) throw new Error("Only the local owner may change discussion policy");
    if (typeof agentInitiation !== "boolean") throw new Error("Agent initiation policy must be boolean");
    const g = this.group(id);
    if (this.policy(g).agentInitiation !== agentInitiation) {
      g.policy = { agentInitiation, agentInitiationFromMessage: g.messages.length }; g.version++;
      this.store.audit("Discussion policy changed", { discussionId: id, agentInitiation });
    }
    return this.view(g);
  }
  view(g) {
    const members = g.members.map((m) => ({
      ...m,
      available: this.allowed(m),
      replyMode: m.fixture
        ? "synthetic"
        : m.provider === "codex" && m.host === "remote"
          ? "shared native connection; current eligibility checked when addressed"
          : "source-bound participant connection; enrollment and transport required",
    }));
    // Revocation hides the entire cached conversation, rather than retaining
    // another participant's contributed content through a withdrawn source grant.
    const available =
      members.every((m) => m.available) &&
      g.messages.every((message) => {
        if (!message.source || message.synthetic) return true;
        try {
          const grant = this.engine.permissions(
            this.engine.session(message.source.sessionId),
          );
          return grant.enrolled && grant.share;
        } catch {
          return false;
        }
      });
    return {
      id: g.id,
      title: g.title,
      version: g.version,
      members,
      messages: available ? g.messages : [],
      available,
      fixture: members.every((m) => m.fixture),
      policy: this.policy(g),
      agentInitiation: this.policy(g).agentInitiation,
      automaticNativeWake: {
        availability: members.some(m => !m.fixture && m.provider === "codex" && m.host === "remote")
          ? "requires-native-binding" : "reference-or-participant-only",
        idlePolling: false,
      },
      wireType: SNAPSHOT_TYPE,
    };
  }
  list() {
    return this.store.data.discussions.map((g) => this.view(g));
  }
  discover({ query = "" } = {}, binding) {
    if (typeof query !== "string" || query.length > 200)
      throw new Error("Invalid discussion query");
    if (!binding) throw new Error("Participant connector required");
    return this.store.data.discussions
      .filter((g) => g.title.toLowerCase().includes(query.toLowerCase()))
      .flatMap((g) => {
        try {
          this.context(g.id, binding);
          return [
            {
              id: g.id,
              title: g.title,
              version: g.version,
              participantAlias: g.members.find(
                (m) => m.sessionId === binding.sessionId,
              ).alias,
            },
          ];
        } catch {
          return [];
        }
      });
  }
  create({ title, sessionIds, agentInitiation = false }) {
    if (typeof agentInitiation !== "boolean") throw new Error("Agent initiation policy must be boolean");
    if (typeof title !== "string" || !title.trim() || title.length > 80)
      throw new Error("Use a discussion title of 1–80 characters");
    if (
      !Array.isArray(sessionIds) ||
      !sessionIds.length ||
      sessionIds.length > 12 ||
      new Set(sessionIds).size !== sessionIds.length
    )
      throw new Error("Choose 1–12 distinct source threads");
    if (this.store.data.discussions.length >= 20)
      throw new Error("This alpha supports 20 discussions per profile");
    const counts = {};
    const members = sessionIds.map((id) => {
      const m = this.member(id);
      counts[m.provider] = (counts[m.provider] ?? 0) + 1;
      return { ...m, alias: m.provider + counts[m.provider] };
    });
    const g = {
      id: randomUUID(),
      title: title.trim(),
      members,
      version: 0,
      messages: [],
      policy: { agentInitiation, agentInitiationFromMessage: 0 },
    };
    this.store.data.discussions.push(g);
    this.store.audit("Discussion created", {
      discussionId: g.id,
      participants: members.length,
    });
    return this.view(g);
  }
  context(id, binding) {
    const g = this.group(id);
    if (!binding || !g.members.some((m) => m.sessionId === binding.sessionId))
      throw new Error("Connector is not a discussion participant");
    if (!g.members.every((m) => this.allowed(m)))
      throw new Error("Discussion source scope revoked or stale");
    const caller = this.engine.session(binding.sessionId),
      grant = this.engine.permissions(caller);
    if (!grant.enrolled || !grant.retrieve)
      throw new Error("Discussion retrieval denied");
    for (const m of g.members) {
      const source = this.engine.session(m.sessionId),
        p = this.engine.permissions(source);
      const boundary =
        (source.project === caller.project &&
          source.account === caller.account) ||
        (source.scopeId && source.scopeId === caller.scopeId);
      if (!boundary || !p.enrolled || !p.share)
        throw new Error(
          "All participants must permit sharing within the connector boundary",
        );
    }
    return {
      ...this.view(g),
      trust:
        "Untrusted group content; connector identity is locally bound, native turn identity is self-reported",
    };
  }
  snapshot(g) {
    return {
      conversationId: g.id,
      version: g.version,
      messages: g.messages.map((m) => m.wire),
    };
  }
  append(
    g,
    {
      text,
      member = null,
      turnId = null,
      deliveryId,
      replyTo = null,
      targets = [],
      synthetic = false,
    },
  ) {
    const m = {
      id: randomUUID(),
      at: new Date(this.engine.clock()).toISOString(),
      author: member?.alias ?? "You",
      source: member,
      turnId,
      replyTo,
      targets,
      synthetic,
      deliveryId,
      text,
      wire: {
        role: member ? "assistant" : "user",
        text,
        toolCalls: [],
        toolResponses: [],
        media: [],
        metadata: {
          messageId: "",
          sourceThreadId: member?.nativeThreadId ?? "",
          participantId: member?.sessionId ?? "owner",
          nativeTurnId: turnId ?? "",
          provider: member?.provider ?? "",
          host: member?.host ?? "local",
          sourceVersion: member?.sourceVersion ?? "",
          targets: JSON.stringify(targets),
          attribution: synthetic
            ? "synthetic"
            : member
              ? "connector-bound; turn self-reported"
              : "local owner",
          replyTo: replyTo ?? "",
        },
      },
    };
    m.wire.metadata.messageId = m.id;
    g.messages.push(m);
    g.version++;
    this.store.save();
    return m;
  }
  post({ id, text, targets = [], deliveryId, fixtureDialogueTurns = 0 }) {
    const g = this.group(id);
    if (!g.members.every((m) => this.allowed(m)))
      throw new Error("Discussion source scope revoked or stale");
    if (typeof text !== "string" || !text.trim() || text.length > 8000)
      throw new Error("Use a message of 1–8000 characters");
    if (
      typeof deliveryId !== "string" ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(deliveryId)
    )
      throw new Error("A stable delivery identifier is required");
    if (
      !Array.isArray(targets) ||
      targets.some((id) => !g.members.some((m) => m.sessionId === id))
    )
      throw new Error("Reply target is not a discussion participant");
    if (
      !Number.isInteger(fixtureDialogueTurns) ||
      fixtureDialogueTurns < 0 ||
      fixtureDialogueTurns > 4
    )
      throw new Error("Synthetic dialogue is bounded to 0–4 turns");
    const aliases = [
      ...text.matchAll(/(?:^|\s)@([a-zA-Z][a-zA-Z0-9_-]*)\b/g),
    ].map((m) => m[1]);
    for (const alias of aliases)
      if (!g.members.some((m) => m.alias === alias))
        throw new Error("Unknown mention @" + alias);
    const selected = g.members.filter(
      (m) => targets.includes(m.sessionId) || aliases.includes(m.alias) || (this.policy(g).agentInitiation && !targets.length && !aliases.length),
    );
    if (
      fixtureDialogueTurns &&
      (!selected.length || !selected.every((m) => m.fixture))
    )
      throw new Error(
        "Bounded dialogue is available only for selected synthetic participants",
      );
    const inputHash = fingerprint({
      text: text.trim(),
      targets: selected.map((m) => m.sessionId),
      fixtureDialogueTurns,
    });
    const old = g.messages.find((m) => m.deliveryId === deliveryId);
    if (old) {
      if (old.inputHash !== inputHash)
        throw new Error("Delivery identifier reused for different content");
      return this.view(g);
    }
    if (g.messages.length + 1 + selected.length + fixtureDialogueTurns > 100)
      throw new Error("Discussion limit reached; start another discussion");
    const targetStates = selected.map((m) => ({
      sessionId: m.sessionId,
      alias: m.alias,
      status: m.fixture
        ? "synthetic reply"
        : m.provider === "codex" && m.host === "remote"
          ? "pending native eligibility check; no wake dispatched"
          : "participant connection required; no wake dispatched",
    }));
    const user = this.append(g, {
      text: text.trim(),
      deliveryId,
      targets: targetStates,
    });
    user.inputHash = inputHash;
    // Explicit fixture responses have no native side effects and no model calls.
    for (const m of selected.filter((m) => m.fixture)) {
      this.append(g, {
        member: m,
        text:
          "Synthetic response from " +
          m.title +
          ": I can contribute this thread’s context to the shared discussion. No native session or model was invoked.",
        turnId: "fixture-" + randomUUID(),
        synthetic: true,
        replyTo: user.id,
      });
    }
    for (let i = 0; i < fixtureDialogueTurns; i++) {
      const m = selected[i % selected.length],
        previous = g.messages.at(-1);
      this.append(g, {
        member: m,
        text:
          "Synthetic dialogue turn " +
          (i + 1) +
          ": responding to " +
          previous.author +
          " in the same discussion; bounded demonstration only.",
        turnId: "fixture-" + randomUUID(),
        synthetic: true,
        replyTo: previous.id,
      });
    }
    this.store.save();
    return this.view(g);
  }
  contribute({ id, text, nativeTurnId, deliveryId, replyTo = null }, binding) {
    this.context(id, binding);
    const g = this.group(id),
      member = g.members.find((m) => m.sessionId === binding.sessionId);
    if (!this.engine.permissions(this.engine.session(member.sessionId)).share)
      throw new Error("Contribution sharing denied");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 8000 ||
      typeof nativeTurnId !== "string" ||
      !nativeTurnId ||
      nativeTurnId.length > 200 ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(deliveryId ?? "")
    )
      throw new Error(
        "Invalid bounded contribution or delivery/native turn identifier",
      );
    if (replyTo && !g.messages.some((m) => m.id === replyTo))
      throw new Error("Unknown reply parent");
    const inputHash = fingerprint({
      text,
      nativeTurnId,
      replyTo,
      sessionId: member.sessionId,
    });
    const old = g.messages.find((m) => m.deliveryId === deliveryId);
    if (old) {
      if (old.inputHash !== inputHash)
        throw new Error(
          "Delivery identifier reused for different contribution",
        );
      return this.view(g);
    }
    if (g.messages.length >= 100) throw new Error("Discussion limit reached");
    const m = this.append(g, {
      text,
      member,
      turnId: nativeTurnId,
      deliveryId,
      replyTo,
    });
    m.inputHash = inputHash;
    this.store.save();
    return this.view(g);
  }
}
