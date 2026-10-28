const fs = require('node:fs');
(async()=>{
  const {webSocketDebuggerUrl}=await (await fetch('http://127.0.0.1:9337/json/version')).json();
  const ws=new WebSocket(webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0; const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,sessionId}));});
  try {
    const {targetInfos}=await send('Target.getTargets');
    for(const t of targetInfos.filter(t=>t.type==='iframe')){
      const {sessionId}=await send('Target.attachToTarget',{targetId:t.targetId,flatten:true});
      const expression=process.argv[2]?fs.readFileSync(process.argv[2],'utf8'):`JSON.stringify(Array.from(document.querySelectorAll('iframe')).map(f=>({id:f.id,src:f.src,buttons:Array.from(f.contentDocument?.querySelectorAll('button,[role=button]')||[]).map(b=>({text:b.textContent?.slice(0,50),label:b.getAttribute('aria-label'),title:b.title}))})))`;
      const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
      console.log(JSON.stringify({target:t.targetId,result}));
      await send('Target.detachFromTarget',{sessionId});
    }
  } finally {ws.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
