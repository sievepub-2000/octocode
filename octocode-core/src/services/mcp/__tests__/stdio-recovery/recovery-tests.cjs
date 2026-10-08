const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {setup,until,deferred,ownedRoot,owned,core}=require('./runtime.cjs');
const cases=[];
const add=(name,fn)=>cases.push({name,fn});
const call=(s,marker,source)=>s.hub.callTool('fixture','probe',{marker},source);
async function close(s,connection) {
  await connection.transport.close();
  await until(()=>connection.server.status==='disconnected','real SDK onclose status');
}
async function outcome(promise) {try{return {value:await promise};}catch(error){return {error:error.message};}}
function expectRejected(result) {assert.ok(result.error,'Must reject before dispatch; got '+JSON.stringify(result));}
function expectNoMarker(s,marker) {assert.equal(s.executions().filter(e=>e.marker===marker).length,0,'Forbidden request must never reach real fixture stdin');}
function stateBarrier(s) {
  const entered=deferred(),release=deferred();
  s.stateHooks.push(async()=>{const captured=s.state.enabled;entered.resolve();await release.promise;return {mcpEnabled:captured};});
  return {entered:entered.promise,release:release.resolve};
}
add('01-first-call-real-source-sdk-stdio',async s=>{
  const connection=await s.connect('first');
  const result=await call(s,'first');
  assert.equal(JSON.parse(result.content[0].text).label,'first');
  assert.equal(connection.server.status,'connected');
  assert.equal(s.executions().length,1);
  assert.equal(s.children.length,1);
});
add('02-normal-close-recover-new-request-once',async s=>{
  const old=await s.connect('normal-close');
  const oldPid=old.transport.pid;
  await call(s,'before-close'); await close(s,old);
  const result=await call(s,'after-close');
  assert.ok(result.content.length);
  assert.notEqual(s.hub.findConnection('fixture','global').transport.pid,oldPid);
  assert.equal(s.children.length,2);
  assert.deepEqual(s.executions().map(e=>e.marker),['before-close','after-close']);
});
add('03-unknown-executed-request-never-replayed',async s=>{
  const old=await s.connect('unknown-execution');
  expectRejected(await outcome(s.hub.callTool('fixture','close_after_execute',{marker:'unknown-executed'},'global')));
  await until(()=>old.server.status==='disconnected','server exited without replying');
  assert.equal(s.children.length,1,'Failure itself does not launch recovery');
  await call(s,'new-request');
  assert.equal(s.executions().filter(e=>e.marker==='unknown-executed').length,1);
  assert.equal(s.executions().filter(e=>e.marker==='new-request').length,1);
  assert.equal(s.children.length,2);
});
add('04-disabled-server-before-recovery',async s=>{
  const old=await s.connect('disabled-before');await close(s,old);
  await s.hub.toggleServerDisabled('fixture',true,'global');
  expectRejected(await outcome(call(s,'must-not-dispatch')));
  expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1);
});
add('05-global-disabled-before-recovery',async s=>{
  const old=await s.connect('global-disabled');await close(s,old);s.state.enabled=false;
  expectRejected(await outcome(call(s,'must-not-dispatch')));
  expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1);
});
add('06-server-disable-during-enabled-read',async s=>{
  const old=await s.connect('disable-race');await close(s,old);
  const barrier=stateBarrier(s); const pending=outcome(call(s,'must-not-dispatch'));
  try {await barrier.entered;await s.hub.toggleServerDisabled('fixture',true,'global');}
  finally {barrier.release();}
  const result=await pending;s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1,'No stale enabled config respawn');
});
add('07-dispose-during-enabled-read',async s=>{
  const old=await s.connect('dispose-race');await close(s,old);
  const barrier=stateBarrier(s);const pending=outcome(call(s,'must-not-dispatch'));
  try {await barrier.entered;await s.hub.dispose();}finally {barrier.release();}
  const result=await pending;s.record('result',{result,executions:s.executions(),disposed:s.hub.isDisposed});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1,'Disposed hub must not respawn');
});
add('08-remove-during-enabled-read',async s=>{
  const old=await s.connect('remove-race');await close(s,old);
  const barrier=stateBarrier(s);const pending=outcome(call(s,'must-not-dispatch'));
  try {await barrier.entered;await s.hub.deleteConnection('fixture','global');delete s.configs.global.fixture;s.save();}
  finally {barrier.release();}
  const result=await pending;s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1,'Removed server must not respawn');
});
add('09-config-and-connection-replace-during-enabled-read',async s=>{
  const old=await s.connect('old-config');await close(s,old);
  const barrier=stateBarrier(s);const pending=outcome(call(s,'must-not-dispatch'));
  const value=s.config('new-config');
  try {await barrier.entered;s.configs.global.fixture=value;s.save();await s.hub.updateServerConnections({fixture:value},'global');}
  finally {barrier.release();}
  const result=await pending;s.record('result',{result,executions:s.executions(),config:s.hub.findConnection('fixture','global')?.server.config});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');
  assert.ok(s.hub.findConnection('fixture','global').server.config.includes('new-config'),'Keep new authoritative connection');
  assert.equal(s.children.length,2,'Old config cannot replace new process');
});
add('10-global-disable-during-recovered-tools-list',async s=>{
  const gate=path.join(s.dir,'release-tools');
  const old=await s.connect('enabled-during-connect');await close(s,old);
  const value=JSON.parse(old.server.config);value.args.push(gate);old.server.config=JSON.stringify(value);s.configs.global.fixture=value;s.save();
  const pending=outcome(call(s,'must-not-dispatch'));
  await until(()=>s.allEvents().some(e=>e.event==='tools-list-gated'),'real tools/list entered');
  s.state.enabled=false;fs.writeFileSync(gate,'release');
  const result=await pending;s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');
});
add('11-disable-pending-placeholder-during-injection',async s=>{
  const old=await s.connect('placeholder-disable');await close(s,old);
  const entered=deferred(),release=deferred();
  s.injectionHooks.push(async()=>{entered.resolve();await release.promise;});
  const pending=outcome(call(s,'must-not-dispatch'));
  try {await entered.promise;await s.hub.toggleServerDisabled('fixture',true,'global');}
  finally {release.resolve();}
  const result=await pending;s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');
  assert.equal(s.children.length,1,'Disabling pending server must not start it');
});
add('12-default-source-must-not-switch-to-new-project',async s=>{
  const old=await s.connect('global-chosen');await close(s,old);
  const actual=s.hub.connectToServer.bind(s.hub);const entered=deferred(),release=deferred();
  s.hub.connectToServer=async(...args)=>{await actual(...args);if(args[2]==='global'){entered.resolve();await release.promise;}};
  const pending=outcome(call(s,'original-selection',undefined));
  try {await entered.promise;await s.connect('project-inserted','project');}finally{release.resolve();}
  const result=await pending;s.record('result',{result,executions:s.executions()});
  assert.equal(s.executions().filter(e=>e.marker==='original-selection'&&e.label==='project-inserted').length,0,'No source reroute after recovery');
});
add('13-explicit-global-keeps-project-isolation',async s=>{
  const global=await s.connect('explicit-global');await s.connect('same-name-project','project');await close(s,global);
  const result=await call(s,'explicit-global','global');
  assert.equal(JSON.parse(result.content[0].text).label,'explicit-global');
  assert.equal(s.executions().filter(e=>e.label==='same-name-project').length,0);
  assert.equal(s.hub.connections.length,2);
});
add('14-disabled-replacement-after-connect-is-rejected',async s=>{
  const old=await s.connect('post-connect-disable');await close(s,old);
  const actual=s.hub.connectToServer.bind(s.hub);
  s.hub.connectToServer=async(...args)=>{await actual(...args);s.hub.findConnection('fixture','global').server.disabled=true;};
  const result=await outcome(call(s,'must-not-dispatch'));
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');
});
add('15-global-disabled-live-stdio-dispatch',async s=>{
  await s.connect('live-disabled');s.state.enabled=false;
  const result=await outcome(call(s,'must-not-dispatch'));s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');
});
add('16-current-toolhub-consumer-read-only-owned-call',async s=>{
  const old=await s.connect('consumer');await close(s,old);
  const hub=s.toolHub();
  const result=await hub.invoke({kind:'mcp',server:'fixture',name:'probe',arguments:{marker:'consumer'}},{permissionProfile:'full'});
  assert.equal(JSON.parse(result.content[0].text).label,'consumer');
  assert.equal(s.executions().length,1);
  const denied=await outcome(hub.invoke({kind:'mcp',server:'fixture',name:'probe',arguments:{marker:'denied'}},{permissionProfile:'read',readOnly:true}));
  expectRejected(denied);expectNoMarker(s,'denied');
});
add('17-invalid-recovery-config-does-not-spawn',async s=>{
  const old=await s.connect('invalid-config');await close(s,old);old.server.config='invalid-json';
  expectRejected(await outcome(call(s,'must-not-dispatch')));expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1);
});
add('18-new-call-on-connecting-stdio-does-not-dispatch',async s=>{
  const old=await s.connect('connecting-state');old.server.status='connecting';
  const result=await outcome(call(s,'must-not-dispatch'));s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');
});
add('19-current-toolhub-pins-source-during-recovery',async s=>{
  const old=await s.connect('consumer-global');await close(s,old);
  const actual=s.hub.connectToServer.bind(s.hub);const entered=deferred(),release=deferred();
  s.hub.connectToServer=async(...args)=>{await actual(...args);if(args[2]==='global'){entered.resolve();await release.promise;}};
  const pending=outcome(s.toolHub().invoke({kind:'mcp',server:'fixture',name:'probe',arguments:{marker:'consumer-pinned'}},{permissionProfile:'full'}));
  try{await entered.promise;await s.connect('consumer-project','project');}finally{release.resolve();}
  const result=await pending;assert.ok(result.value);
  assert.equal(s.executions().filter(e=>e.marker==='consumer-pinned'&&e.label==='consumer-project').length,0);
});
add('20-tools-list-failure-closes-failed-owned-client',async s=>{
  const value=s.config('fail-list-start');s.configs.global.fixture=value;s.save();
  expectRejected(await outcome(s.hub.connectToServer('fixture',value,'global')));
  s.record('before-harness-finally',{live:s.children.filter(row=>!row.closed).map(row=>row.pid)});
  await until(()=>s.children.every(row=>row.closed),'Source must close failed connection, not just harness finally',1000);
  assert.equal(s.hub.findConnection('fixture','global').server.status,'disconnected');
  assert.equal(s.hub.connectionAttempts.size,0);assert.equal(s.hub.startupConnections.size,0);
});
add('21-recovery-failure-does-not-replay-or-leak',async s=>{
  const old=await s.connect('recovery-failure');await close(s,old);
  const value=s.config('fail-list-recovery');old.server.config=JSON.stringify(value);s.configs.global.fixture=value;s.save();
  expectRejected(await outcome(call(s,'must-not-dispatch')));expectNoMarker(s,'must-not-dispatch');
  s.record('before-harness-finally',{live:s.children.filter(row=>!row.closed).map(row=>row.pid)});
  await until(()=>s.children.every(row=>row.closed),'Source must close failed recovered connection',1000);
  assert.equal(s.hub.connectionAttempts.size,0);assert.equal(s.hub.startupConnections.size,0);
});
add('22-stale-close-callback-cannot-mark-replacement-disconnected',async s=>{
  const old=await s.connect('stale-close-old');await close(s,old);await s.connect('stale-close-new');
  old.transport.onclose();
  await until(()=>s.hub.findConnection('fixture','global')!==old,'new identity');
  assert.equal(s.hub.findConnection('fixture','global').server.status,'connected','Old callback may only affect its own transport');
});
add('23-stale-error-callback-cannot-poison-replacement',async s=>{
  const old=await s.connect('stale-error-old');await close(s,old);await s.connect('stale-error-new');
  old.transport.onerror(new Error('owned stale callback'));
  const current=s.hub.findConnection('fixture','global');
  assert.equal(current.server.status,'connected');assert.ok(!current.server.errorHistory.some(e=>e.message==='owned stale callback'));
});
add('24-delete-in-flight-preserves-new-connection-identity',async s=>{
  const old=await s.connect('delete-old');const active=await s.connect('delete-new','project');
  const entered=deferred(),release=deferred();const actual=old.transport.close.bind(old.transport);
  old.transport.close=async()=>{entered.resolve();await release.promise;await actual();};
  const deleting=s.hub.deleteConnection('fixture','global');
  try{await entered.promise;
    s.hub.connections.push({...active,server:{...active.server,source:'global'}});
  }finally{release.resolve();}
  await deleting;
  assert.equal(s.hub.connections.filter(c=>c.server.source==='global').length,1,'Delete captured identity, not later same-name replacement');
});
add('25-dispose-during-config-injection-no-child',async s=>{
  const old=await s.connect('injection-dispose');await close(s,old);
  const entered=deferred(),release=deferred();s.injectionHooks.push(async()=>{entered.resolve();await release.promise;});
  const pending=outcome(call(s,'must-not-dispatch'));
  try{await entered.promise;await s.hub.dispose();}finally{release.resolve();}
  expectRejected(await pending);expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1);
});
add('26-global-disable-real-handler-during-recovered-list',async s=>{
  const gate=path.join(s.dir,'release-tools');const old=await s.connect('handler-disable');await close(s,old);
  const value=JSON.parse(old.server.config);value.args.push(gate);old.server.config=JSON.stringify(value);s.configs.global.fixture=value;s.save();
  const pending=outcome(call(s,'must-not-dispatch'));
  await until(()=>s.allEvents().some(e=>e.event==='tools-list-gated'),'blocked list');
  s.state.enabled=false;
  try{await s.hub.handleMcpEnabledChange(false);}finally{fs.writeFileSync(gate,'release');}
  expectRejected(await pending);expectNoMarker(s,'must-not-dispatch');
  assert.equal(s.children.length,2,'Disable must cancel rather than retry stale stdio');
  assert.ok(s.hub.connections.every(c=>c.server.status==='disconnected'));
});
add('27-duplicate-new-calls-share-one-recovery',async s=>{
  const old=await s.connect('parallel');await close(s,old);
  const result=await Promise.all([outcome(call(s,'parallel-one')),outcome(call(s,'parallel-two'))]);
  s.record('result',{result,executions:s.executions()});
  assert.equal(s.children.length,2,'One stdio recovery child');
  assert.ok(result.every(x=>x.value),'Both distinct new requests can join recovery');
  assert.equal(s.executions().filter(e=>e.marker==='parallel-one').length,1);
  assert.equal(s.executions().filter(e=>e.marker==='parallel-two').length,1);
});
add('28-connection-replaced-during-final-dispatch-state-read',async s=>{
  await s.connect('dispatch-original');const barrier=stateBarrier(s);
  const pending=outcome(call(s,'must-not-dispatch','global'));
  const hasDispatchYield=await Promise.race([barrier.entered.then(()=>true),pending.then(()=>false)]);
  if(!hasDispatchYield){barrier.release();s.record('boundary-not-present-in-baseline',{boundary:'async enabled read before live stdio dispatch'});return;}
  try{await s.connect('dispatch-replacement');}finally{barrier.release();}
  expectRejected(await pending);expectNoMarker(s,'must-not-dispatch');
  assert.ok(s.hub.findConnection('fixture','global').server.config.includes('dispatch-replacement'));
});
add('29-changed-config-after-reconnect-does-not-retarget',async s=>{
  const old=await s.connect('recover-original');await close(s,old);
  const actual=s.hub.connectToServer.bind(s.hub);let replace=true;
  s.hub.connectToServer=async(...args)=>{await actual(...args);if(replace){replace=false;await s.connect('recover-replacement');}};
  const result=await outcome(call(s,'must-not-dispatch','global'));
  s.record('result',{result,executions:s.executions()});expectRejected(result);expectNoMarker(s,'must-not-dispatch');
  assert.ok(s.hub.findConnection('fixture','global').server.config.includes('recover-replacement'));
});
add('30-project-workspace-changes-during-enabled-read',async s=>{
  const old=await s.connect('project-workspace-old','project');await close(s,old);
  const barrier=stateBarrier(s);const pending=outcome(call(s,'must-not-dispatch','project'));
  try{await barrier.entered;const next=path.join(s.dir,'next-project');fs.mkdirSync(next);
    s.workspace.workspaceFolders=[{uri:{fsPath:next}}];s.provider.cwd=next;
  }finally{barrier.release();}
  const result=await pending;s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1,'Old project command must not respawn');
});
add('31-project-workspace-changes-during-provisioning',async s=>{
  const old=await s.connect('project-provision-old','project');await close(s,old);
  const entered=deferred(),release=deferred();s.provisionHooks.push(async()=>{entered.resolve();await release.promise;});
  const pending=outcome(call(s,'must-not-dispatch','project'));
  try{await entered.promise;const next=path.join(s.dir,'next-project');fs.mkdirSync(next);
    s.workspace.workspaceFolders=[{uri:{fsPath:next}}];s.provider.cwd=next;
  }finally{release.resolve();}
  const result=await pending;s.record('result',{result,executions:s.executions()});
  expectRejected(result);expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,1);
});
add('32-dispose-during-create-state-read-no-child',async s=>{
  const barrier=stateBarrier(s);const value=s.config('create-dispose');
  const pending=outcome(s.hub.connectToServer('fixture',value,'global'));
  try{await barrier.entered;await s.hub.dispose();}finally{barrier.release();}
  await pending;assert.equal(s.children.length,0);assert.equal(s.hub.connections.length,0,'No new entries after dispose');
});
add('33-disabled-placeholder-cannot-auto-recover',async s=>{
  const value=s.config('disabled-placeholder');value.disabled=true;
  await s.hub.connectToServer('fixture',value,'global');
  expectRejected(await outcome(call(s,'must-not-dispatch','global')));expectNoMarker(s,'must-not-dispatch');assert.equal(s.children.length,0);
});
add('34-real-settings-consumer-disable-closes-stdio',async s=>{
  await s.connect('settings-disable');
  await s.dispatchUpdateSettings(false);
  s.record('before-harness-finally',{enabled:s.state.enabled,live:s.children.filter(row=>!row.closed).map(row=>row.pid),connections:s.hub.connections.map(c=>({type:c.type,status:c.server.status}))});
  assert.equal(s.state.enabled,false);
  await until(()=>s.children.every(row=>row.closed),'Persist disabled before lifecycle callback reads state',1000);
  assert.ok(s.hub.connections.every(c=>c.type==='disconnected'));
});
add('35-real-settings-consumer-enable-connects-stdio',async s=>{
  const value=s.config('settings-enable');s.configs.global.fixture=value;s.save();s.state.enabled=false;
  await s.hub.connectToServer('fixture',value,'global');assert.equal(s.children.length,0);
  await s.dispatchUpdateSettings(true);
  s.record('result',{enabled:s.state.enabled,connections:s.hub.connections.map(c=>({type:c.type,status:c.server.status}))});
  assert.equal(s.state.enabled,true);assert.equal(s.children.length,1,'Enable lifecycle must read new state');
  assert.equal(s.hub.findConnection('fixture','global').server.status,'connected');
  await call(s,'enabled-consumer','global');assert.equal(s.executions().length,1);
});
add('36-windows-equivalent-project-path-is-not-rejected',async s=>{
  assert.equal(process.platform,'win32','This acceptance case is executed on actual Windows');
  const old=await s.connect('project-path-equivalent','project');await close(s,old);
  s.workspace.workspaceFolders=[{uri:{fsPath:s.dir.toUpperCase()+path.sep}}];
  const result=await call(s,'same-project','project');
  assert.equal(JSON.parse(result.content[0].text).label,'project-path-equivalent');
  assert.equal(s.executions().length,1);
});
async function run(sourcePath,runDir,filter) {
  sourcePath=path.resolve(sourcePath);runDir=owned(runDir);fs.mkdirSync(runDir,{recursive:true});
  const results=[];const started=Date.now();
  for(const test of cases.filter(item=>!filter||item.name.includes(filter))) {
    const begin=Date.now();let s;const row={name:test.name};
    try {s=await setup(sourcePath,runDir,test.name);await test.fn(s);row.passed=true;}
    catch(error){row.passed=false;row.error={name:error.name,message:error.message,stack:error.stack};}
    finally {
      if(s){row.executions=s.executions();try{row.cleanup=await s.cleanup();}catch(error){row.passed=false;row.cleanupError=error.stack;
        row.cleanup=JSON.parse(fs.readFileSync(path.join(s.dir,'cleanup.json'),'utf8'));}}
      row.elapsedMs=Date.now()-begin;results.push(row);
      fs.writeFileSync(path.join(runDir,'results.json'),JSON.stringify({sourcePath,elapsedMs:Date.now()-started,results},null,2)+'\n');
    }
    process.stdout.write(JSON.stringify({test:row.name,passed:row.passed,error:row.error?.message,cleanupError:row.cleanupError,elapsedMs:row.elapsedMs})+'\n');
    assert.ok(Date.now()-started<175000,'Command must stay within original 180-second maximum');
  }
  const summary={sourcePath,total:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,
    children:results.reduce((sum,x)=>sum+(x.cleanup?.children.length||0),0),liveChildren:results.reduce((sum,x)=>sum+(x.cleanup?.liveChildren||0),0),elapsedMs:Date.now()-started};
  fs.writeFileSync(path.join(runDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  process.stdout.write(JSON.stringify(summary)+'\n');return summary;
}
module.exports={run,cases};
if(require.main===module) {
  const source=process.argv[2]||path.join(core,'src/services/mcp/McpHub.ts');
  const output=owned(process.argv[3]||path.join(ownedRoot,'run'));
  fs.mkdirSync(output,{recursive:true});
  const started=Date.now();
  const command={utc:new Date().toISOString(),executable:process.execPath,args:process.argv.slice(1),cwd:process.cwd(),maximumSeconds:180};
  for(const channel of ['stdout','stderr']) {
    const dest=path.join(output,channel+'.txt');fs.writeFileSync(dest,'',{flag:'wx'});
    const write=process[channel].write.bind(process[channel]);
    process[channel].write=(data,...args)=>{fs.appendFileSync(dest,data);return write(data,...args);};
  }
  fs.copyFileSync(__filename,path.join(output,'executed-recovery-tests.cjs'));
  fs.copyFileSync(require.resolve('./runtime.cjs'),path.join(output,'executed-runtime.cjs'));
  fs.copyFileSync(path.join(ownedRoot,'stdio-fixture.cjs'),path.join(output,'executed-stdio-fixture.cjs'));
  fs.writeFileSync(path.join(output,'command-before.json'),JSON.stringify(command,null,2)+'\n',{flag:'wx'});
  run(source,output,process.argv[4]).then(summary=>{
    process.exitCode=summary.failed?1:0;
    fs.writeFileSync(path.join(output,'command-ended.json'),JSON.stringify({...command,exitCode:process.exitCode,elapsedMs:Date.now()-started},null,2)+'\n',{flag:'wx'});
  }).catch(error=>{console.error(error);process.exitCode=1;});
}
