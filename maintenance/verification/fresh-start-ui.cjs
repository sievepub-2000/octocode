const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('../../desktop-shell/node_modules/playwright');
const {execFileSync}=require('node:child_process');
const appRoot=path.resolve(process.argv[2]),report=path.resolve(process.argv[3]);
assert(appRoot.toLowerCase().startsWith('e:\\octocode-acceptance\\fresh-'));
const keybindings=path.join(appRoot,'data/user-data/User/keybindings.json');
const script=path.join(path.dirname(report),'fresh-view.js');
const exists=fs.existsSync(keybindings),original=exists?fs.readFileSync(keybindings):null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function state(){fs.writeFileSync(script,`(()=>{const d=document.querySelector('#active-frame')?.contentDocument;if(!d)return {skipped:true};const b=d.querySelector('button[aria-label="设置"],button[aria-label="Settings"]'),r=b?.getBoundingClientRect(),s=b&&d.defaultView.getComputedStyle(b);return {ready:!!r&&r.width>0&&r.height>0&&s.visibility==='visible'&&s.display!=='none',hmrError:d.body.textContent.includes('HMR将不起作用')};})()`);const values=execFileSync(process.execPath,[path.join(__dirname,'webview-cdp-evaluate.cjs'),script],{encoding:'utf8',windowsHide:true}).trim().split('\n').map(s=>JSON.parse(s)?.result?.result?.value).filter(v=>v&&!v.skipped);const view=values.find(v=>v.ready)||values[0];return view&&{...view,hmrError:values.some(v=>v.hmrError)};}
(async()=>{let browser,page;try{
 const deadline=Date.now()+180000;let view;
 while(Date.now()<deadline){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9337');page=browser.contexts()[0].pages()[0];if(page)break;}catch{}await sleep(1000);}
 assert(page,'Fresh native window became ready');
 assert(decodeURIComponent(page.url()).toLowerCase().replaceAll('\\','/').includes(appRoot.toLowerCase().replaceAll('\\','/')),'Browser belongs to this fresh installation');
 const notifications=[];
 await page.exposeFunction('__recordStartupNotice',text=>{if(text&&!notifications.includes(text))notifications.push(text);});
 const recordNotifications=()=>{setInterval(()=>{for(const item of document.querySelectorAll('.notifications-toasts .notification-list-item'))void window.__recordStartupNotice(item.textContent);},250);};
 await page.addInitScript(recordNotifications);await page.evaluate(recordNotifications);
 await sleep(15000);
 let trustedOwnedFixture=false;
 if(/受限模式|Restricted Mode/.test(await page.locator('body').innerText())&&!await page.locator('.workspace-trust-editor.trusted').count()){
  fs.mkdirSync(path.dirname(keybindings),{recursive:true});fs.writeFileSync(keybindings,JSON.stringify([{key:'ctrl+alt+shift+m',command:'workbench.trust.manage'},{key:'ctrl+alt+shift+q',command:'workbench.action.quit'}]));
  await sleep(1000);await page.keyboard.press('Control+Alt+Shift+M');
  const trust=page.locator('.workspace-trust-editor .monaco-button').filter({hasText:/^(信任|Trust)$/}).first();
  await trust.waitFor({state:'visible',timeout:15000});
  const logs=path.join(appRoot,'data/user-data/logs');let ownedWorkspace=false;
  function checkLogs(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())checkLogs(file);else if(entry.name==='1-OctoCode.log'&&fs.readFileSync(file,'utf8').toLowerCase().replaceAll('\\','/').includes('[workspace] effective configured workspace: '+path.join(appRoot,'workspace').toLowerCase().replaceAll('\\','/')))ownedWorkspace=true;}}
  checkLogs(logs);assert(ownedWorkspace,'Only trust the newly installed isolated fixture workspace');
  await trust.click();trustedOwnedFixture=true;
 }
 fs.mkdirSync(path.dirname(keybindings),{recursive:true});fs.writeFileSync(keybindings,JSON.stringify([{key:'ctrl+alt+shift+c',command:'octocode.openChatPanel'},{key:'ctrl+alt+shift+q',command:'workbench.action.quit'}]));
 await sleep(2000);const focus=await page.context().newCDPSession(page);await focus.send('Emulation.setFocusEmulationEnabled',{enabled:true});await focus.send('Page.bringToFront');await page.keyboard.press('Control+Alt+Shift+C');
 while(Date.now()<deadline){try{view=await state();if(view?.ready)break;}catch{}await sleep(1000);}
 if(!view?.ready){await page.screenshot({path:report+'.failure.png'});fs.writeFileSync(report+'.diagnostic.json',JSON.stringify({title:await page.title(),body:await page.locator('body').innerText(),frames:page.frames().map(frame=>frame.url()),view},null,2));}
 assert(view?.ready,'Fresh application shell became ready');assert.equal(view.hmrError,false);
 await sleep(15000);
 assert.equal(notifications.length,0,JSON.stringify(notifications));
 for(const frame of page.frames())for(const error of await frame.locator('[data-testid="api-error-message"]').all())assert.equal(await error.isVisible(),false,'Fresh onboarding must not display validation errors before submission');
 const title=await page.title();assert(!title.includes('扩展开发宿主')&&!title.includes('Extension Development Host'));
 await page.screenshot({path:report+'.png'});
 fs.writeFileSync(report,JSON.stringify({status:'PASS',appRoot,title,notifications,hmrError:false,normalLaunch:true,elevatedWindow:/\[(管理员|Administrator)\]/.test(title),trustedOwnedFixture,checkedAt:new Date().toISOString()},null,2));
 console.log(JSON.stringify({status:'PASS',normalLaunch:true,errorNotifications:0}));
}finally{
 if(page){try{fs.mkdirSync(path.dirname(keybindings),{recursive:true});fs.writeFileSync(keybindings,JSON.stringify([{key:'ctrl+alt+shift+q',command:'workbench.action.quit'}]));await sleep(1000);const cdp=await page.context().newCDPSession(page);await cdp.send('Page.bringToFront');await page.keyboard.press('Control+Alt+Shift+Q');}catch{} }
 if(exists)fs.writeFileSync(keybindings,original);else if(fs.existsSync(keybindings))fs.unlinkSync(keybindings);
 if(browser)await browser.close().catch(()=>{});
}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
