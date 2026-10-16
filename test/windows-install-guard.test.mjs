import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('Windows setup refuses a live bundled companion without terminating it', {skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),"as-installer's-guard-"));let child;
 t.after(async()=>{if(child?.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}rmSync(root,{recursive:true,force:true});});
 const runtime=join(root,'resources','runtime');mkdirSync(runtime,{recursive:true});
 const binary=join(runtime,'node.exe');copyFileSync(process.execPath,binary);
 const shell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const script=fileURLToPath(new URL('../assets/windows-install-guard.ps1',import.meta.url));
 const check=async(installRoot,installerPid=process.pid)=>{
  try{await exec(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{env:{...process.env,AGENTSPACES_INSTALL_ROOT:installRoot,AGENTSPACES_INSTALLER_PID:String(installerPid)},timeout:20000,windowsHide:true});return 0;}catch(error){return error.code;}
 };
 assert.equal(await check(root),0);
 child=spawn(binary,['-e',"console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore'],windowsHide:true});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});
 assert.equal(await check(root),10);assert.equal(child.exitCode,null);
 assert.equal(await check(root+'-different'),0,'sibling path is not the installed directory');
 assert.equal(await check(root,child.pid),0,'installer itself is excluded without excluding its siblings');
 assert.equal(await check(''),2,'missing observation scope refuses setup');
 child.kill();await new Promise(resolve=>child.once('exit',resolve));
 assert.equal(await check(root),0);
 const scripts=join(root,'app');mkdirSync(scripts);const entry=join(scripts,'fixture-headless.mjs');
 writeFileSync(entry,"console.log('ready');setInterval(()=>{},1000)");
 child=spawn(process.execPath,[entry],{stdio:['ignore','pipe','ignore'],windowsHide:true});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});
 assert.equal(await check(root),10,'external Node using installed scripts also fences setup');
 assert.equal(child.exitCode,null);
 child.kill();await new Promise(resolve=>child.once('exit',resolve));
});
