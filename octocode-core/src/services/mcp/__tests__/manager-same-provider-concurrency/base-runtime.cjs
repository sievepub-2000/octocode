const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
assert.ok(process.env.OCTOCODE_STDIO_TEST_ROOT, 'Provide a fresh explicitly owned output directory in OCTOCODE_STDIO_TEST_ROOT');
const ownedRoot = path.resolve(process.env.OCTOCODE_STDIO_TEST_ROOT);
assert.notEqual(ownedRoot, path.parse(ownedRoot).root, 'Owner directory cannot be a filesystem root');
const core = process.env.OCTOCODE_STDIO_TEST_CORE || path.resolve(__dirname, '../../../../..');
fs.mkdirSync(ownedRoot, {recursive:true});
const fixtureFile = path.join(ownedRoot, 'stdio-fixture.cjs');
const fixtureBytes = fs.readFileSync(path.join(__dirname, 'stdio-fixture.cjs'));
if (fs.existsSync(fixtureFile)) assert.ok(fs.readFileSync(fixtureFile).equals(fixtureBytes), 'Do not overwrite a foreign fixture');
else fs.writeFileSync(fixtureFile, fixtureBytes, {flag:'wx'});
const req = createRequire(path.join(core, 'src/package.json'));
const ts = req('typescript');
const sdkStdio = req('@modelcontextprotocol/sdk/client/stdio.js');
const sdkClient = req('@modelcontextprotocol/sdk/client/index.js');
const sdkTypes = req('@modelcontextprotocol/sdk/types.js');
const sdkAuth = req('@modelcontextprotocol/sdk/client/auth.js');
function owned(file) {
  const resolved = path.resolve(file);
  assert.ok(resolved.startsWith(ownedRoot + path.sep), 'All fixture files must be owned');
  return resolved;
}
function loadTs(sourcePath, localRequire, record, out) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {fileName: sourcePath,
    compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, esModuleInterop:true}, reportDiagnostics:true});
  const errors = result.diagnostics?.filter(x => x.category===ts.DiagnosticCategory.Error) || [];
  assert.equal(errors.length, 0, 'Transpile syntax diagnostics');
  if (out) fs.writeFileSync(owned(out), result.outputText, {flag:'wx'});
  const module = {exports:{}};
  const context = {require:localRequire, module, exports:module.exports, Buffer, URL, Headers, WeakRef,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process:{platform:process.platform, env:{NODE_ENV:'test'}, cwd:()=>ownedRoot},
    console:{error:(...data)=>record('source-console-error',{data:data.map(x=>x instanceof Error?x.message:String(x))}),
      log:(...data)=>record('source-console-log',{data:data.map(String)}), warn:(...data)=>record('source-console-warn',{data:data.map(String)})},
    __dirname:path.dirname(sourcePath), __filename:sourcePath};
  context.global = context;
  // Use the application's single JS realm: deep-equal compares nested constructor identity.
  // All imports and process/global bindings remain explicit adapters in this wrapper.
  vm.compileFunction(result.outputText, Object.keys(context), {filename:sourcePath})(...Object.values(context));
  return module.exports;
}
function deferred() {let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve};}
async function until(predicate, message, limit=3500) {
  const start=Date.now();
  while (!predicate()) {
    if (Date.now()-start>limit) throw new Error('Event deadline: '+message);
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
function events(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
async function setup(sourcePath, runDir, name) {
  const dir=owned(path.join(runDir,name));
  fs.mkdirSync(dir,{recursive:true});
  const trace=path.join(dir,'runtime.jsonl');
  const record=(event,data={})=>fs.appendFileSync(trace,JSON.stringify({event,utc:new Date().toISOString(),...data})+'\n');
  const fixtures=[];
  const transports=[];
  const children=[];
  const clients=[];
  const injectionHooks=[];
  const provisionHooks=[];
  const stateHooks=[];
  const notifications=[];
  const state={enabled:true, reads:0};
  class Transport extends sdkStdio.StdioClientTransport {
    constructor(params) {
      assert.equal(path.resolve(params.command),path.resolve(process.execPath),'Only owned Node executable');
      assert.equal(path.resolve(params.args[0]),path.join(ownedRoot,'stdio-fixture.cjs'),'Only owned fixture script');
      assert.equal(path.resolve(params.args[1]),ownedRoot,'Declared fixture ownership root');
      owned(params.args[2]); owned(params.cwd);
      super(params); transports.push(this);
    }
    async start() {
      const starting=super.start();
      const child=this._process;
      if (child) {
        const row={child,pid:child.pid,closed:false,command:process.execPath,args:child.spawnargs.slice(1)};
        children.push(row);
        record('owned-child-start',{pid:child.pid,command:process.execPath,args:row.args});
        row.close=new Promise(resolve=>child.once('close',(code,signal)=>{
          row.closed=true; row.code=code; row.signal=signal;
          record('owned-child-close',{pid:row.pid,code,signal}); resolve();
        }));
        child.stdout.on('data',chunk=>record('observed-real-stdout',{pid:row.pid,raw:chunk.toString()}));
        child.stderr.on('data',chunk=>record('observed-real-stderr',{pid:row.pid,raw:chunk.toString()}));
      }
      return starting;
    }
  }
  class Client extends sdkClient.Client {
    constructor(...args) {super(...args);clients.push(this);}
  }
  const workspace={workspaceFolders:[{uri:{fsPath:dir}}]};
  const pathSourceFile=path.join(core,'src/utils/path.ts');
  const pathSource=fs.readFileSync(pathSourceFile,'utf8');
  const pathParsed=ts.createSourceFile(pathSourceFile,pathSource,ts.ScriptTarget.ES2022,true);
  const pathMethods=pathParsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&['arePathsEqual','normalizePath'].includes(node.name?.text));
  assert.equal(pathMethods.length,2);
  const pathExtracted=path.join(dir,'actual-path-methods.ts');
  fs.writeFileSync(pathExtracted,'import * as path from "path"\n'+pathMethods.map(node=>node.getText(pathParsed)).join('\n'));
  const sourcePaths=loadTs(pathExtracted,id=>{assert.equal(id,'path');return path;},record);
  record('source-path-methods',{sourcePath:pathSourceFile,sha256:createHash('sha256').update(pathSource).digest('hex'),
    adapted:'Only actual arePathsEqual and normalizePath functions extracted; actual host platform and node:path; workspace selection stays an owned adapter'});
  class Emitter {constructor(){this.event=()=>({dispose(){}});} fire(){record('server-change');} dispose(){}}
  const vscode={workspace,EventEmitter:Emitter,window:{showErrorMessage:()=>{},showInformationMessage:()=>{},showWarningMessage:()=>{}},Disposable:{from:()=>({dispose(){}})}};
  const safeFs={...require('node:fs/promises')};
  for (const method of ['readFile','writeFile','mkdir','access','lstat','rm','unlink','stat','rename']) {
    safeFs[method]=async (file,...args)=>{
      owned(file);
      if(method==='rename') owned(args[0]);
      return require('node:fs/promises')[method](file,...args);
    };
  }
  const modules={
    'fs/promises':safeFs,'path':path,'node:crypto':require('node:crypto'),'vscode':vscode,
    '@modelcontextprotocol/sdk/client/index.js':{Client},
    '@modelcontextprotocol/sdk/client/stdio.js':{...sdkStdio,StdioClientTransport:Transport},
    '@modelcontextprotocol/sdk/client/auth.js':sdkAuth,'@modelcontextprotocol/sdk/types.js':sdkTypes,
    '@modelcontextprotocol/sdk/client/sse.js':{SSEClientTransport:class {constructor(){throw new Error('Network forbidden');}}},
    '@modelcontextprotocol/sdk/client/streamableHttp.js':{StreamableHTTPClientTransport:class {constructor(){throw new Error('Network forbidden');}}},
    'reconnecting-eventsource':class {},'chokidar':{watch(){throw new Error('Unexpected physical watcher');}},
    'delay':milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)),
    'fast-deep-equal':req('fast-deep-equal'),'zod':req('zod'),
    'undici':{Agent:class {},fetch:()=>{throw new Error('Network forbidden');}},
    '../../i18n':{t:key=>key},'../../core/webview/ClineProvider':{ClineProvider:{getAllInstances:()=>[]}},
    '../../shared/globalFileNames':{GlobalFileNames:{mcpSettings:'mcp.json'}},
    '../../utils/fs':{fileExistsAtPath:async file=>fs.existsSync(owned(file))},
    './constants':loadTs(path.join(core,'src/services/mcp/constants.ts'),()=>{throw new Error('Unexpected constants import');},record),
    './SecretStorageService':{SecretStorageService:class {}},'./McpOAuthClientProvider':{McpOAuthClientProvider:class {}},
    '../../utils/path':{arePathsEqual:sourcePaths.arePathsEqual,getWorkspacePath:()=>dir},
    '../../utils/config':{injectVariables:async config=>{
      record('inject-config',{label:config.args?.[3]});
      if(injectionHooks.length) await injectionHooks.shift()(config);
      return structuredClone(config);
    }},
    '../../utils/safeWriteJson':{safeWriteJson:async(file,data)=>fs.writeFileSync(owned(file),JSON.stringify(data,null,2))},
    '../../utils/mcp-name':loadTs(path.join(core,'src/utils/mcp-name.ts'),()=>{throw new Error('Unexpected name import');},record),
    '../environments':{getSharedEnvironmentProvisioner:()=>({ensureForExecutable:async()=>{
      record('provision-noop'); if(provisionHooks.length) await provisionHooks.shift()();
    }})},
    '../environments/tools':{getSystemToolDirectory:()=>undefined},
    '../environments/ProjectToolCopies':{ProjectToolCopies:class {async dispose(){record('project-copy-dispose-noop');}}},
  };
  const loaded=loadTs(sourcePath,id=>{
    if (!(id in modules)) throw new Error('Unapproved Source import: '+id);
    return modules[id];
  },record,path.join(dir,'actual-transpiled-McpHub.cjs'));
  const {McpHub,ServerConfigSchema}=loaded;
  for (const method of ['watchMcpSettingsFile','watchProjectMcpFile','initializeGlobalMcpServers','initializeProjectMcpServers'])
    McpHub.prototype[method]=async()=>{};
  McpHub.prototype.setupWorkspaceFoldersWatcher=()=>{};
  const configs={global:{},project:{}};
  const settings={global:path.join(dir,'global.json'),project:path.join(dir,'project.json')};
  function save() {for(const source of ['global','project']) fs.writeFileSync(settings[source],JSON.stringify({mcpServers:configs[source]},null,2));}
  save();
  McpHub.prototype.getMcpSettingsFilePath=async()=>settings.global;
  McpHub.prototype.getProjectMcpPath=async()=>settings.project;
  const provider={cwd:dir,context:{extension:{packageJSON:{version:'owned-test'}}},
    getState:async()=>{
      state.reads++; record('provider-state-read',{enabled:state.enabled,read:state.reads});
      if(stateHooks.length) return stateHooks.shift()();
      return {mcpEnabled:state.enabled};
    }};
  provider.contextProxy={setValue:async(key,value)=>{
    assert.equal(key,'mcpEnabled','Only the isolated MCP enabled setting');
    state.enabled=value;record('owned-settings-persist',{enabled:value});
  }};
  provider.postStateToWebview=async()=>{record('owned-post-state-noop');};
  const hub=new McpHub(provider);
  await hub.waitUntilReady();
  function config(label, gate) {
    const log=path.join(dir,label+'.fixture.jsonl');
    const args=[path.join(ownedRoot,'stdio-fixture.cjs'),ownedRoot,log,label];
    if(gate) args.push(owned(gate));
    const value=ServerConfigSchema.parse({type:'stdio',command:process.execPath,args,cwd:dir,timeout:2});
    fixtures.push({label,log,config:value});
    return value;
  }
  async function connect(label,source='global',gate) {
    const value=config(label,gate);configs[source].fixture=value;save();
    await hub.connectToServer('fixture',value,source);
    return hub.findConnection('fixture',source);
  }
  const allEvents=()=>fixtures.flatMap(item=>events(item.log));
  const executions=()=>allEvents().filter(event=>event.event==='executed');
  async function cleanup() {
    const errors=[];
    try {await hub.dispose();} catch(error){errors.push(error.message);}
    for (const transport of transports) {try {await transport.close();}catch(error){errors.push(error.message);}}
    for (const client of clients) {try {await client.close();}catch(error){errors.push(error.message);}}
    for (const row of children) {
      try {await until(()=>row.closed,'owned child close '+row.pid,4500);}catch(error){errors.push(error.message);}
    }
    const witness={children:children.map(row=>({pid:row.pid,closed:row.closed,code:row.code,signal:row.signal})),
      liveChildren:children.filter(row=>!row.closed).length,errors,connections:hub.connections.length,
      attemptKeys:[...hub.connectionAttempts.keys()],startupKeys:[...hub.startupConnections],
      watcherCount:hub.fileWatchers.size,debounceTimerCount:hub.configChangeDebounceTimers.size,
      oauthWatcherCount:hub._oauthWatchers.size};
    fs.writeFileSync(path.join(dir,'cleanup.json'),JSON.stringify(witness,null,2)+'\n');
    assert.equal(witness.liveChildren,0,'No owned child may remain live');
    assert.equal(errors.length,0,'All finally closes must succeed');
    assert.equal(witness.connections,0,'Disposed connections empty');
    return witness;
  }
  function toolHub() {
    return loadTs(path.join(core,'src/services/workbench-mcp/toolHub.ts'),id=>{
      if(id==='node:path')return path;
      if(id==='node:fs/promises')return safeFs;
      throw new Error('Unapproved consumer import: '+id);
    },record).createToolHub({getMcpHub:()=>hub,getSkillsManager:()=>undefined,getModes:async()=>[],
      getNativeTools:()=>[],invokeNativeTool:()=>{throw new Error('Native forbidden');},isTrustedMcpServer:()=>false});
  }
  async function dispatchUpdateSettings(enabled) {
    const sibling=path.resolve(path.dirname(sourcePath),'../../core/webview/webviewMessageHandler.ts');
    const handlerPath=fs.existsSync(sibling)?sibling:path.join(core,'src/core/webview/webviewMessageHandler.ts');
    const full=fs.readFileSync(handlerPath,'utf8');
    const parsed=ts.createSourceFile(handlerPath,full,ts.ScriptTarget.ES2022,true);
    let selected;
    function visit(node) {
      if(ts.isCaseClause(node)&&ts.isStringLiteral(node.expression)&&node.expression.text==='updateSettings') selected=node;
      ts.forEachChild(node,visit);
    }
    visit(parsed);assert.ok(selected,'Real updateSettings case must exist');
    const caseLiteral=selected.getText(parsed);
    const extracted=path.join(dir,'actual-updateSettings-case.ts');
    fs.writeFileSync(extracted,'export async function dispatch(provider: any, message: any) { switch (message.type) {\n'+caseLiteral+'\n} }\n');
    record('source-case-extracted',{handlerPath,handlerSHA256:createHash('sha256').update(full).digest('hex'),
      caseSHA256:createHash('sha256').update(caseLiteral).digest('hex'),
      adapted:'Unmodified complete updateSettings case in an isolated switch; only mcpEnabled key; provider/ContextProxy/UI are owned state adapters; no actual UI, Native or permission operation'});
    provider.getMcpHub=()=>hub;
    await loadTs(extracted,()=>{throw new Error('Unexpected consumer import');},record).dispatch(provider,{type:'updateSettings',updatedSettings:{mcpEnabled:enabled}});
  }
  record('adaptation',{sourcePath,sourceSHA256:createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
    real:'Source full class, config schema, retry/dedupe, create/delete, callTool, fetch lists, config toggle/update, dispose; installed SDK Client/Stdio/schema and real Node pipes',
    adapted:'VSCode/provider/initialization/path selectors/UI emitter, injectVariables identity and deliberate pause hooks, provisioner no-op, network imports fail closed, SecretStorage unused'});
  return {hub,McpHub,provider,workspace,state,stateHooks,injectionHooks,provisionHooks,config,connect,configs,save,settings,fixtures,transports,children,clients,
    allEvents,executions,cleanup,record,dir,toolHub,dispatchUpdateSettings};
}
module.exports={ownedRoot,core,req,owned,setup,until,deferred,events,loadTs};
