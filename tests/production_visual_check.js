"use strict";
// An isolated Chrome process renders only localhost synthetic accounts, never a user's session.
const fs=require("fs"),path=require("path"),os=require("os"),{spawn}=require("child_process"),{start}=require("./production_ui_fixture");
async function check({browser=process.env.CHROME_PATH||"C:/Program Files/Google/Chrome/Application/chrome.exe",directory=path.resolve(".audit/production-visual")}={}){
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
  const go=async name=>{await evaluate("document.querySelector('[data-page="+name+"]').click()");await until("!document.querySelector('#page-"+name+"').hidden");};
  const fit=async()=>{
   const n=JSON.parse(await evaluate("JSON.stringify({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,main:document.querySelector('main').getBoundingClientRect().width})"));
   if(n.scroll>n.client||n.main>n.client)throw Error("Horizontal overflow: "+JSON.stringify(n));return n;
  };
  const screenshot=async name=>{const shot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});fs.writeFileSync(path.join(directory,name+".png"),Buffer.from(shot.data,"base64"));};
  for(const [width,height] of [[1920,1080],[1600,900],[1440,900],[1366,768],[390,844],[375,812]]){
   await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<800});
   for(const count of [64,100,150]){
    await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?count="+count+"#trading"});
    await until("document.querySelectorAll('#deskAccounts .account-select').length==="+count+" && document.querySelector('#deskEquity').textContent.includes('10,140.35')");
    await until("document.querySelector('#deskOpenPrice').textContent==='2,530' && document.querySelector('#deskAddPrice').textContent==='2,470.15' && document.querySelector('#deskAddAmount').textContent.includes('200')");
    const n=await fit();if(count===64)await screenshot(width+"x"+height+"-trading");
    if(width>=1600&&!await evaluate("document.querySelector('.control-row').getBoundingClientRect().bottom<=innerHeight"))throw Error("Trading controls should fit in the first large desktop screen");
    if(width<=760)await evaluate("document.querySelector('#toggleAccounts').click()");
    const rail=JSON.parse(await evaluate("JSON.stringify({height:document.querySelector('#accountRail').getBoundingClientRect().height,minCardHeight:Math.min(...Array.from(document.querySelectorAll('#deskAccounts .account-select')).map(n=>n.getBoundingClientRect().height)),listHeight:document.querySelector('#deskAccounts').clientHeight,listScroll:document.querySelector('#deskAccounts').scrollHeight,overlap:Array.from(document.querySelectorAll('#deskAccounts .account-select')).some(n=>n.children[0].getBoundingClientRect().bottom>n.children[1].getBoundingClientRect().top||n.children[1].getBoundingClientRect().bottom>n.children[2].getBoundingClientRect().top)})"));
    if(rail.minCardHeight<90||rail.listScroll<=rail.listHeight||rail.overlap||rail.height>height+1)throw Error("Account rail compressed/overlapping: "+JSON.stringify(rail));
    if(width<=760){await fit();await evaluate("document.querySelector('#railBackdrop').click()");}
    results.push({width,height,count,page:"trading",...n,...rail});
    await go("parameters");await fit();
    const locked=await evaluate("Array.from(document.querySelectorAll('#deskSettings input,#deskSettings select')).every(n=>n.disabled) && document.querySelector('#deskConfigHint').textContent.includes('当前有模拟持仓')");
    if(!locked)throw Error("Position settings must remain locked");
    if(count===64)await screenshot(width+"x"+height+"-parameters-locked");
    results.push({width,height,count,page:"parameters",locked:true,...await fit()});
    await go("accounts");await until("document.querySelector('#connectionFormTitle').textContent.includes('经典模拟')");await fit();
    if(!await evaluate("document.querySelector('#connectionForm [name=apiSecret]').value==='' && document.querySelector('#connectionForm [name=apiSecret]').placeholder.includes('已配置')"))throw Error("Credentials should be blank with configured placeholder");
    if(count===64)await screenshot(width+"x"+height+"-accounts");
    results.push({width,height,count,page:"accounts",...await fit()});
    await go("trading");
   }
   if(width<=760)await evaluate("document.querySelector('#toggleAccounts').click()");
   await evaluate("document.querySelector('[data-filter=running]').click()");await until("document.querySelectorAll('#deskAccounts .account-select').length===1");
   await evaluate("document.querySelector('[data-filter=all]').click();const search=document.querySelector('#deskSearch');search.value='超长';search.dispatchEvent(new Event('input'));");await until("document.querySelectorAll('#deskAccounts .account-select').length===1");
   await evaluate("document.querySelector('#deskAccounts .account-select').click()");await until("document.querySelector('#deskAccount').textContent.startsWith('超长')&&!document.querySelector('#deskSave').disabled");
   if(width<=760&&!await evaluate("!document.body.classList.contains('rail-open')"))throw Error("Drawer did not close after account selection");
   await go("parameters");await fit();
   for(const key of ["side","leverage","baseAmount","addAmount","maxAdds","addTrigger","takeProfit"]){
    await evaluate("document.querySelector('#deskSettings [name="+key+"]').scrollIntoView({block:'center'})");
    if(!await evaluate("(()=>{const n=document.querySelector('#deskSettings [name="+key+"]'),r=n.getBoundingClientRect(),p=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return n===p||n.contains(p);})()"))throw Error("Parameter input is obstructed: "+key);
   }
   await evaluate("const f=document.querySelector('#deskSettings');f.elements.baseAmount.value='777';f.elements.side.value='short';f.elements.addTrigger.value='1.5';f.elements.takeProfit.value='3.25';f.dispatchEvent(new Event('input',{bubbles:true}));");
   await until("document.querySelector('#previewNotional').textContent.includes('1,377') && !document.querySelector('#parameterDirty').hidden");
   await go("trading");await go("parameters");
   await evaluate("document.querySelector('#deskRefresh').click()");
   if(!await evaluate("document.querySelector('#deskSettings [name=baseAmount]').value==='777'"))throw Error("Navigation discarded the draft");
   await evaluate("window.confirm=()=>false;const selector=document.querySelector('#connectionSwitcher');selector.value='sample-0';selector.dispatchEvent(new Event('change'));");
   await until("document.querySelector('#connectionSwitcher').value==='sample-1' && document.querySelector('#deskSettings [name=baseAmount]').value==='777'");
   await evaluate("document.querySelector('#deskSave').scrollIntoView({block:'center'})");
   if(!await evaluate("(()=>{const n=document.querySelector('#deskSave'),r=n.getBoundingClientRect(),p=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return n===p||n.contains(p);})()"))throw Error("Save button is obstructed");
   await evaluate("document.querySelector('#deskSave').click()");
   await until("document.querySelector('#deskMessage').textContent.includes('经典参数已保存') && document.querySelector('#parameterDirty').hidden && !document.querySelector('#deskSave').disabled");
   const submitted=server.submissions.at(-1);
   if(submitted.id!=="sample-1"||submitted.settings.addTrigger!==.015||submitted.settings.takeProfit!==.0325||submitted.settings.baseAmount!==777||submitted.settings.side!=="short")throw Error("Incorrect account or percentage submitted: "+JSON.stringify(submitted));
   await evaluate("scrollTo(0,0)");await screenshot(width+"x"+height+"-parameters-editable");
   await go("trading");if(!await evaluate("document.querySelector('#deskRun').textContent==='已暂停'"))throw Error("Saving parameters auto-started account");
   await go("accounts");await evaluate("document.querySelector('#connectionForm [name=name]').value='未保存账户草稿';document.querySelector('#connectionForm').dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>false;");
   await evaluate("document.querySelector('[data-page=parameters]').click()");if(!await evaluate("!document.querySelector('#page-accounts').hidden"))throw Error("Unsaved connection was lost");
   await evaluate("window.confirm=()=>true;document.querySelector('[data-page=parameters]').click()");await until("!document.querySelector('#page-parameters').hidden");
   await go("accounts");await evaluate("document.querySelector('#newConnection').click()");
   if(!await evaluate("!document.querySelector('#connectionForm [name=platform]').disabled && !document.querySelector('#connectionEquityLabel').hidden"))throw Error("New account form unavailable");
   results.push({width,height,scenario:"core-interactions",accountSwitch:true,draftPreserved:true,savePercentCorrect:true,autoStart:false,newAccount:true});
   await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?count=64&scenario=settings#parameters"});
   await until("!document.querySelector('#deskSave').disabled && document.querySelector('#deskAccount').textContent==='经典模拟 · ETH'");
   await screenshot(width+"x"+height+"-parameters");
   await go("accounts");await evaluate("document.querySelector('#connectionToSettings').click()");await until("!document.querySelector('#page-parameters').hidden && !document.querySelector('#deskSaveTop').disabled");
  }
  await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=save-failed#parameters"});
  await until("!document.querySelector('#deskSave').disabled");await evaluate("const input=document.querySelector('#deskSettings [name=baseAmount]');input.value='888';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#deskSave').click()");
  await until("document.querySelector('#deskMessage').textContent.includes('合成保存失败')");
  if(!await evaluate("document.querySelector('#deskSettings [name=baseAmount]').value==='888' && !document.querySelector('#parameterDirty').hidden && !document.querySelector('#deskSave').disabled"))throw Error("Failed save destroyed draft");
  results.push({scenario:"save-failed",draftPreserved:true});
  await evaluate("window.JustSettingsPreview=undefined;document.querySelector('#deskSettings').dispatchEvent(new Event('input',{bubbles:true}))");
  if(!await evaluate("!document.querySelector('#deskSaveTop').disabled && document.querySelector('#deskSettings [name=baseAmount]').value==='888'"))throw Error("Preview module failure should not hide settings");
  results.push({scenario:"preview-module-failure",settingsUsable:true});
  await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=readonly#parameters"});await until("!document.querySelector('#deskConfigChoice').hidden && !document.querySelector('#deskUseClassicAccount').disabled");
  if(!await evaluate("document.querySelector('#deskSave').disabled && document.querySelector('#deskConfigHint').textContent.includes('只读')"))throw Error("Archived account should be clearly read-only");
  await evaluate("document.querySelector('#deskUseClassicAccount').click()");await until("document.querySelector('#deskAccount').textContent.startsWith('超长') && !document.querySelector('#deskSave').disabled");
  if(server.submissions.length)throw Error("Selecting an editable account must not configure or start it");
  results.push({scenario:"readonly-account-recovery",explicitSwitchOnly:true,noAutoConfig:true});
  await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=offline#parameters"});await until("document.querySelector('#deskMessage').textContent.includes('合成行情断流')");
  if(!await evaluate("Array.from(document.querySelectorAll('[data-action]')).every(n=>n.disabled)&&document.querySelector('#deskSave').disabled"))throw Error("Offline controls not locked");
  results.push({scenario:"offline",controlsDisabled:true});
  for(const [width,height] of [[1600,900],[390,844]]){
   await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<800});
   await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=editable&width="+width+"#trading"});await until("!document.querySelector('#deskSave').disabled && document.querySelector('.production-summary .text-button')!==null");
   await evaluate("document.querySelector('.production-summary .text-button').click()");await until("document.querySelector('.production-parameter-drawer').open");await fit();await screenshot(width+"-drawer");
   await evaluate("const f=document.querySelector('#deskSettings');f.elements.baseAmount.value='777';f.dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>false;document.querySelector('.production-parameter-drawer .dialog-head button').click()");
   if(!await evaluate("document.querySelector('.production-parameter-drawer').open"))throw Error("Drawer lost unsaved draft");
   await evaluate("document.querySelector('#deskSave').click()");await until("!document.querySelector('.production-parameter-drawer').open && document.querySelector('#deskSettings').elements.baseAmount.value==='777'");
   results.push({scenario:'production-parameter-drawer',width,height,saved:true,draftGuard:true,...await fit()});
  }
  fs.writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2));return results;
 }finally{if(ws)ws.close();child.kill();await new Promise(r=>server.close(r));}
}
if(require.main===module)check().then(result=>console.log(JSON.stringify({passed:result.length,failed:0,minCardHeight:Math.min(...result.filter(r=>r.minCardHeight).map(r=>r.minCardHeight)),horizontalOverflow:result.some(r=>r.scroll>r.client),overlap:result.some(r=>r.overlap)}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={check};
