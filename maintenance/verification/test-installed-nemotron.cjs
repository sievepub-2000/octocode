const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root='E:/Program Files/octocode', helper=path.join(__dirname,'webview-cdp-evaluate.cjs');
const run=path.join(root,'test','nemotron-ui-'+Date.now());fs.mkdirSync(run);
const generated=path.join(run,'nemotron-ui-action.js');
const output=path.join(run,'result.json'),anchor='OCTO-NEMOTRON-'+Date.now();
const report={status:'RUNNING',startedAt:new Date().toISOString(),rounds:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
function ui(expression){fs.writeFileSync(generated,expression);return execFileSync(process.execPath,[helper,generated],{encoding:'utf8',windowsHide:true}).trim().split('\n').map(s=>JSON.parse(s)?.result?.result?.value).find(x=>x&&!x.skipped);}
function python(code,args=[]){return JSON.parse(execFileSync(root+'/environments/python/python.exe',['-c',code,...args],{encoding:'utf8',windowsHide:true}));}
function session(){return python(`import sqlite3,json; c=sqlite3.connect('file:E:/Program Files/octocode/data/user-data/User/globalStorage/octocode.octocode/octocode.db?mode=ro',uri=True); r=c.execute("select id from sessions where title like ? order by created_at desc limit 1",('%${anchor}%',)).fetchone(); print(json.dumps(r[0] if r else None))`);}
function snapshot(sid,cursor){return JSON.parse(execFileSync(root+'/environments/python/python.exe',[path.join(__dirname,'read-owned-conversation.py'),sid,String(cursor)],{encoding:'utf8',windowsHide:true}));}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=600000){const end=Date.now()+timeout;while(Date.now()<end){const x=check();if(x)return x;await sleep(1000);}throw Error('Acceptance timeout');}
async function send(prompt){assert(ui(`(()=>{const d=document.querySelector('#active-frame')?.contentDocument;if(!d)return {skipped:true};const e=d.querySelector('textarea');if(!e)return false;Object.getOwnPropertyDescriptor(d.defaultView.HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(prompt)});e.dispatchEvent(new d.defaultView.Event('input',{bubbles:true}));return true;})()`));await sleep(300);assert(ui(`(()=>{const d=document.querySelector('#active-frame')?.contentDocument;if(!d)return {skipped:true};const b=d.querySelector('[data-testid="send-button"]');if(!b||b.disabled||b.getAttribute('aria-label')?.includes('停止'))return false;b.click();return true;})()`),'Send action ready');}
(async()=>{save();try{
 assert(ui(`(()=>{const d=document.querySelector('#active-frame')?.contentDocument;if(!d)return {skipped:true};const b=Array.from(d.querySelectorAll('button')).find(b=>b.textContent.trim()==='新建任务');if(!b)return false;b.click();return true;})()`));
 await sleep(800);
 assert(ui(`(()=>{const d=document.querySelector('#active-frame')?.contentDocument;if(!d)return {skipped:true};return d.querySelector('[data-testid="dropdown-trigger"]')?.textContent.includes('openrouter-nemotron-3-ultra');})()`),'Saved free profile selected');
 const ledger=Array.from({length:400},(_,i)=>`记录 ${i+1}：项目 North-${i+1}，负责人 Team-${i%17}，批次 B${i%29}，基准值 ${1000+i*7}，保留原始记录，先核对再更新。`).join('\n');
 let balance=1000,cursor=0,sid;
 for(let round=1;round<=12;round++){
  const delta=round*13;balance+=delta;
  const common=`本轮为第 ${round} 轮，对余额增加 ${delta}。只进行文字讨论，不调用工具，不读取文件或联网。请用中文给出至少700字的实质分析，选择前文台账中的三条记录交叉比较，说明风险、复核步骤和后续计划。最后以单行 JSON 结束，包含 round（当前轮次）、anchor（首次给定锚点原文）、balance（累计余额整数）。不要省略正文，不要把正文放进思考通道。`;
  const prompt=round===1?`这是隔离的合成长对话验收。锚点是 ${anchor}，初始余额为1000，后续从上轮余额继续计算。请记住以下台账，后续不重发。\n${ledger}\n${common}`:common;
  const started=Date.now();await send(prompt);if(!sid){sid=await until(session,30000);report.sessionId=sid;save();}
  const turn=await until(()=>{const x=snapshot(sid,cursor);if(x.errors.length)throw Error(JSON.stringify(x.errors));return x.finished?x:false;});
  cursor=turn.cursor;assert.equal(turn.finished.success,true);assert(turn.text.length>=700,'Visible answer too short');
  const states=[...turn.text.matchAll(/\{[^{}]*"round"\s*:[^{}]*\}/g)];assert(states.length,'Final state missing');assert.deepEqual(JSON.parse(states.at(-1)[0]),{round,anchor,balance});
  const item={round,elapsedMs:Date.now()-started,visibleCharacters:turn.text.length,usage:turn.usage,balance,anchorRecalled:true};report.rounds.push(item);fs.writeFileSync(path.join(run,`round-${round}.txt`),turn.text);save();console.log(JSON.stringify(item));
 }
 report.status='PASS';report.sameSessionContinuations=11;report.syntheticLedgerCharacters=ledger.length;
}catch(e){report.status='FAIL';report.error=e.message;throw e;}finally{report.finishedAt=new Date().toISOString();save();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
