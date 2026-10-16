import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('Windows setup refuses a live bundled companion without terminating it', {skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),"as-installer's-guard-"));let child;
 t.after(async()=>{if(child?.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}rmSync(root,{recursive:true,force:true});});
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
 const externalResult=await check(root);
 let diagnostic='';
 if(externalResult!==10){
  const observed=await exec(shell,['-NoProfile','-NonInteractive','-Command',"$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:AGENTSPACES_FIXTURE_PID);$prefix=[IO.Path]::GetFullPath($env:AGENTSPACES_FIXTURE_ROOT).TrimEnd('\\')+'\\';[pscustomobject]@{name=$p.Name;knownCommand=!!$p.CommandLine;rootInCommand=($p.CommandLine -and $p.CommandLine.Replace('/','\\').IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0);fixtureInCommand=($p.CommandLine -like '*fixture-headless.mjs*');processExists=!!$p;executable=[IO.Path]::GetFileName($p.ExecutablePath)}|ConvertTo-Json -Compress"],{env:{...process.env,AGENTSPACES_FIXTURE_PID:String(child.pid),AGENTSPACES_FIXTURE_ROOT:root},timeout:20000,windowsHide:true});
  diagnostic=observed.stdout.trim();
 }
 assert.equal(externalResult,10,'external Node using installed scripts also fences setup '+diagnostic);
 assert.equal(child.exitCode,null);
 child.kill();await new Promise(resolve=>child.once('exit',resolve));
});
