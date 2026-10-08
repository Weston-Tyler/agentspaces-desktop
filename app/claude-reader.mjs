function normalizeCwd(value) {
  const text = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
  return process.platform === "win32" ? text.toLowerCase() : text;
}
// Only documented read APIs are used. query(), resume and mutation APIs are never called.
export async function readSdk(request, sdk) {
  if (!request.project?.metadataGrant || !request.project.path)
    throw new Error("Explicit project metadata grant required");
  const p = request.project;
  const offset =
    request.cursor === null || request.cursor === undefined
      ? 0
      : Number(request.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid metadata cursor");
  const options = {
    dir: p.path,
    includeWorktrees: false,
    includeProgrammatic: true,
    limit: 50,
    offset,
  };
  if (request.action === "list") {
    if (request.archived)
      throw new Error(
        "Claude SDK metadata does not expose archive state; cannot qualify an archived-only filter",
      );
    const rows = await sdk.listSessions(options);
    return {
      sessions: rows
        .filter((s) => normalizeCwd(s.cwd) === normalizeCwd(p.path))
        .map((s) => ({
          id: s.sessionId,
          nativeThreadId: s.sessionId,
          provider: "claude",
          host: p.host ?? "local",
          account: p.account,
          project: p.id,
          title: String(
            s.customTitle ?? s.summary ?? "Untitled native session",
          ).slice(0, 240),
          surface: "Native CLI / IDE session; surface not inferred",
          status: "unknown",
          updatedAt: new Date(s.lastModified).toISOString(),
          sourceVersion: String(s.lastModified),
          topics: s.tag ? [String(s.tag)] : [],
          fixture: false,
        })),
      nextCursor: rows.length === 50 ? String(offset + 50) : null,
      bounded: true,
      statusQualification:
        "Native current/dormant/archive state is not exposed by this metadata API",
    };
  }
  if (request.action !== "read")
    throw new Error("Read-only helper refuses this action");
  const info = await sdk.getSessionInfo(
    request.session.nativeThreadId ?? request.session.id,
    { dir: p.path },
  );
  if (!info || normalizeCwd(info.cwd) !== normalizeCwd(p.path))
    throw new Error("Native project mismatch");
  const messages = await sdk.getSessionMessages(info.sessionId, {
    dir: p.path,
    limit: 32,
    offset: 0,
    includeSystemMessages: false,
  });
  const text = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => {
      const content = m.message?.content;
      return typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
          : [];
    })
    .join("\n\n")
    .slice(0, 16000);
  return {
    title: request.session.title,
    summary: text.slice(0, 2000),
    artifact: { name: "approved-claude-excerpt.txt", text },
    capturedAt: new Date().toISOString(),
    sourceVersion: String(info.lastModified),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    bounded: true,
    nativeMessagesRead: messages.length,
    selection:
      "First at most 32 native messages; bounded assistant text excerpt, not a complete conversation export",
  };
}
