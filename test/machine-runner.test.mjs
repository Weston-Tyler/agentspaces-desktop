import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Linux runner honors external locks, admission gates and timeout cleanup', {skip:process.platform!=='linux'},()=>{
 const path=fileURLToPath(new URL('../scripts/machine-run.py',import.meta.url));
 const code=String.raw`
import importlib.util, tempfile, os, fcntl, time, sys, subprocess
spec=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 lock=root+'/slot'; marker=root+'/ran'
 def admission(seconds): return {'minutes':1,'deadline':(time.time()+seconds)*1000,'lockPaths':[lock]}
 fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 try:
  try: m.run_locked(admission(.1),[sys.executable,'-c','open('+repr(marker)+',"w").write("bad")'])
  except m.ApiError: pass
  else: raise AssertionError('started while external lock held')
  assert not os.path.exists(marker)
 finally: os.close(fd)
 try:m.run_locked(admission(2),[sys.executable,'-c','open('+repr(marker)+',"w").write("bad")'],[sys.executable,'-c','raise SystemExit(1)'])
 except m.ApiError:pass
 else:raise AssertionError('gate refusal ignored')
 assert not os.path.exists(marker)
 assert m.run_locked(admission(.2),[sys.executable,'-c','import time;time.sleep(10)'])==124
 fd=os.open(lock,os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(fd)
 assert m.run_locked(admission(3),[sys.executable,'-c','raise SystemExit(7)'])==7
`;
 const result=spawnSync('python3',['-c',code,path],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr||String(result.error));
});
