import { REMOTE_HOST } from "./remote-host.mjs";
import { randomUUID, createHash } from "node:crypto";
import { AgentBroadcast } from "./agent-broadcast.mjs";
import { parseAgentSelectors } from "./agent-selection.mjs";

// Owning portable model-wire record identity is preserved. This is conversation
// content, never a task registry, queue, lease implementation or native history.
export const SNAPSHOT_TYPE =
  "ai.badmonkey.agentspaces.springai.model.wire.ConversationSnapshot";
export const MAX_DISCUSSION_MEMBERS = 200;
// Storage capacity is independent of the per-exchange wake budget.
export const MAX_DISCUSSION_MESSAGES = 10000;
const denied = (code, message) => Object.assign(new Error(message), {code});
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
    return { agentInitiation, selfRegistration: g.policy?.selfRegistration === true, maxForwardHops: agentInitiation ? 8 : 2, maxDeliveries: agentInitiation ? 32 : 16 };
  }
  setPolicy({ id, agentInitiation, selfRegistration }, participantBinding = null) {
    if (participantBinding) throw new Error("Only the local owner may change discussion policy");
    if (agentInitiation === undefined && selfRegistration === undefined || agentInitiation !== undefined && typeof agentInitiation !== "boolean" || selfRegistration !== undefined && typeof selfRegistration !== "boolean") throw new Error("Discussion policy flags must be boolean");
    const g = this.group(id);
    const current = this.policy(g), changes = {};
    if (agentInitiation !== undefined && current.agentInitiation !== agentInitiation) Object.assign(changes, { agentInitiation, agentInitiationFromMessage: g.messages.length });
    if (selfRegistration !== undefined && current.selfRegistration !== selfRegistration) changes.selfRegistration = selfRegistration;
    if (Object.keys(changes).length) {
      g.policy = { ...g.policy, ...changes }; g.version++;
      this.store.audit("Discussion policy changed", { discussionId: id, ...changes });
    }
    return this.view(g);
  }
  view(g) {
    const members = g.members.map((m) => ({
      ...m,
      available: this.allowed(m),
      replyMode: m.fixture
        ? "synthetic"
        : m.provider === "codex" && m.host === REMOTE_HOST
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
      storage: { messageCount: g.messages.length, messageLimit: MAX_DISCUSSION_MESSAGES },
      policy: this.policy(g),
      agentInitiation: this.policy(g).agentInitiation,
      automaticNativeWake: {
        availability: members.some(m => !m.fixture && m.provider === "codex" && m.host === REMOTE_HOST)
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
  participant(binding) {
    if (!binding) throw new Error("Participant connector required");
    const caller = this.engine.session(binding.sessionId), grant = this.engine.permissions(caller);
    if (caller.fixture || !["codex", "claude"].includes(caller.provider) || caller.id !== caller.provider + "@" + caller.host + ":" + caller.nativeThreadId || caller.account !== binding.account || caller.project !== binding.project || (caller.scopeId ?? null) !== (binding.scopeId ?? null) || !grant.enrolled || !grant.retrieve || !grant.share) throw denied("discussion_sharing_denied", "Current enrolled sharing participant required");
    return caller;
  }
  sharingBoundary(caller, ids) {
    for (const id of ids) {
      const source = this.engine.session(id), grant = this.engine.permissions(source);
      if (source.fixture || source.account !== caller.account || !(source.scopeId && source.scopeId === caller.scopeId || source.project === caller.project) || !grant.enrolled || !grant.share || !grant.retrieve) throw denied("discussion_sharing_denied", "Participants must permit sharing within the current account and scope");
    }
  }
  joinEligible(g, caller) {
    if (!this.policy(g).selfRegistration) throw denied('discussion_self_registration_disabled','Discussion self-registration unavailable');
    if (g.members.length >= MAX_DISCUSSION_MEMBERS) throw denied('discussion_member_limit','Discussion member limit reached');
    if (!g.members.every(m => this.allowed(m)) || !this.view(g).available) throw denied('discussion_source_unavailable','Discussion source scope revoked or stale');
    this.sharingBoundary(caller, g.members.map(m => m.sessionId));
  }
  discoverJoinable({ query = "" } = {}, binding) {
    if (typeof query !== "string" || query.length > 200) throw new Error("Invalid discussion query");
    const caller = this.participant(binding);
    return this.store.data.discussions.filter(g => !g.members.some(m => m.sessionId === caller.id) && g.title.toLowerCase().includes(query.toLowerCase())).flatMap(g => {
      try { this.joinEligible(g, caller); return [{ id: g.id, title: g.title, version: g.version }]; } catch { return []; }
    });
  }
  join({ id }, binding) {
    const caller = this.participant(binding), g = this.group(id), existing = g.members.find(m => m.sessionId === caller.id);
    if (existing) {
      this.context(id, binding);
      return { id, title: g.title, version: g.version, participantAlias: existing.alias, sessionId: caller.id, alreadyMember: true };
    }
    this.joinEligible(g, caller);
    return this.admit(g, caller);
  }
  contextOrJoin(id, binding) {
    const g = this.group(id);
    if (binding && !g.members.some(member => member.sessionId === binding.sessionId) && this.policy(g).selfRegistration) this.join({ id }, binding);
    return this.context(id, binding);
  }
  invite({ id, sessionId }, binding) {
    const caller = this.participant(binding), g = this.group(id);
    this.context(id, binding);
    if (!this.policy(g).selfRegistration) throw new Error("Discussion self-registration unavailable");
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 300) throw new Error("Known native source identity required");
    const target = this.engine.session(sessionId);
    if (target.fixture || !["codex", "claude"].includes(target.provider) || target.id !== target.provider + "@" + target.host + ":" + target.nativeThreadId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target.nativeThreadId ?? "")) throw new Error("Known native source identity required");
    this.sharingBoundary(caller, [target.id]);
    const existing = g.members.find(m => m.sessionId === target.id);
    if (existing) return { id, title: g.title, version: g.version, participantAlias: existing.alias, sessionId: target.id, alreadyMember: true, invitedBy: caller.id };
    this.joinEligible(g, target);
    return this.admit(g, target, caller.id);
  }
  inviteOwner({ id, sessionId }) {
    const group = this.group(id), target = this.engine.session(sessionId), grant = this.engine.permissions(target);
    if (target.fixture || !["codex", "claude"].includes(target.provider) || target.id !== target.provider + "@" + target.host + ":" + target.nativeThreadId || !grant.enrolled || !grant.share || !grant.retrieve) throw new Error("Known enrolled native source required");
    if (group.members.some(member => member.sessionId === sessionId)) return;
    this.joinEligible(group, target); return this.admit(group, target, "owner");
  }
  admit(g, source, invitedBy = null) {
    const member = this.member(source.id);
    let number = 1;
    while (g.members.some(m => m.alias === member.provider + number)) number++;
    member.alias = member.provider + number;
    g.members.push(member); g.version++;
    this.store.audit(invitedBy ? "Participant invited to discussion" : "Participant joined discussion", { discussionId: g.id, sessionId: source.id, ...(invitedBy ? { invitedBy } : {}) });
    return { id: g.id, title: g.title, version: g.version, participantAlias: member.alias, sessionId: source.id, alreadyMember: false, ...(invitedBy ? { invitedBy } : {}) };
  }
  createFor({ title, sessionIds, deliveryId }, binding) {
    const caller = this.participant(binding);
    if (typeof title !== "string" || !title.trim() || title.length > 80 || !Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 11 || sessionIds.some(id => typeof id !== "string" || !id || id.length > 300 || id === caller.id) || new Set(sessionIds).size !== sessionIds.length || !/^[a-zA-Z0-9-]{8,100}$/.test(deliveryId ?? "")) throw new Error("Bounded peers and stable group creation delivery ID required");
    this.sharingBoundary(caller, sessionIds);
    const signature = fingerprint({ title: title.trim(), sessionIds });
    const existing = this.store.data.discussions.find(g => g.creation?.sessionId === caller.id && g.creation.deliveryId === deliveryId);
    if (existing) {
      if (existing.creation.fingerprint !== signature) throw new Error("Group creation delivery ID conflicts with prior request");
      this.context(existing.id, binding); return this.view(existing);
    }
    return this.create({ title, sessionIds: [caller.id, ...sessionIds], agentInitiation: true, selfRegistration: true }, { sessionId: caller.id, deliveryId, fingerprint: signature });
  }
  create({ title, sessionIds, agentInitiation = false, selfRegistration = false }, creation = null) {
    if (typeof agentInitiation !== "boolean") throw new Error("Agent initiation policy must be boolean");
    if (typeof selfRegistration !== "boolean") throw new Error("Self-registration policy must be boolean");
    if (typeof title !== "string" || !title.trim() || title.length > 80)
      throw new Error("Use a discussion title of 1–80 characters");
    if (
      !Array.isArray(sessionIds) ||
      !sessionIds.length ||
      sessionIds.length > MAX_DISCUSSION_MEMBERS ||
      new Set(sessionIds).size !== sessionIds.length
    )
      throw new Error("Choose 1–" + MAX_DISCUSSION_MEMBERS + " distinct source threads");
    if (this.store.data.discussions.length >= 1000)
      throw new Error("This profile supports 1000 discussions; archive completed groups before creating more");
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
      policy: { agentInitiation, selfRegistration, agentInitiationFromMessage: 0 },
      ...(creation ? { creation } : {}),
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
      throw denied("discussion_participant_required", "Connector is not a discussion participant");
    if (!g.members.every((m) => this.allowed(m)))
      throw denied("discussion_source_unavailable", "Discussion source scope revoked or stale");
    const caller = this.engine.session(binding.sessionId),
      grant = this.engine.permissions(caller);
    if (!grant.enrolled || !grant.retrieve)
      throw denied("discussion_retrieval_denied", "Discussion retrieval denied");
    for (const m of g.members) {
      const source = this.engine.session(m.sessionId),
        p = this.engine.permissions(source);
      const boundary =
        (source.project === caller.project &&
          source.account === caller.account) ||
        (source.scopeId && source.scopeId === caller.scopeId);
      if (!boundary || !p.enrolled || !p.share)
        throw denied("discussion_sharing_denied", "All participants must permit sharing within the connector boundary");
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
    if (g.messages.length >= MAX_DISCUSSION_MESSAGES) throw new Error("Discussion storage capacity reached (10000 messages); history retained. This is not the per-exchange wake limit.");
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
  async postAddressed({ id, text, targets = [], deliveryId, fixtureDialogueTurns = 0 }) {
    const parsed = parseAgentSelectors(text);
    if (parsed.directives.length) {
      if (fixtureDialogueTurns) throw new Error("Synthetic dialogue cannot use catalog selectors");
      const group = this.group(id);
      if (!Array.isArray(targets) || targets.some(target => !group.members.some(member => member.sessionId === target))) throw new Error("Reply target is not a discussion participant");
      const broadcast = await new AgentBroadcast(this.engine).sendOwner({ discussionId: id, text, deliveryId, ...(targets.length ? { sessionIds: targets } : {}) });
      return { view: this.view(group), broadcast, batches: broadcast.batches };
    }
    const view = this.post({ id, text, targets, deliveryId, fixtureDialogueTurns }), group = this.group(id);
    const message = group.messages.find(item => item.deliveryId === deliveryId);
    return { view, broadcast: null, batches: [{ discussionId: id, messageId: message.id, targetSessionIds: message.targets.map(target => target.sessionId), createdGroup: false }] };
  }
  post({ id, text, targets = [], deliveryId, fixtureDialogueTurns = 0 }, { exactTargets = false } = {}) {
    const g = this.group(id);
    if (!g.members.every((m) => this.allowed(m)))
      throw denied("discussion_source_unavailable", "Discussion source scope revoked or stale");
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
    for (const alias of exactTargets ? [] : aliases)
      if (!g.members.some((m) => m.alias === alias))
        throw new Error("Unknown mention @" + alias);
    const selected = g.members.filter(
      (m) => targets.includes(m.sessionId) || !exactTargets && (aliases.includes(m.alias) || (this.policy(g).agentInitiation && !targets.length && !aliases.length)),
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
    if (g.messages.length + 1 + selected.filter(member => member.fixture).length + fixtureDialogueTurns > MAX_DISCUSSION_MESSAGES)
      throw new Error("Discussion storage capacity reached (10000 messages); preserve/export history before starting a continuation room. This is not the per-exchange wake limit.");
    const targetStates = selected.map((m) => ({
      sessionId: m.sessionId,
      alias: m.alias,
      status: m.fixture
        ? "synthetic reply"
        : m.provider === "codex" && m.host === REMOTE_HOST
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
    if (g.messages.length >= MAX_DISCUSSION_MESSAGES) throw new Error("Discussion storage capacity reached (10000 messages); preserve/export history before starting a continuation room. This is not the per-exchange wake limit.");
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
