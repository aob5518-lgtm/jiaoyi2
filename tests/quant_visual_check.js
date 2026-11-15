"use strict";
// An isolated Chrome process renders only localhost synthetic accounts, never a user's session.
const fs=require("fs"),path=require("path"),os=require("os"),{spawn}=require("child_process"),{start}=require("./quant_ui_fixture");
async function check({browser=process.env.CHROME_PATH||"C:/Program Files/Google/Chrome/Application/chrome.exe",directory=path.resolve(".audit/quant-core-visual")}={}){
 fs.mkdirSync(directory,{recursive:true});const profile=fs.mkdtempSync(path.join(os.tmpdir(),"just-core-render-")),server=start(0);
 await new Promise(r=>server.listening?r():server.once("listening",r));const port=server.address().port;
 const child=spawn(browser,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--user-data-dir="+profile,"about:blank"],{stdio:"ignore",windowsHide:true});
 let ws;
 try{
  let debug;for(let n=0;n<100;n++){const f=path.join(profile,"DevToolsActivePort");if(fs.existsSync(f)){debug=Number(fs.readFileSync(f,"utf8").split("\n")[0]);break;}await new Promise(r=>setTimeout(r,50));}
  if(!debug)throw Error("Isolated renderer failed to start");
  const pages=await(await fetch("http://127.0.0.1:"+debug+"/json/list")).json(),page=pages.find(x=>x.type==="page");
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
  ws.onmessage=event=>{const v=JSON.parse(event.data);if(v.id){const p=pending.get(v.id);if(p){clearTimeout(p.timer);pending.delete(v.id);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error("Renderer timeout: "+method));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  await call("Page.enable");const results=[];
  const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression:"(()=>eval("+JSON.stringify(expression)+"))()",returnByValue:true});if(r.exceptionDetails)throw Error("Browser evaluation failed: "+JSON.stringify(r.exceptionDetails));return r.result.value;};
  async function until(expression){for(let n=0;n<120;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,40));}throw Error("UI did not settle: "+expression+" "+await evaluate("document.querySelector('#deskMessage')?.textContent"));}
  const click=selector=>evaluate("document.querySelector("+JSON.stringify(selector)+").click()");
  const openParameter=async()=>{await click("#deskEditShortcut");await until("document.querySelector('#page-parameters').open");};
  const openAccounts=async()=>{await click("#openConnections");await until("document.querySelector('#page-accounts').open");};
  const dismiss=page=>click('[data-dismiss="'+page+'"]');
  const fit=async()=>{
   const n=JSON.parse(await evaluate("JSON.stringify({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,main:document.querySelector('main').getBoundingClientRect().width})"));
   if(n.scroll>n.client||n.main>n.client)throw Error("Horizontal overflow: "+JSON.stringify(n));return n;
  };
  const fitDialogs=async()=>{
   const dialogs=await evaluate("Array.from(document.querySelectorAll('dialog[open]')).map(d=>({id:d.id,scroll:d.scrollWidth,client:d.clientWidth}))");
   if(dialogs.some(d=>d.scroll>d.client+1))throw Error("Dialog overflow: "+JSON.stringify(dialogs));
  };
  const screenshot=async name=>{const shot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});fs.writeFileSync(path.join(directory,name+".png"),Buffer.from(shot.data,"base64"));};
  for(const [width,height] of [[1920,1080],[1600,900],[1440,900],[1366,768],[390,844],[375,812]]){
   await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<800});
   for(const count of [64,100,150]){
    await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?count="+count+"#trading"});
    await until("document.querySelectorAll('#deskAccounts .account-select').length==="+count+" && document.querySelector('#deskEquity').textContent.includes('10,140.35')");
    await until("document.querySelector('#deskOpenPrice').textContent==='2,530' && document.querySelector('#deskAddPrice').textContent==='2,470.15' && document.querySelector('#deskAddAmount').textContent.includes('200')");
    const n=await fit();if(count===64)await screenshot(width+"x"+height+"-trading");
    if(!await evaluate("document.querySelector('#deskPrimaryAction').getBoundingClientRect().bottom<=innerHeight"))throw Error("Primary actions must fit the first screen");
    if(width<=760)await click("#toggleAccounts");
    const rail=await evaluate("({height:document.querySelector('#accountRail').getBoundingClientRect().height,minCardHeight:Math.min(...Array.from(document.querySelectorAll('#deskAccounts .account-select')).map(n=>n.getBoundingClientRect().height)),listHeight:document.querySelector('#deskAccounts').clientHeight,listScroll:document.querySelector('#deskAccounts').scrollHeight,overlap:Array.from(document.querySelectorAll('#deskAccounts .account-select')).some(n=>n.children[0].getBoundingClientRect().bottom>n.children[1].getBoundingClientRect().top||n.children[1].getBoundingClientRect().bottom>n.children[2].getBoundingClientRect().top)})");
    if(rail.minCardHeight<90||rail.listScroll<=rail.listHeight||rail.overlap||rail.height>height+1)throw Error("Account rail compressed/overlapping: "+JSON.stringify(rail));
    if(width<=760){await fit();await click("#railBackdrop");}
    results.push({width,height,count,page:"trading",...n,...rail});
    await openParameter();await fit();
    const locked=await evaluate("Array.from(document.querySelectorAll('#deskSettings input,#deskSettings select')).every(n=>n.disabled) && document.querySelector('#deskConfigHint').textContent.includes('当前有模拟持仓')");
    if(!locked)throw Error("Position settings must remain locked");
    await dismiss("parameters");
    results.push({width,height,count,page:"parameters-drawer",locked:true,...await fit()});
   }
   await openAccounts();
   await until("document.querySelector('#connectionFormTitle').textContent.includes('经典模拟')");
   if(!await evaluate("document.querySelector('#connectionForm [name=apiSecret]').value==='' && document.querySelector('#connectionForm [name=apiSecret]').placeholder.includes('已配置') && !document.querySelector('.connection-credentials').open"))throw Error("Credentials should be blank, collapsed and indicated as configured");
   await dismiss("accounts");
   if(width<=760)await click("#toggleAccounts");
   await click('[data-filter="running"]');await until("document.querySelectorAll('#deskAccounts .account-select').length===1");
   await click('[data-filter="all"]');
   await evaluate("const search=document.querySelector('#deskSearch');search.value='超长';search.dispatchEvent(new Event('input'));");
   await until("document.querySelectorAll('#deskAccounts .account-select').length===1");
   await click("#deskAccounts .account-select");
   await until("document.querySelector('#deskAccount').textContent.startsWith('超长') && document.querySelector('#deskPrimaryAction').textContent==='配置并启动'");
   await click("#deskPrimaryAction");await until("document.querySelector('#page-parameters').open");
   await fitDialogs();
   await evaluate("const f=document.querySelector('#deskSettings');f.elements.baseAmount.value='777';f.elements.side.value='short';f.elements.addTrigger.value='1.5';f.elements.takeProfit.value='3.25';f.dispatchEvent(new Event('input',{bubbles:true}));");
   await until("document.querySelector('#previewNotional').textContent.includes('1,377') && !document.querySelector('#parameterDirty').hidden");
   await screenshot(width+"x"+height+"-parameters");
   await dismiss("parameters");await click("#deskPrimaryAction");
   await until("document.querySelector('#deskSettings [name=baseAmount]').value==='777'");
   await click("#deskSaveTop");
   await until("!document.querySelector('#page-parameters').open && document.querySelector('#deskPrimaryAction').textContent==='暂停新增'");
   const submitted=server.submissions.at(-1);
   if(submitted.id!=="sample-1"||submitted.settings.addTrigger!==.015||submitted.settings.takeProfit!==.0325||submitted.settings.baseAmount!==777||submitted.settings.side!=="short")throw Error("Saving changed the wrong account or parameters");
   await screenshot(width+"x"+height+"-start");
   if(server.controls.length!==1||server.controls[0].id!=="sample-1"||server.controls[0].action!=="start")throw Error("Start did not target the checked account");
   const samePage=await evaluate("location.pathname==='/' && location.hash==='' && !document.querySelector('#page-trading').hidden");
   if(!samePage)throw Error("Classic setup switched pages");
   results.push({width,height,scenario:"classic-save-and-start-stays-on-workbench",...await fit()});
   await openAccounts();
   await evaluate("document.querySelector('#connectionForm [name=name]').value='未保存账户草稿';document.querySelector('#connectionForm').dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>false;");
   await dismiss("accounts");
   if(!await evaluate("document.querySelector('#page-accounts').open"))throw Error("Unsaved connection was lost");
   await evaluate("window.confirm=()=>true");await dismiss("accounts");
   await openAccounts();await click("#newConnection");
   await evaluate("const f=document.querySelector('#connectionForm');f.elements.name.value='新经典模拟账户';f.elements.platform.value='binance';f.requestSubmit();");
   await until("document.querySelector('#page-parameters').open && document.querySelector('#deskAccount').textContent==='新经典模拟账户'");
   if(server.controls.length!==1)throw Error("Account creation started trading");
   await dismiss("parameters");
   results.push({width,height,scenario:"create-classic-direct-to-parameters",...await fit()});
   await click('[data-strategy="turtle"]');
   await until("document.querySelector('#deskTurtlePane').shadowRoot?.querySelector('#empty')?.hidden===false");
   await click("#deskPrimaryAction");
   await evaluate("document.querySelector('#deskTurtlePane').shadowRoot.querySelector('#create-form').requestSubmit()");
   await until("document.querySelector('#deskAccount').textContent==='海龟 4H · ETH Paper' && document.querySelector('#deskTurtlePane').shadowRoot.querySelector('#desk')?.hidden===false");
   await until("document.querySelector('#deskPrimaryAction').textContent==='启动模拟' && !document.querySelector('#deskPrimaryAction').disabled");
   if(!await evaluate("document.querySelector('#deskAccountPicker').options.length===1 && document.querySelector('#deskAccountPicker').value==='new-turtle'"))throw Error("Turtle picker includes unrelated accounts");
   if(server.controls.length!==1)throw Error("New Turtle account started without user action");
   await click("#deskEditShortcut");
   await until("document.querySelector('#deskTurtlePane').shadowRoot.querySelector('#parameters').open && !document.querySelector('#page-parameters').open");
   await evaluate("document.querySelector('#deskTurtlePane').shadowRoot.querySelector('#cancel-edit').click()");
   await click("#deskPrimaryAction");
   await until("document.querySelector('#deskTurtlePane').shadowRoot.querySelector('#run')?.textContent.includes('RUNNING')");
   if(server.controls.at(-1)?.id!=="new-turtle"||server.controls.at(-1)?.confirm!==true)throw Error("Turtle start did not target the confirmed account");
   if(!await evaluate("location.pathname==='/' && document.querySelector('#page-trading').hidden && !document.querySelector('#deskTurtlePane').hidden"))throw Error("Turtle setup switched pages");
   await screenshot(width+"x"+height+"-turtle");
   await click('[data-strategy="classic"]');
   await until("document.querySelector('#deskAccount').textContent==='新经典模拟账户' && document.querySelector('#deskTurtlePane').hidden");
   await click("#deskEditShortcut");await until("document.querySelector('#page-parameters').open");
   await dismiss("parameters");
   await click('[data-strategy="turtle"]');
   await until("document.querySelector('#deskPrimaryAction').textContent==='暂停新增' && document.querySelector('#deskAccountPicker').value==='new-turtle'");
   if(server.controls.length!==2)throw Error("Strategy switching sent an order control");
   results.push({width,height,scenario:"switch-strategy-edit-matching-parameters-and-direct-start",...await fit()});
  }
  await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=save-failed#parameters"});
  await until("document.querySelector('#page-parameters').open && !document.querySelector('#deskSave').disabled");
  await evaluate("const input=document.querySelector('#deskSettings [name=baseAmount]');input.value='888';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#deskSaveTop').click()");
  await until("document.querySelector('#deskConfigError').textContent.includes('合成保存失败')");
  if(!await evaluate("document.querySelector('#page-parameters').open && document.querySelector('#deskSettings [name=baseAmount]').value==='888'")||server.controls.length)throw Error("Failed save lost draft or advanced to start");
  results.push({scenario:"save-failed",draftPreserved:true});
  await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=readonly"});
  await until("document.querySelector('#deskAccount').textContent.startsWith('超长') && document.querySelector('#deskPrimaryAction').textContent==='配置并启动'");
  if(await evaluate("Array.from(document.querySelector('#deskAccountPicker').options).some(o=>o.value==='sample-0')"))throw Error("Read-only account leaked into strategy picker");
  await click('[data-strategy="history"]');
  await until("document.querySelector('#deskRun').textContent==='只读'");
  if(!await evaluate("document.querySelector('#deskRun').textContent==='只读' && document.querySelector('[data-action=start]').hidden && document.querySelector('.price-cards').hidden"))throw Error("Archived account must not show start or classic estimates");
  await screenshot("readonly");
  await click('[data-strategy="classic"]');await until("document.querySelector('#deskAccount').textContent.startsWith('超长')");
  if(server.submissions.length||server.controls.length)throw Error("Selecting an editable account must not configure or start it");
  results.push({scenario:"readonly-account-recovery",explicitSwitchOnly:true,noAutoConfig:true});
  await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=blocked"});
  await until("document.querySelector('#deskPrimaryAction').textContent==='启动模拟'");
  await click("#deskPrimaryAction");
  await until("document.querySelector('#deskMessage').textContent.includes('报价暂不可用')");
  if(!await evaluate("document.querySelector('#deskRun').textContent==='已暂停'")||server.controls.length)throw Error("Blocked account must not be started");
  results.push({scenario:"preflight-blocked",startDisabled:true});
  await openParameter();
  await evaluate("const f=document.querySelector('#deskSettings');f.elements.baseAmount.value='560';f.dispatchEvent(new Event('input',{bubbles:true}));");
  await click("#deskSave");
  await until("!document.querySelector('#page-parameters').open && document.querySelector('#deskMessage').textContent.includes('已保存')");
  if(server.controls.length||server.submissions.at(-1)?.settings.baseAmount!==560)throw Error("Save-only triggered a start or saved incorrect parameters");
  results.push({scenario:"save-only",startRequests:0});
  fs.writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2));return results;
 }finally{if(ws)ws.close();child.kill();await new Promise(r=>server.close(r));}
}
if(require.main===module)check().then(result=>console.log(JSON.stringify({passed:result.length,failed:0,minCardHeight:Math.min(...result.filter(r=>r.minCardHeight).map(r=>r.minCardHeight)),horizontalOverflow:result.some(r=>r.scroll>r.client),overlap:result.some(r=>r.overlap)}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={check};
