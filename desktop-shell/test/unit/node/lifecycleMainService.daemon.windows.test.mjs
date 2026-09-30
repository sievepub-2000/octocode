// Real Windows Electron/Python process regression; no live daemon or production state.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const electron=process.env.OCTOCODE_TEST_ELECTRON || join(sourceRoot,'.build/electron/OctoCode.exe');
const python=[process.env.OCTOCODE_TEST_PYTHON,process.env.OCTO_ENV_ROOT&&join(process.env.OCTO_ENV_ROOT,'python/python.exe'),join(sourceRoot,'.build/environments/python/python.exe')].find(p=>p&&existsSync(p));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const snapshot=pid=>{
 const text=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}).trim();
 return text?JSON.parse(text):null;
};
test('Windows detached Python survives actual Electron normal exit after stdin EOF', {skip:process.platform!=='win32',timeout:60000}, async t=>{
 assert.ok(existsSync(electron),'Bundled Electron required; set OCTOCODE_TEST_ELECTRON');
 assert.ok(python,'Python required; set OCTOCODE_TEST_PYTHON or source work/octo-env.ps1');
 const root=mkdtempSync(join(tmpdir(),'octocode-electron-child-'));
 const childScript=join(root,'child.py');
 writeFileSync(childScript,`import json,os,sys,time\nfrom pathlib import Path\nr=Path(sys.argv[1])\n(r/'ready').write_text(str(os.getpid()))\nsys.stdin.buffer.read()\n(r/'eof').write_text('ignored')\nwhile True:\n (r/'heartbeat').write_text(str(time.time()))\n time.sleep(.1)\n`);
 const mainScript=join(root,'main.cjs');
 writeFileSync(mainScript,`const {app}=require('electron');const fs=require('fs');const {spawn}=require('child_process');const path=require('path');const r=process.env.REPRO_ROOT;app.setName('OctoCode-Isolated-Regression');app.setPath('userData',path.join(r,'user-data'));app.whenReady().then(()=>{const log=fs.openSync(path.join(r,'child.log'),'a');const c=spawn(process.env.REPRO_PYTHON,[${JSON.stringify(childScript)},r],{windowsHide:true,detached:process.env.REPRO_DETACHED==='true',stdio:['pipe','ignore',log]});fs.closeSync(log);fs.writeFileSync(path.join(r,'identity.json'),JSON.stringify({parent:process.pid,child:c.pid,electron:process.versions.electron}));const timer=setInterval(()=>{if(!fs.existsSync(path.join(r,'go')))return;clearInterval(timer);c.stdin.end();c.unref();app.quit()},25)});`);
 try {
  for(const detached of [false,true])await t.test(`detached=${detached}`,async()=>{
   const dir=join(root,String(detached));mkdirSync(dir);
   const env={...process.env,REPRO_ROOT:dir,REPRO_PYTHON:python,REPRO_DETACHED:String(detached)};
   for(const name of ['VSCODE_PORTABLE','VSCODE_APPDATA','ELECTRON_RUN_AS_NODE'])delete env[name];
   const parent=spawn(electron,[mainScript,'--user-data-dir='+join(dir,'user-data')],{env,cwd:dir,windowsHide:true,stdio:'ignore'});
   const parentExit=new Promise(r=>parent.once('exit',(code,signal)=>r({code,signal})));
   let identity, original;
   try {
    const deadline=Date.now()+15000;
    while(!existsSync(join(dir,'ready'))&&Date.now()<deadline)await delay(50);
    assert.ok(existsSync(join(dir,'ready')),'Python readiness');
    identity=JSON.parse(readFileSync(join(dir,'identity.json'),'utf8'));original=snapshot(identity.child);assert.ok(original,'Child identity captured before quit');
    writeFileSync(join(dir,'go'),'quit');
    const exited=await Promise.race([parentExit,delay(15000).then(()=>{throw Error('Electron did not exit')})]);
    assert.equal(exited.code,0);assert.equal(snapshot(identity.parent),null);
    await delay(1200);
    assert.ok(existsSync(join(dir,'eof')),'Child observed EOF');
    assert.equal(snapshot(identity.child)!==null,detached,'Actual child survival');
    if(detached)assert.ok(Date.now()-statSync(join(dir,'heartbeat')).mtimeMs<600,'Live post-parent heartbeat');
    t.diagnostic(JSON.stringify({detached,electron:identity.electron,parentGone:true,childSurvived:detached,eofIgnored:true}));
   } finally {
    if(identity){const current=snapshot(identity.child);if(current){assert.deepEqual(current,original,'Cleanup PID identity');execFileSync('powershell.exe',['-NoProfile','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.child}';if($p.ExecutablePath -eq '${python.replaceAll("'","''")}' -and $p.CommandLine.Contains('${dir.replaceAll("'","''")}')){Stop-Process -Id ${identity.child} -Force}else{throw 'Child identity mismatch'}`],{windowsHide:true});}assert.equal(snapshot(identity.child),null);}
    if(parent.exitCode===null&&parent.signalCode===null){const current=snapshot(parent.pid);if(current&&resolve(current.ExecutablePath).toLowerCase()===resolve(electron).toLowerCase())parent.kill();await parentExit;}
   }
  });
 } finally {rmSync(root,{recursive:true,force:true});}
});
