import { CodexReadAdapter } from './native.mjs';
import { ClaudeReadAdapter } from './claude-adapter.mjs';

// Metadata observation only. A hook's shared session-tree ID never substitutes
// for an exact Codex thread ID; an ambiguous tree remains unbound.
export async function resolveNativeSourceMetadata(input, { codexFactory = host => new CodexReadAdapter({ host }), claudeFactory = host => new ClaudeReadAdapter({ host }) } = {}) {
  const { host, provider, nativeThreadId, nativeSessionId, cwd } = input;
  if (!['local', 'remote'].includes(host) || !['codex', 'claude'].includes(provider)) return null;
  const adapter = provider === 'codex' ? codexFactory(host) : claudeFactory(host);
  try {
    await adapter.open();
    if (provider === 'claude') {
      if (!nativeThreadId) return null;
      const info = await adapter.call({ action: 'info', nativeThreadId, project: { metadataGrant: true, allMetadataGrant: true, host } });
      return info?.nativeThreadId === nativeThreadId ? { ...info, host, provider, nativeObserved: true } : null;
    }
    let thread;
    if (nativeThreadId) thread = (await adapter.rpc('thread/read', { threadId: nativeThreadId, includeTurns: false })).thread;
    else if (nativeSessionId) {
      const matches = []; let cursor = null;
      for (let page = 0; page < 32; page++) {
        const result = await adapter.rpc('thread/list', { cursor, limit: 100, archived: false, sortKey: 'updated_at', sortDirection: 'desc' });
        for (const candidate of result.data ?? []) if (candidate.sessionId === nativeSessionId) matches.push(candidate);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      // No preference for the parent or active child: both can share sessionId.
      if (cursor || matches.length !== 1) return null;
      thread = matches[0];
    }
    if (!thread?.id || !thread.cwd || (nativeThreadId && thread.id !== nativeThreadId) || (cwd && thread.cwd !== cwd)) return null;
    return { nativeThreadId: thread.id, nativeSessionId: thread.sessionId, cwd: thread.cwd, title: thread.name || 'Untitled native session', sourceVersion: String(thread.updatedAt ?? ''), host, provider, nativeObserved: true };
  } catch { return null; }
  finally { adapter.close(); }
}
