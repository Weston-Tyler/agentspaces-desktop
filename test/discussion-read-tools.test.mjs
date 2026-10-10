import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createNativeBootstrap } from '../app/native-bootstrap-mcp.mjs';
import { startClaudeChannel } from '../app/claude-channel.mjs';
const id = '00000000-0000-4000-8000-000000000001';
class FixtureSocket extends EventEmitter { terminate() {} }

for (const variant of ['fixed-source', 'native-bootstrap', 'claude-channel']) {
  test(`${variant} discussion read publishes and forwards bounded pagination arguments`, async t => {
    const calls = [], client = new Client({ name: 'synthetic-pagination-client', version: '1' });
    t.after(() => client.close());
    const reply = body => { calls.push(body); return { messages: [], page: { nextCursor: null } }; };
    if (variant === 'fixed-source') {
      const http = createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(reply(JSON.parse(Buffer.concat(chunks).toString()))));
      });
      await new Promise(r => http.listen(0, '127.0.0.1', r));
      t.after(() => new Promise(r => http.close(r)));
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('app/mcp.mjs')], env: { ...process.env, AGENTSPACES_URL: `http://127.0.0.1:${http.address().port}`, AGENTSPACES_CONNECTOR_TOKEN: 'synthetic-test-only' } }));
    } else {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      if (variant === 'native-bootstrap') {
        const root = await mkdtemp(join(tmpdir(), 'as-pagination-tools-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const configPath = join(root, 'device.json');
        await writeFile(configPath, JSON.stringify({ schemaVersion: 1, address: 'http://127.0.0.1:45111', authority: '127.0.0.1:45111', token: 'a'.repeat(64), host: 'local', provider: 'codex' }), { mode: 0o600 });
        const { server } = await createNativeBootstrap({ configPath, requestImpl: async (_, path, body) => path === '/api/native/register' ? { participantConfig: { schema: 1, token: 'b'.repeat(64), nativeThreadId: id, sessionId: 'codex@local:' + id, provider: 'codex', host: 'local' } } : reply(body) });
        t.after(() => server.close());
        await server.connect(serverTransport);
      } else {
        const channel = await startClaudeChannel({ address: 'http://127.0.0.1:45111', token: 'synthetic-test-only', transport: serverTransport, WebSocketClass: FixtureSocket, fetchImpl: async (_, options) => ({ ok: true, json: async () => reply(JSON.parse(options.body)) }) });
        t.after(() => channel.close());
      }
      await client.connect(clientTransport);
    }
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'read_group_discussion');
    assert.equal(tool.inputSchema.properties.limit.minimum, 1);
    assert.equal(tool.inputSchema.properties.limit.maximum, 100);
    assert.equal(tool.inputSchema.properties.cursor.maxLength, 512);
    assert.deepEqual(tool.inputSchema.required, ['id']);
    const call = args => client.callTool({ name: tool.name, arguments: args, _meta: { threadId: id } });
    assert.equal((await call({ id })).isError, undefined);
    assert.deepEqual(calls.at(-1), { id });
    assert.equal((await call({ id, limit: 10, cursor: 'opaque-cursor' })).isError, undefined);
    assert.deepEqual(calls.at(-1), { id, limit: 10, cursor: 'opaque-cursor' });
    const before = calls.length;
    for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '' }, { cursor: 'x'.repeat(513) }]) {
      assert.equal((await call({ id, ...invalid })).isError, true);
    }
    assert.equal(calls.length, before, 'Invalid pagination cannot reach the scoped service');
  });
}
