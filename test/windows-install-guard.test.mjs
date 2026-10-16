import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const ready=child=>new Promise((resolve,reject)=>{
 const finish=error=>{clearTimeout(timer);child.off('error',failed);child.off('exit',exited);child.stdout.off('data',received);error?reject(error):resolve();};
 const failed=error=>finish(error),exited=code=>finish(new Error('Synthetic fixture exited before readiness: '+code)),received=()=>finish();
 const timer=setTimeout(()=>finish(new Error('Synthetic fixture readiness timed out')),10000);
 child.once('error',failed);child.once('exit',exited);child.stdout.once('data',received);
});
test('Windows setup refuses a live bundled companion without terminating it', {skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),"as-installer's guard-"));let child;
 const stop=async()=>{
  const current=child;child=undefined;
  // A signal-terminated child keeps a null exitCode after its exit event.
  if(!current?.pid||current.exitCode!==null||current.signalCode!==null)return;
  await new Promise((resolve,reject)=>{
   const finish=error=>{clearTimeout(timer);current.off('exit',exited);error?reject(error):resolve();};
   const exited=()=>finish(),timer=setTimeout(()=>finish(new Error('Synthetic fixture cleanup timed out')),10000);
   current.once('exit',exited);if(!current.kill())finish(new Error('Synthetic fixture could not be stopped'));
  });
 };
 t.after(async()=>{await stop();rmSync(root,{recursive:true,force:true});});
 const runtime=join(root,'resources','runtime');mkdirSync(runtime,{recursive:true});
 const binary=join(runtime,'node.exe');copyFileSync(process.execPath,binary);
 const shell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const script=fileURLToPath(new URL('../assets/windows-install-guard.ps1',import.meta.url));
 const check=async(installRoot,installerPid=process.pid,guardScript=script)=>{
  try{await exec(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',guardScript],{env:{...process.env,AGENTSPACES_INSTALL_ROOT:installRoot,AGENTSPACES_INSTALLER_PID:String(installerPid)},timeout:20000,windowsHide:true});return 0;}catch(error){return error.code;}
 };
 assert.equal(await check(root),0);
 const installedGuard=join(root,'installer-guard.ps1');copyFileSync(script,installedGuard);
 assert.equal(await check(root,process.pid,installedGuard),0,'the inspection process does not block its own uninstall');
 child=spawn(binary,['-e','console.log("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore'],windowsHide:true});
 await ready(child);
 assert.equal(await check(root),10);assert.equal(child.exitCode,null);
 assert.equal(await check(root+'-different'),0,'sibling path is not the installed directory');
 assert.equal(await check(root,child.pid),0,'installer itself is excluded without excluding its siblings');
 assert.equal(await check(''),2,'missing observation scope refuses setup');
 await stop();
 assert.equal(await check(root),0);
 const scripts=join(root,'app');mkdirSync(scripts);const entry=join(scripts,'fixture-headless.mjs');
 writeFileSync(entry,"console.log('ready');setInterval(()=>{},1000)");
 child=spawn(process.execPath,[entry],{stdio:['ignore','pipe','ignore'],windowsHide:true});
 await ready(child);
 assert.equal(await check(root),10,'external Node using installed scripts also fences setup');
 assert.equal(child.exitCode,null);
 await stop();
});
