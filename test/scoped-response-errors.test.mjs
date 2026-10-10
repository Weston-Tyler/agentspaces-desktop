import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runParticipantCli } from '../app/participant-cli.mjs';
import { scopedRequest } from '../app/native-session-hook.mjs';

const source = '00000000-0000-4000-8000-000000000001';
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'scoped-response-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {schema:1,address:`http://127.0.0.1:${server.address().port}`,authority:`127.0.0.1:${server.address().port}`,token:'a'.repeat(64),nativeThreadId:source,sessionId:`claude@remote:${source}`,provider:'claude',host:'remote'};
  const path = join(root, 'participant.json');
  await writeFile(path, JSON.stringify(config), {mode:0o600});
  return {
    cli: options => runParticipantCli(['--config',path,'--source',source,'discover'], options),
    native: () => scopedRequest({...config,requestTimeoutMs:500}, '/api/discussions/discover', {}),
  };
}
for (const route of ['cli', 'native']) {
  test(`${route}: oversized HTTP response reports the size limit instead of a transport outage`, async t => {
    const f = await fixture(t, (_req,res) => res.end(JSON.stringify({text:'x'.repeat(1048576)})));
    await assert.rejects(f[route](), {code:'response_limit_exceeded'});
  });
  test(`${route}: response preserves UTF-8 split across HTTP chunks`, async t => {
    const expected = {text:'hello 🐒 café 日本語'};
    const bytes = Buffer.from(JSON.stringify(expected));
    const split = bytes.indexOf(Buffer.from('🐒')) + 1;
    const f = await fixture(t, async (_req,res) => {
      res.writeHead(200, {'content-type':'application/json'});
      res.write(bytes.subarray(0, split));
      await delay(30);
      res.end(bytes.subarray(split));
    });
    const actual = await f[route]();
    assert.deepEqual(route === 'cli' ? actual.result : actual, expected);
  });
  test(`${route}: stalled HTTP response reports a bounded timeout`, async t => {
    const f = await fixture(t, (_req,res) => { res.writeHead(200); res.flushHeaders(); });
    await assert.rejects(f[route]({requestTimeoutMs:500}), {code:'scoped_transport_timeout'});
  });
  test(`${route}: broken HTTP response gives a sanitized transport failure`, async t => {
    const f = await fixture(t, (_req,res) => res.destroy(new Error('PRIVATE diagnostic')));
    await assert.rejects(f[route](), {code:route === 'cli' ? 'scoped_transport_failed' : 'scoped_transport_unavailable'});
  });
}
test('CLI preserves only allowlisted transport error codes, never arbitrary diagnostics', async t => {
  const f = await fixture(t, (_req,res) => res.end('{}'));
  for (const code of ['response_limit_exceeded','scoped_transport_timeout']) {
    await assert.rejects(f.cli({requestImpl:async()=>{throw Object.assign(new Error('PRIVATE'), {code});}}), {code,message:code});
  }
  await assert.rejects(f.cli({requestImpl:async()=>{throw Object.assign(new Error('PRIVATE'), {code:'PRIVATE'});}}), {code:'scoped_transport_failed',message:'scoped_transport_failed'});
});

for (const route of ['cli', 'native']) {
  test(`${route}: pagination errors preserve only public codes`, async t => {
    let code = 'discussion_cursor_stale';
    const f = await fixture(t, (_req,res) => {
      res.writeHead(400);
      res.end(JSON.stringify({code,privateDiagnostic:'PRIVATE value'}));
    });
    for (code of ['discussion_page_invalid','discussion_cursor_invalid','discussion_cursor_stale','discussion_page_record_too_large']) {
      await assert.rejects(f[route](), {code,message:code});
    }
    code = 'PRIVATE';
    const expected = route === 'cli' ? 'scoped_request_refused' : 'scoped_registration_or_tool_denied';
    await assert.rejects(f[route](), {code:expected,message:expected});
  });
  test(`${route}: total timeout bounds a response that keeps trickling bytes`, async t => {
    const f = await fixture(t, (_req,res) => {
      res.writeHead(200);
      res.write('{"text":"');
      const timer = setInterval(() => res.write('x'), 50);
      res.once('close', () => clearInterval(timer));
    });
    await assert.rejects(f[route]({requestTimeoutMs:500}), {code:'scoped_transport_timeout'});
  });
}
