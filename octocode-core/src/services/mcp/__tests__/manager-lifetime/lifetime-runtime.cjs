const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const base=require('./base-runtime.cjs');const ts=base.req('typescript');
const root=base.ownedRoot,sha=x=>createHash('sha256').update(x).digest('hex');
async function setup(sourceRoot,runRoot,name){
  const hubFile=path.join(sourceRoot,'src/services/mcp/McpHub.ts');
  const s=await base.setup(hubFile,runRoot,name);
  const hubs=[],providers=[],releaseActions=[];const updates=[],updateHooks=[];
  const metadata={value:undefined};
  const context={extension:{packageJSON:{version:'owned-lifetime'}},globalState:{
    update:async(key,value)=>{
      assert.equal(key,'mcpHubInstanceId','No secrets/settings/permissions writes');
      s.record('metadata-update-enter',{value});
      if(updateHooks.length)await updateHooks.shift()(value);
      metadata.value=value;updates.push({value,utc:new Date().toISOString()});
      fs.writeFileSync(path.join(s.dir,'owned-metadata.json'),JSON.stringify({key,value}));
      s.record('metadata-update-complete',{value});
    }}};
  class Hub extends s.McpHub{constructor(...args){super(...args);hubs.push(this);s.record('managed-hub-created',{ordinal:hubs.length});}}
  const managerFile=path.join(sourceRoot,'src/services/mcp/McpServerManager.ts');
  const M=base.loadTs(managerFile,id=>{
    if(id==='./McpHub')return {McpHub:Hub};
    if(id==='./SecretStorageService')return {SecretStorageService:class{constructor(){s.record('secret-service-adapter-no-storage');}}};
    if(id==='vscode')return {};
    throw new Error('Unexpected manager import '+id);
  },s.record,path.join(s.dir,'actual-transpiled-manager.cjs')).McpServerManager;
  const providerFile=path.join(sourceRoot,'src/core/webview/ClineProvider.ts');
  const full=fs.readFileSync(providerFile,'utf8');
  const parsed=ts.createSourceFile(providerFile,full,ts.ScriptTarget.ES2022,true);
  const cls=parsed.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='ClineProvider');assert.ok(cls);
  const ctor=cls.members.find(n=>ts.isConstructorDeclaration(n));
  const initializer=ctor.body.statements.find(n=>ts.isExpressionStatement(n)&&n.getText(parsed).startsWith('McpServerManager.getInstance('));assert.ok(initializer);
  const methods=['dispose','clearWebviewResources','installDefaultMarketplaceItems'].map(name=>{
    const member=cls.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.getText(parsed)===name);assert.ok(member);return member.getText(parsed);
  });
  const extracted='import {McpServerManager} from "./manager"\nimport {CloudService} from "./cloud"\nexport class ClineProvider {\n'+
    'static activeInstances=new Set(); _disposed=false; disposables=[]; webviewDisposables=[]; mcpHub; view; _workspaceTracker; skillsManager; customModesManager;\n'+
    'constructor(context, name, runtime){this.context=context;this.name=name;this.runtime=runtime;this.cwd=runtime.dir;this.enabled=true;ClineProvider.activeInstances.add(this);\n'+
    'this.marketplaceManager={installDefaultItemsOnce:async()=>true,cleanup:async()=>{}};\n'+
    'this.initialization='+initializer.getText(parsed).replace(/;$/,'')+';\n}\n'+
    'log(message){this.runtime.record("provider-log",{name:this.name,message:String(message)});}\n'+
    'async getState(){this.runtime.record("actor-state-read",{name:this.name,disposed:this._disposed}); if(this._disposed)throw new Error("Owned state adapter: disposed provider read "+this.name);return {mcpEnabled:this.enabled};}\n'+
    'removeAllListeners(){} updateCodeIndexStatusSubscription(){}\n'+methods.join('\n')+'\n}\n';
  const providerExtract=path.join(s.dir,'actual-provider-lifecycle.ts');fs.writeFileSync(providerExtract,extracted);
  const C=base.loadTs(providerExtract,id=>{
    if(id==='./manager')return {McpServerManager:M};
    if(id==='./cloud')return {CloudService:{hasInstance:()=>false}};
    throw new Error('Unexpected lifecycle import '+id);
  },s.record,path.join(s.dir,'actual-transpiled-provider-lifecycle.cjs')).ClineProvider;
  function createProvider(name){const p=new C(context,name,s);providers.push(p);return p;}
  async function ready(p){await p.initialization;return p.mcpHub;}
  async function connect(hub,label){
    const config=s.config(label);s.configs.global.fixture=config;s.save();
    await hub.connectToServer('fixture',config,'global');return hub.findConnection('fixture','global');
  }
  const call=(hub,marker)=>hub.callTool('fixture','probe',{marker},'global');
  function state(){return {instanceOrdinal:hubs.indexOf(M.instance)+1,hubCount:hubs.length,
    providers:[...M.providers].map(row=>Array.isArray(row)?row[0].name:row.name),
    hubs:hubs.map(h=>({disposed:h.isDisposed,refCount:h.refCount,provider:h.providerRef.deref()?.name,connections:h.connections.length})),
    actors:providers.map(p=>({name:p.name,disposed:p._disposed,hubOrdinal:hubs.indexOf(p.mcpHub)+1})),metadata:metadata.value};}
  async function cleanup(){
    for(const release of releaseActions)release();
    const errors=[];
    for(const p of providers){try{await p.dispose();}catch(error){errors.push('provider: '+error.message);}}
    try{await M.cleanup(context);}catch(error){errors.push('manager: '+error.message);}
    for(const hub of hubs){try{await hub.dispose();}catch(error){errors.push('hub: '+error.message);}}
    const cleanup=await s.cleanup();
    const out={...cleanup,managerState:state(),expectedFaultsDuringFinally:errors};
    fs.writeFileSync(path.join(s.dir,'lifetime-cleanup.json'),JSON.stringify(out,null,2)+'\n');return out;
  }
  s.record('lifetime-source-binding',{hubFile,hubSHA256:sha(fs.readFileSync(hubFile)),managerFile,managerSHA256:sha(fs.readFileSync(managerFile)),
    providerFile,providerSHA256:sha(full),initializerSHA256:sha(initializer.getText(parsed)),methodSHA256:methods.map(sha),
    real:'complete Manager and Hub classes; exact provider MCP constructor expression/dispose/clear/install methods; actual SDK and owned Node pipes',
    adapted:'provider shell, unrelated constructor/services/VSCode Cloud/UI/cache; owned globalState metadata; constructor watches and init/config selectors inherited from delivered stdio adapter'});
  return {...s,M,Hub,C,hubs,providers,context,updates,updateHooks,metadata,releaseActions,createProvider,ready,connect,call,state,cleanup};
}
module.exports={...base,root,setup};
