const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {setup,root,core,until,deferred,owned}=require('./lifetime-runtime.cjs');
const cases=[],add=(name,run)=>cases.push({name,run});
const settle=promise=>promise.then(value=>({value}),error=>({error:error.message}));
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function metadataGate(s){const entered=deferred(),release=deferred();s.releaseActions.push(release.resolve);s.updateHooks.push(async()=>{entered.resolve();await release.promise;});return {entered:entered.promise,release:release.resolve};}
function ownership(s,p,h){return {provider:p.name,registrySize:s.M.providers.size,registrationHubSame:s.M.providers.get(p)?.hub===h,
  refCount:h.refCount,disposed:h.isDisposed,liveChildren:s.children.filter(c=>!c.closed).length};}
async function proveLastReleaseCloses(s,p,h,label){
  s.record('ownership-before-real-fixture',{witness:ownership(s,p,h)});
  await s.connect(h,label);await s.call(h,label+'-probe');
  await p.dispose();const after=ownership(s,p,h);s.record('after-last-release-before-harness-finally',{witness:after});
  assert.equal(after.registrySize,0,'Exactly one provider registry entry is released');
  assert.equal(after.refCount,0,'No extra anonymous ownership from same-provider overlap');
  assert.equal(after.disposed,true,'Last managed release must dispose Hub');
  assert.equal(after.liveChildren,0,'Source release must close real owned child before harness finally');
}
add('01-same-provider-two-first-acquisitions',async s=>{
  const p=s.createProvider('same');const second=s.M.getInstance(s.context,p);
  const [h,again]=await Promise.all([s.ready(p),second]);assert.ok(h===again);assert.equal(s.M.providers.size,1);
  await proveLastReleaseCloses(s,p,h,'same-provider-first');
});
add('02-constructor-first-marketplace-both-pending-control',async s=>{
  const gate=metadataGate(s),p=s.createProvider('same');const install=p.installDefaultMarketplaceItems();
  await gate.entered;s.record('pending-natural-order',{state:s.state(),note:'Constructor MCP expression started first, Marketplace install await follows; metadata is deliberately pending.'});
  gate.release();await Promise.all([s.ready(p),install]);const h=p.mcpHub;await until(()=>!h.isConnecting,'owned marketplace refresh');
  assert.equal(h.refCount,1);await proveLastReleaseCloses(s,p,h,'natural-constructor-marketplace');
});
add('03-controlled-marketplace-await-then-constructor-first-get',async s=>{
  const p=s.createProvider('same',true);
  // The host stages only invocation order. Actual install/default constructor expression and Manager are unchanged.
  // A resolved install await is queued first, then the actual constructor MCP expression starts before that await resumes.
  const install=p.installDefaultMarketplaceItems();p.startMcpInitialization();
  s.record('controlled-consumer-order',{note:'Host shell defers MCP constructor step; Marketplace install await queued before the same actual constructor MCP expression. Not a claim of real GUI scheduling.'});
  await Promise.all([s.ready(p),install]);const h=p.mcpHub;await until(()=>!h.isConnecting,'owned staged marketplace refresh');
  assert.equal(s.M.providers.size,1);await proveLastReleaseCloses(s,p,h,'staged-constructor-marketplace');
});
add('04-two-different-providers-concurrent-control',async s=>{
  const a=s.createProvider('a'),b=s.createProvider('b'),[h,other]=await Promise.all([s.ready(a),s.ready(b)]);
  assert.ok(h===other);assert.equal(s.M.providers.size,2);assert.equal(h.refCount,2);
  await s.connect(h,'different-providers');await a.dispose();assert.equal(h.refCount,1);assert.equal(h.isDisposed,false);
  await s.call(h,'different-provider-survivor');await b.dispose();assert.equal(h.refCount,0);assert.ok(s.children.every(c=>c.closed));
});
add('05-already-registered-same-provider-concurrent-control',async s=>{
  const p=s.createProvider('same'),h=await s.ready(p);
  const [a,b]=await Promise.all([s.M.getInstance(s.context,p),s.M.getInstance(s.context,p)]);
  assert.ok(a===h&&b===h);assert.equal(s.M.providers.size,1);assert.equal(h.refCount,1);
  await proveLastReleaseCloses(s,p,h,'already-registered');
});
add('06-same-provider-await-generation-cancel-control',async s=>{
  const p=s.createProvider('same');const second=settle(s.M.getInstance(s.context,p));const old=s.hubs[0];
  const stopping=settle(s.M.cleanup(s.context));await stopping;await Promise.all([s.ready(p),second]);
  s.record('after-cancel',{state:s.state()});assert.equal(old.refCount,0);assert.equal(old.isDisposed,true);
  assert.ok(p.mcpHub===undefined);assert.equal(s.M.providers.size,0);
});
add('07-owned-old-lease-concurrent-release-preserves-anonymous-owner',async s=>{
  const p=s.createProvider('same'),old=await s.ready(p);old.registerClient();await s.connect(old,'old-anonymous-lease');
  const fresh=new s.Hub(p);
  // Explicit in-memory state adapter: model an active old registration with a replacement generation.
  // No assertion that a live product reaches this private state; both Hub objects and anonymous reference are real Source.
  s.M.instance=fresh;s.record('injected-old-active-lease-state',{state:s.state(),adapted:true});
  const [a,b]=await Promise.all([s.M.getInstance(s.context,p),s.M.getInstance(s.context,p)]);
  assert.ok(a===fresh&&b===fresh);const witness={oldRefCount:old.refCount,oldDisposed:old.isDisposed,newRefCount:fresh.refCount,registrySize:s.M.providers.size};s.record('old-lease-witness',witness);
  assert.equal(old.refCount,1,'Release old managed lease once; keep independently registered anonymous owner');
  assert.equal(old.isDisposed,false,'Do not dispose another old anonymous owner');assert.equal(fresh.refCount,1,'One replacement managed reference');
  await old.unregisterClient();await p.dispose();assert.ok(s.children.every(c=>c.closed));
});
add('08-dispose-local-resources-before-owned-mcp-close-await',async s=>{
  const p=s.createProvider('same'),h=await s.ready(p),connection=await s.connect(h,'local-order'),events=[];
  p.view={dispose:()=>events.push('view')};p.webviewDisposables.push({dispose:()=>events.push('webview-listener')});
  p.disposables.push({dispose:()=>events.push('disposable')});p._workspaceTracker={dispose:()=>events.push('tracker')};
  p.skillsManager={dispose:async()=>events.push('skills')};
  const entered=deferred(),release=deferred();s.releaseActions.push(release.resolve);const real=connection.transport.close.bind(connection.transport);let once=true;
  connection.transport.close=async()=>{if(once){once=false;entered.resolve();await release.promise;}return real();};
  const disposing=settle(p.dispose());
  try{await entered.promise;s.record('local-order-at-real-mcp-close-gate',{events:[...events],state:s.state(),liveChildren:s.children.filter(c=>!c.closed).length});
    assert.deepEqual(events,['view','webview-listener','disposable','tracker'],'Original local view/listener/tracker cleanup must precede the MCP await');
  }finally{release.resolve();await disposing;}
  assert.ok(events.includes('skills'));assert.ok(s.children.every(c=>c.closed));
});
add('09-release-failure-preserves-remaining-provider-cleanup',async s=>{
  const p=s.createProvider('same'),h=await s.ready(p),events=[];await s.connect(h,'release-error-order');
  p._workspaceTracker={dispose:()=>events.push('tracker')};p.skillsManager={dispose:async()=>events.push('skills')};
  p.marketplaceManager.cleanup=async()=>events.push('marketplace');p.customModesManager={dispose:()=>events.push('modes')};
  h.projectToolCopies.dispose=async()=>{throw new Error('Owned project-copy dispose failure');};
  const result=await settle(p.dispose());s.record('release-failure-local-cleanup',{result,events:[...events],state:s.state()});
  assert.ok(result.error);assert.deepEqual(events,['tracker','skills','marketplace','modes']);assert.ok(!s.C.activeInstances.has(p));assert.ok(s.children.every(c=>c.closed));
});
async function run(sourceRoot,out){fs.mkdirSync(out,{recursive:true});const results=[],start=Date.now();
  for(const item of cases.filter(item=>!process.argv[4]||item.name.includes(process.argv[4]))){let s;const row={name:item.name};const began=Date.now();
    try{s=await setup(sourceRoot,out,item.name);await item.run(s);row.passed=true;}
    catch(error){row.passed=false;row.error={message:error.message,stack:error.stack};}
    finally{if(s){row.witness=s.state();try{row.cleanup=await s.cleanup();}catch(error){row.passed=false;row.cleanupError=error.stack;}}
      row.elapsedMs=Date.now()-began;results.push(row);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({sourceRoot,results},null,2)+'\n');}
    process.stdout.write(JSON.stringify({name:row.name,passed:row.passed,error:row.error?.message,cleanupError:row.cleanupError,elapsedMs:row.elapsedMs})+'\n');
    assert.ok(Date.now()-start<175000,'Original 180-second command budget unchanged');
  }
  const summary={total:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,
    children:results.reduce((sum,row)=>sum+(row.cleanup?.children.length||0),0),liveChildren:results.reduce((sum,row)=>sum+(row.cleanup?.liveChildren||0),0),elapsedMs:Date.now()-start};
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');process.stdout.write(JSON.stringify(summary)+'\n');return summary;
}
module.exports={run,cases};
if(require.main===module){const source=path.resolve(process.argv[2]||core),out=owned(process.argv[3]||path.join(root,'run'));
  fs.mkdirSync(out,{recursive:true});const start=Date.now();for(const channel of ['stdout','stderr']){const file=path.join(out,channel+'.txt');fs.writeFileSync(file,'',{flag:'wx'});const write=process[channel].write.bind(process[channel]);process[channel].write=(data,...args)=>{fs.appendFileSync(file,data);return write(data,...args);};}
  for(const name of ['concurrency-tests.cjs','lifetime-runtime.cjs','base-runtime.cjs','stdio-fixture.cjs'])fs.copyFileSync(path.join(__dirname,name),path.join(out,'executed-'+name));
  const command={utc:new Date().toISOString(),executable:process.execPath,args:process.argv.slice(1),cwd:process.cwd(),maximumSeconds:180};fs.writeFileSync(path.join(out,'command-before.json'),JSON.stringify(command,null,2)+'\n');
  run(source,out).then(summary=>{process.exitCode=summary.failed?1:0;fs.writeFileSync(path.join(out,'command-ended.json'),JSON.stringify({...command,exitCode:process.exitCode,elapsedMs:Date.now()-start},null,2)+'\n');}).catch(error=>{console.error(error);process.exitCode=1;});
}
