const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {setup,root,core,until,deferred,owned}=require('./lifetime-runtime.cjs');
const cases=[],add=(name,fn)=>cases.push({name,fn});
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const outcome=async promise=>{try{return {value:await promise};}catch(error){return {error:error.message};}};
function metadataGate(s){const entered=deferred(),release=deferred();s.releaseActions.push(release.resolve);s.updateHooks.push(async()=>{entered.resolve();await release.promise;});return {entered:entered.promise,release:release.resolve};}
function closeGate(s,connection){const entered=deferred(),release=deferred();s.releaseActions.push(release.resolve);const real=connection.transport.close.bind(connection.transport);let once=true;
  connection.transport.close=async()=>{if(once){once=false;entered.resolve();await release.promise;}return real();};return {entered:entered.promise,release:release.resolve};}
add('01-balanced-two-providers-secondary-first-control',async s=>{
  const a=s.createProvider('a'),b=s.createProvider('b');const [h1,h2]=await Promise.all([s.ready(a),s.ready(b)]);
  assert.equal(h1,h2);assert.equal(h1.refCount,2);await s.connect(h1,'balanced');
  await b.dispose();assert.equal(h1.refCount,1);assert.equal(h1.isDisposed,false);await s.call(h1,'surviving-primary');
  await a.dispose();assert.equal(h1.isDisposed,true);assert.ok(s.children.every(c=>c.closed));
});
add('02-concurrent-acquisitions-create-one-hub-control',async s=>{
  const gate=metadataGate(s);const a=s.createProvider('a');await gate.entered;
  const b=s.createProvider('b');await tick();assert.equal(s.hubs.length,1);gate.release();
  const [ha,hb]=await Promise.all([s.ready(a),s.ready(b)]);assert.equal(ha,hb);assert.equal(ha.refCount,2);await s.connect(ha,'concurrent');await s.call(hb,'concurrent-success');
});
add('03-repeat-acquisition-install-idempotent-control',async s=>{
  const a=s.createProvider('a'),h=await s.ready(a);await s.connect(h,'repeat');
  await a.installDefaultMarketplaceItems();await until(()=>!h.isConnecting,'owned refresh completion');
  assert.equal(a.mcpHub,h);assert.equal(h.refCount,1);await a.dispose();await a.dispose();assert.equal(h.isDisposed,true);
});
add('04-last-provider-dispose-then-reopen-must-be-fresh',async s=>{
  const a=s.createProvider('a'),old=await s.ready(a);await s.connect(old,'last');await a.dispose();
  const b=s.createProvider('b'),fresh=await s.ready(b);s.record('witness',{state:s.state()});
  assert.notEqual(fresh,old,'Manager must not return disposed cached Hub');assert.equal(fresh.isDisposed,false);
  await s.connect(fresh,'reopened');await s.call(fresh,'fresh-reopen');assert.equal(fresh.refCount,1);
});
add('05-primary-disposal-hands-weak-reference-to-survivor',async s=>{
  const a=s.createProvider('a'),b=s.createProvider('b'),h=await s.ready(a);await s.ready(b);await s.connect(h,'handoff');
  await a.dispose();s.record('witness',{state:s.state()});
  const result=await outcome(s.call(h,'surviving-secondary'));s.record('call-result',{result});
  assert.ok(h.providerRef.deref()===b,'Active Hub must not read disposed primary provider');assert.ok(result.value);assert.equal(h.refCount,1);
});
add('06-dispose-during-pending-constructor-acquisition',async s=>{
  const gate=metadataGate(s);const a=s.createProvider('a');await gate.entered;const h=s.hubs[0];await s.connect(h,'pending-owner');
  const disposing=outcome(a.dispose());await tick();gate.release();await disposing;await s.ready(a);s.record('witness',{state:s.state()});
  assert.ok(a.mcpHub===undefined,'Disposed provider must not receive a late Hub');assert.equal(h.isDisposed,true);assert.equal(h.refCount,0);
  assert.ok(s.children.every(c=>c.closed),'Pending ownership must be released');
});
add('07-initial-metadata-rejection-rolls-back-and-allows-retry',async s=>{
  s.updateHooks.push(async()=>{throw new Error('Owned metadata first-write failure');});
  const a=s.createProvider('a');await s.ready(a);const failed=s.hubs[0];const b=s.createProvider('b'),fresh=await s.ready(b);
  s.record('witness',{state:s.state()});assert.notEqual(fresh,failed,'Failed Hub must not be reused');assert.equal(failed.isDisposed,true);
  await s.connect(fresh,'metadata-retry');await s.call(fresh,'retry-live');assert.equal(fresh.refCount,1);
});
add('08-cleanup-and-acquisition-serialize-with-owned-close',async s=>{
  const a=s.createProvider('a'),old=await s.ready(a);const c=await s.connect(old,'cleanup-old');const gate=closeGate(s,c);
  const cleanup=outcome(s.M.cleanup(s.context));await gate.entered;
  const b=s.createProvider('b');await tick();s.record('paused-cleanup',{state:s.state()});gate.release();await cleanup;
  const fresh=await s.ready(b);s.record('witness',{state:s.state()});assert.ok(fresh!==old,'Fresh Hub after cleanup');assert.equal(fresh.isDisposed,false);
  assert.ok(s.M.instance===fresh,'Current singleton identity');await s.connect(fresh,'cleanup-new');await s.call(fresh,'after-cleanup');
});
add('09-overlapping-old-cleanups-cannot-clear-replacement',async s=>{
  const a=s.createProvider('a'),old=await s.ready(a),connection=await s.connect(old,'overlap-old');const gate=closeGate(s,connection);
  const first=outcome(s.M.cleanup(s.context));await gate.entered;
  const second=outcome(s.M.cleanup(s.context));await tick();
  const b=s.createProvider('b');await tick();
  if(b.mcpHub&&b.mcpHub!==old&&!b.mcpHub.isDisposed)await s.connect(b.mcpHub,'overlap-replacement-before-old-close');
  s.record('paused-overlap',{state:s.state()});gate.release();await Promise.all([first,second]);
  const fresh=await s.ready(b);s.record('witness',{state:s.state()});assert.ok(s.M.instance===fresh,'Old async cleanup must not clear replacement singleton');
  assert.ok([...s.M.providers].some(row=>(Array.isArray(row)?row[0]:row)===b),'Old cleanup must not delete replacement provider');
  assert.ok(s.metadata.value,'Old metadata clear must finish before new identity write');
  if(!fresh.connections.length)await s.connect(fresh,'overlap-replacement');await s.call(fresh,'replacement-live');
});
add('10-marketplace-reacquisition-counts-new-hub-owner',async s=>{
  const a=s.createProvider('a');await s.ready(a);await s.M.cleanup(s.context);
  const b=s.createProvider('b'),fresh=await s.ready(b);await s.connect(fresh,'marketplace-new');await a.installDefaultMarketplaceItems();await until(()=>!fresh.isConnecting,'owned marketplace refresh');
  s.record('witness',{state:s.state()});assert.equal(a.mcpHub,fresh);assert.equal(fresh.refCount,2,'Reacquiring via install must register exactly one owner');
  await a.dispose();assert.equal(fresh.refCount,1);assert.equal(fresh.isDisposed,false);await s.call(fresh,'marketplace-survivor');
});
add('11-dispose-during-marketplace-await-cannot-reacquire',async s=>{
  const a=s.createProvider('a'),old=await s.ready(a),entered=deferred(),release=deferred();s.releaseActions.push(release.resolve);
  a.marketplaceManager.installDefaultItemsOnce=async()=>{entered.resolve();await release.promise;return true;};
  const install=outcome(a.installDefaultMarketplaceItems());await entered.promise;await a.dispose();release.resolve();await install;
  s.record('witness',{state:s.state()});assert.ok(a.mcpHub===undefined,'Post-disposal install completion must not reacquire');assert.equal(old.isDisposed,true);
  assert.equal(s.hubs.length,1,'No unowned replacement from disposed provider');
});
add('12-direct-anonymous-hub-reference-api-control',async s=>{
  const h=new s.Hub(s.provider);h.registerClient();h.registerClient();assert.equal(h.refCount,2);await s.connect(h,'anonymous');
  await h.unregisterClient();assert.equal(h.refCount,1);assert.equal(h.isDisposed,false);await s.call(h,'anonymous-live');
  await h.unregisterClient();assert.equal(h.isDisposed,true);assert.equal(h.refCount,0);
});
add('13-metadata-cleanup-failure-does-not-poison-next-generation',async s=>{
  const a=s.createProvider('a'),h=await s.ready(a);await s.connect(h,'clear-failure');
  s.updateHooks.push(async()=>{throw new Error('Owned metadata clear failure');});
  const stopped=await outcome(s.M.cleanup(s.context));assert.ok(stopped.error,'Cleanup failure is propagated');
  const b=s.createProvider('b'),fresh=await s.ready(b);s.record('witness',{state:s.state(),stopped});
  assert.notEqual(fresh,h);assert.equal(fresh.isDisposed,false);await s.connect(fresh,'clear-retry');await s.call(fresh,'after-clear-failure');
  assert.ok([...s.M.providers].every(row=>(Array.isArray(row)?row[0]:row)!==a),'Failed old cleanup must release old provider registry');
});
add('14-unregister-api-removes-only-one-active-owner',async s=>{
  const a=s.createProvider('a'),b=s.createProvider('b'),h=await s.ready(a);await s.ready(b);await s.connect(h,'unregister-api');
  const returned=s.M.unregisterProvider(a);assert.equal(returned,undefined,'Existing void API remains void');
  await tick();s.record('witness',{state:s.state()});assert.equal(h.refCount,1,'Unregister must release precisely its ownership');
  assert.ok(h.providerRef.deref()===b,'Unregister hands off live provider reference');await s.call(h,'unregister-survivor');
});
add('15-anonymous-reference-survives-managed-reopen-control',async s=>{
  const a=s.createProvider('a'),h=await s.ready(a);h.registerClient();await s.connect(h,'mixed-anonymous');
  await a.dispose();assert.equal(h.isDisposed,false,'Anonymous reference must keep Hub live');assert.equal(h.refCount,1);
  const b=s.createProvider('b'),same=await s.ready(b);assert.ok(same===h,'Keep anonymous client API ownership');
  s.record('witness',{state:s.state()});assert.ok(h.providerRef.deref()===b,'Reopened managed provider becomes the live weak reference');
  assert.equal(h.refCount,2);await s.call(h,'anonymous-managed-reopen');await h.unregisterClient();await b.dispose();assert.equal(h.refCount,0);
});
add('16-notify-fanout-only-current-provider-control',async s=>{
  const a=s.createProvider('a'),b=s.createProvider('b');await Promise.all([s.ready(a),s.ready(b)]);const sink=[];
  for(const p of [a,b])p.postMessageToWebview=async message=>{sink.push({name:p.name,message});};
  s.M.notifyProviders({owned:'first'});await tick();assert.equal(sink.length,2);
  await a.dispose();sink.length=0;s.M.notifyProviders({owned:'second'});await tick();assert.deepEqual(sink.map(x=>x.name),['b']);
});
add('17-pending-old-init-cannot-release-or-attach-new-generation',async s=>{
  const gate=metadataGate(s),a=s.createProvider('a');await gate.entered;const old=s.hubs[0];await s.connect(old,'old-pending-generation');
  const closing=outcome(s.M.cleanup(s.context));await tick();const installing=outcome(a.installDefaultMarketplaceItems());await tick();
  gate.release();await closing;await s.ready(a);const installed=await installing;s.record('witness',{state:s.state(),installed});
  assert.ok(!installed.error,'New generation may initialize after old metadata closes');
  const fresh=a.mcpHub;assert.ok(fresh&&fresh!==old&&!fresh.isDisposed,'Do not attach retired generation');
  assert.ok(s.M.instance===fresh);assert.equal(fresh.refCount,1);await until(()=>!fresh.isConnecting,'new-generation refresh');await s.call(fresh,'new-generation-live');
});
add('18-mcp-release-failure-still-completes-provider-local-teardown',async s=>{
  const a=s.createProvider('a'),h=await s.ready(a);await s.connect(h,'release-failure');const calls=[];
  a._workspaceTracker={dispose:()=>calls.push('tracker')};a.skillsManager={dispose:async()=>calls.push('skills')};
  a.marketplaceManager.cleanup=async()=>calls.push('marketplace');a.customModesManager={dispose:()=>calls.push('modes')};
  h.projectToolCopies.dispose=async()=>{throw new Error('Owned project-copy dispose failure');};
  const result=await outcome(a.dispose());s.record('witness',{state:s.state(),result,localCalls:calls});
  assert.ok(result.error,'Original MCP teardown failure remains observable');
  assert.deepEqual(calls,['tracker','skills','marketplace','modes'],'MCP failure must not skip remaining provider teardown');
  assert.ok(!s.C.activeInstances.has(a),'Disposed provider must leave active instance registry');
  assert.ok(s.children.every(c=>c.closed));
});
async function run(sourceRoot,out){
  out=owned(out);fs.mkdirSync(out,{recursive:true});const start=Date.now(),results=[];
  for(const t of cases){let s;const row={name:t.name},began=Date.now();
    try{s=await setup(sourceRoot,out,t.name);await t.fn(s);row.passed=true;}
    catch(error){row.passed=false;row.error={message:error.message,stack:error.stack};}
    finally{if(s){row.witness=s.state();try{row.cleanup=await s.cleanup();}catch(error){row.passed=false;row.cleanupError=error.stack;}}
      row.elapsedMs=Date.now()-began;results.push(row);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({sourceRoot,results},null,2)+'\n');}
    process.stdout.write(JSON.stringify({name:row.name,passed:row.passed,error:row.error?.message,cleanupError:row.cleanupError,elapsedMs:row.elapsedMs})+'\n');
    assert.ok(Date.now()-start<175000,'Within original 180-second maximum');
  }
  const summary={total:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,
    children:results.reduce((sum,x)=>sum+(x.cleanup?.children.length||0),0),liveChildren:results.reduce((sum,x)=>sum+(x.cleanup?.liveChildren||0),0),elapsedMs:Date.now()-start};
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');process.stdout.write(JSON.stringify(summary)+'\n');return summary;
}
module.exports={run,cases};
if(require.main===module){const source=path.resolve(process.argv[2]||core),out=owned(process.argv[3]||path.join(root,'run'));
  fs.mkdirSync(out,{recursive:true});const start=Date.now();
  for(const channel of ['stdout','stderr']){const file=path.join(out,channel+'.txt');fs.writeFileSync(file,'',{flag:'wx'});const write=process[channel].write.bind(process[channel]);process[channel].write=(data,...args)=>{fs.appendFileSync(file,data);return write(data,...args);};}
  for(const name of ['lifetime-tests.cjs','lifetime-runtime.cjs','base-runtime.cjs','stdio-fixture.cjs'])fs.copyFileSync(path.join(__dirname,name),path.join(out,'executed-'+name));
  const cmd={utc:new Date().toISOString(),executable:process.execPath,args:process.argv.slice(1),cwd:process.cwd(),maximumSeconds:180};fs.writeFileSync(path.join(out,'command-before.json'),JSON.stringify(cmd,null,2)+'\n');
  run(source,out).then(summary=>{process.exitCode=summary.failed?1:0;fs.writeFileSync(path.join(out,'command-ended.json'),JSON.stringify({...cmd,exitCode:process.exitCode,elapsedMs:Date.now()-start},null,2)+'\n');}).catch(error=>{console.error(error);process.exitCode=1;});
}
