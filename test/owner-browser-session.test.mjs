import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { OwnerBrowserSession } from '../app/owner-browser-session.mjs';
import { Engine } from '../app/engine.mjs';
import { startServer } from '../app/server.mjs';

test('owner browser session persists across service restarts and expires without renewing an old cookie', t => {
  const root=mkdtempSync(join(tmpdir(),'as-owner-session-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  let now=1000;
  const first=new OwnerBrowserSession(new Store(root),{clock:()=>now,lifetimeMs:1000});
  const token=first.current().token;
  const restored=new OwnerBrowserSession(new Store(root),{clock:()=>now,lifetimeMs:1000});
  assert(restored.valid(token)); assert.match(restored.cookie(),/HttpOnly; SameSite=Strict/);
  now=2001; assert.equal(restored.valid(token),false);
  assert.notEqual(restored.current().token,token); assert.equal(restored.valid('invalid'),false);
});

test('an already open browser retains owner access after the owning HTTP service restarts', async t => {
  const root=mkdtempSync(join(tmpdir(),'as-owner-http-'));
  const engine=()=>new Engine(new Store(root),{diagnostics:()=>({status:'fixture'}),close(){}});
  let app=await startServer({root,port:0,engine:engine()});
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
  const page=await fetch(app.address); const cookie=page.headers.get('set-cookie').split(';')[0];
  await app.close(); app=await startServer({root,port:0,engine:engine()});
  const response=await fetch(app.address+'/api/state',{headers:{Cookie:cookie}});
  assert.equal(response.status,200);
  assert.equal((await fetch(app.address+'/api/state')).status,401);
});
