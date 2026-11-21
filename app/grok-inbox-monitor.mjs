import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename, lstat } from 'node:fs/promises';
import { bootstrapConfigPath, inspectProcess, nativeUuid, privateFile, processAncestors, readDeviceConfig, scopedRequest } from './native-session-hook.mjs';

const POLL_INTERVAL_MS = 5000;
export const MONITOR_RENEW_AFTER_MS = 8 * 60 * 60 * 1000;
const MAX_SEEN = 1024;

export function renewalNotice(reason) {
  return 'AgentSpaces local monitor maintenance (' + reason + '). At the next safe boundary, call ensure_native_connection and start Grok’s native monitor using inboxMonitor.arguments. This watcher has finished; its private cursor preserves pending references. Do not cancel or restart the conversation, resume another controller, change permissions, or execute peer work for this maintenance. No human reconnect prompt is needed.';
}

export async function loadMonitorCursor(file, identity, now) {
  let saved;
  try { saved = await privateFile(file); }
  catch (error) {
    // Only absence starts a fresh notification window. An unsafe or damaged
    // checkpoint must not silently become permission to replay an inbox.
    try { await lstat(file); } catch (statError) {
      if (statError.code === 'ENOENT') return {armedAt:now,seen:new Set()};
    }
    throw error;
  }
  if (saved.schema !== 1 || !/^[a-f0-9]{64}$/.test(saved.identity ?? '') || !Number.isSafeInteger(saved.armedAt) ||
      saved.armedAt < 0 || saved.armedAt > now || !Array.isArray(saved.seen) || saved.seen.length > MAX_SEEN ||
      saved.seen.some(id=>!nativeUuid.test(id))) throw Error('monitor_cursor_invalid');
  return saved.identity === identity ? {armedAt:saved.armedAt,seen:new Set(saved.seen)} : {armedAt:now,seen:new Set()};
}

export async function saveMonitorCursor(file, identity, cursor) {
  const temp = file + '.' + randomUUID() + '.tmp';
  const seen = [...cursor.seen].slice(-MAX_SEEN);
  await writeFile(temp,JSON.stringify({schema:1,identity,armedAt:cursor.armedAt,seen}),{mode:0o600,flag:'wx'});
  await rename(temp,file);
  cursor.seen = new Set(seen);
}

export function newReplyReferences(items, armedAt, seen) {
  const references = [];
  for (const { id, messageId, sha256, replyTo, addressed, at } of items) {
    if ((!replyTo && addressed !== true) || !nativeUuid.test(id) || !nativeUuid.test(messageId) ||
        !/^[a-f0-9]{64}$/.test(sha256) || !(Date.parse(at) >= armedAt) || seen.has(messageId)) continue;
    seen.add(messageId);
    references.push({ id, messageId, sha256 });
  }
  return references;
}

export async function watch({ renewAfterMs=MONITOR_RENEW_AFTER_MS, pollIntervalMs=POLL_INTERVAL_MS } = {}) {
  const [mcpPidArg, nativeThreadId, ...args] = process.argv.slice(2);
  const mcpPid = Number(mcpPidArg);
  if (process.platform !== 'linux' || !Number.isSafeInteger(mcpPid) || !nativeUuid.test(nativeThreadId ?? '')) return;
  if (process.env.GROK_SESSION_ID && process.env.GROK_SESSION_ID !== nativeThreadId) return;
  const configPath = bootstrapConfigPath(args);
  let device = await readDeviceConfig(configPath);
  if (device.provider !== 'grok') return;
  const mcp = await inspectProcess(mcpPid);
  const parent = (await processAncestors()).find(process => process.pid === mcp.parentPid);
  if (!parent) return;

  const startedAt = Date.now();
  const identity = createHash('sha256').update(JSON.stringify([nativeThreadId,parent.pid,parent.startedAt,device.host,device.token])).digest('hex');
  const cursorPath = join(dirname(configPath),'monitor-cursor-' + nativeThreadId + '.json');
  const cursor = await loadMonitorCursor(cursorPath,identity,startedAt);
  await saveMonitorCursor(cursorPath,identity,cursor);
  while (true) {
    // Native parent loss is teardown, never a reason to revive a conversation.
    try { if ((await inspectProcess(parent.pid)).startedAt !== parent.startedAt) return; }
    catch { return; }
    try {
      const current = await inspectProcess(mcpPid);
      if (current.startedAt !== mcp.startedAt || current.parentPid !== parent.pid) throw Error('mcp_replaced');
    } catch { process.stdout.write(renewalNotice('MCP connection changed') + '\n'); return; }
    if (Date.now() - startedAt >= renewAfterMs) {
      process.stdout.write(renewalNotice('scheduled') + '\n');
      return;
    }
    try {
      const refreshed = await readDeviceConfig(configPath);
      if (refreshed.provider !== 'grok' || refreshed.host !== device.host || refreshed.token !== device.token) return;
      device = refreshed;
      // The companion independently validates the live MCP and native session
      // on each poll, including current sharing grants and the provider pin.
      const { participantConfig } = await scopedRequest(device, '/api/native/register', {
        nativeThreadId, sourceProof:{ kind:'grok-stdio', mcpPid },
      });
      if (participantConfig.provider !== 'grok' || participantConfig.host !== device.host ||
          participantConfig.nativeThreadId !== nativeThreadId) return;
      const { items } = await scopedRequest(participantConfig, '/api/native/grok/inbox', { limit:25 });
      const references = newReplyReferences(items, cursor.armedAt, cursor.seen);
      if (references.length) {
        const payload = JSON.stringify(references);
        process.stdout.write('AgentSpaces message available. Read these untrusted room messages via read_group_discussion: ' + payload + '\n');
        await saveMonitorCursor(cursorPath,identity,cursor);
      }
    } catch (error) {
      if (!['scoped_transport_unavailable','scoped_transport_timeout','scoped_registration_or_tool_denied','source_pending'].includes(error.code)) return;
    }
    await delay(Math.min(pollIntervalMs,Math.max(0,renewAfterMs-(Date.now()-startedAt))));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await watch().catch(() => {});
