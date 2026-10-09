import { CodexReadAdapter } from './native.mjs';
import { ClaudeReadAdapter } from './claude-adapter.mjs';
import { CodexQueueAdapter } from './codex-queue.mjs';

// New remote chats may exist only in the owning daemon's live catalog. Reuse
// its transport for metadata; this wrapper never binds/resumes a controller.
export function codexMetadataAdapter(host, { daemonFactory = options => new CodexQueueAdapter(options), timeoutMs = 8000 } = {}) {
  if (host !== 'remote') return new CodexReadAdapter({ host });
  const adapter = daemonFactory({ host });
  return {
    async open() {
      let timer;
      try { await Promise.race([adapter.open(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native metadata connection unavailable')), timeoutMs); })]); }
      catch (error) { adapter.close(); throw error; }
      finally { clearTimeout(timer); }
    },
    rpc(method, params) {
      if (!['thread/list', 'thread/read'].includes(method) || method === 'thread/read' && params?.includeTurns !== false) throw new Error('Native metadata adapter refuses content or execution');
      return adapter.request(method, params);
    },
    close: () => adapter.close(),
  };
}

// Metadata observation only. A hook's shared session-tree ID never substitutes
// for an exact Codex thread ID; an ambiguous tree remains unbound.
export async function resolveNativeSourceMetadata(input, { codexFactory = codexMetadataAdapter, claudeFactory = host => new ClaudeReadAdapter({ host }) } = {}) {
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
