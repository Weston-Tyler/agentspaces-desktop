import { realpathSync } from 'node:fs';
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
  test(`${variant} fleet observations expose bounded read-only schemas and never forward invalid queries`, async t => {
    const calls = [], client = new Client({ name: 'synthetic-fleet-client', version: '1' });
    t.after(() => client.close());
    const reply = (path,body) => { calls.push({path,body}); return {health:{},usage:{},advisory:{},semantic:{},discovery:{}}; };
    if (variant === 'fixed-source') {
      const http = createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(reply(req.url,JSON.parse(Buffer.concat(chunks).toString()))));
      });
      await new Promise(r => http.listen(0, '127.0.0.1', r));
      t.after(() => new Promise(r => http.close(r)));
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('app/mcp.mjs')], env: { ...process.env, AGENTSPACES_URL: `http://127.0.0.1:${http.address().port}`, AGENTSPACES_CONNECTOR_TOKEN: 'synthetic-test-only' } }));
    } else {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      if (variant === 'native-bootstrap') {
        const root = await mkdtemp(join(realpathSync(tmpdir()), 'as-fleet-tools-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const configPath = join(root, 'device.json');
        await writeFile(configPath, JSON.stringify({ schemaVersion: 1, address: 'http://127.0.0.1:45111', authority: '127.0.0.1:45111', token: 'a'.repeat(64), host: 'local', provider: 'codex' }), { mode: 0o600 });
        const { server } = await createNativeBootstrap({ configPath, requestImpl: async (_, path, body) => path === '/api/native/register' ? { participantConfig: { schema: 1, token: 'b'.repeat(64), nativeThreadId: id, sessionId: 'codex@local:' + id, provider: 'codex', host: 'local' } } : reply(path,body) });
        t.after(() => server.close());
        await server.connect(serverTransport);
      } else {
        const channel = await startClaudeChannel({ address: 'http://127.0.0.1:45111', token: 'synthetic-test-only', transport: serverTransport, WebSocketClass: FixtureSocket, fetchImpl: async (url, options) => ({ ok: true, json: async () => reply(new URL(url).pathname,JSON.parse(options.body)) }) });
        t.after(() => channel.close());
      }
      await client.connect(clientTransport);
    }
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'read_fabric_observations');
    assert.ok(tool, 'Fleet observation tool is exposed');
    assert.equal(tool.annotations.readOnlyHint,true);
    assert.equal(tool.inputSchema.properties.limit.minimum,1);
    assert.equal(tool.inputSchema.properties.limit.maximum,100);
    assert.equal(tool.inputSchema.properties.query.maxLength,500);
    const call=args=>client.callTool({name:tool.name,arguments:args,_meta:{threadId:id}});
    assert.equal((await call({})).isError,undefined);
    assert.deepEqual(calls.at(-1),{path:'/api/fabric/observations',body:{query:'',limit:100}});
    assert.equal((await call({query:'synthetic recipe',limit:5})).isError,undefined);
    assert.deepEqual(calls.at(-1),{path:'/api/fabric/observations',body:{query:'synthetic recipe',limit:5}});
    const before=calls.length;
    for(const invalid of [{query:'x'.repeat(501)},{query:3},{limit:0},{limit:101},{limit:1.5},{connect:true},{space:'private'}])assert.equal((await call(invalid)).isError,true);
    assert.equal(calls.length,before,'Invalid arguments cannot reach the scoped service');
  });
}
