"use strict";
// Isolated headless Chrome test of OUR localhost fixture; never attaches to a user browser.
const fs=require("fs"),path=require("path"),os=require("os"),{spawn}=require("child_process"),{start}=require("./quant_ui_fixture");
async function check({browser=process.env.CHROME_PATH||"C:/Program Files/Google/Chrome/Application/chrome.exe",directory=path.resolve(".audit/quant-visual")}={}){
 fs.mkdirSync(directory,{recursive:true});const profile=fs.mkdtempSync(path.join(os.tmpdir(),"h01-render-")),server=start(0);
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
  const evaluate=async expression=>{
   const result=await call("Runtime.evaluate",{expression:"(()=>eval("+JSON.stringify(expression)+"))()",returnByValue:true});
   if(result.exceptionDetails)throw Error("Browser evaluation failed: "+result.exceptionDetails.text);
   return result.result.value;
  };
  async function until(expression){for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,40));}const details=await evaluate("JSON.stringify({name:document.querySelector('#deskAccount')?.textContent,base:document.querySelector('#deskSettings [name=baseAmount]')?.value,selected:document.querySelector('#connectionSwitcher')?.value,message:document.querySelector('#deskMessage')?.textContent})");throw Error("UI did not settle: "+expression+" "+details);}
  for(const [width,height] of [[1920,1080],[1600,900],[1440,900],[1366,768],[390,844],[375,812]]){
   await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<800});
   for(const count of [64,100,150]){
    await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?count="+count});
    await until("document.querySelectorAll('#deskAccounts .account-select').length==="+count+" && document.querySelector('#deskEquity').textContent.includes('10,140.35')");
    await until("document.querySelector('#deskOpenPrice').textContent==='2,530' && document.querySelector('#deskAddAmount').textContent.includes('200') && document.querySelector('#deskAddQty').textContent.includes('0.08096674')");
    const layout=JSON.parse(await evaluate("JSON.stringify({width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,cardHeights:Array.from(document.querySelectorAll('#deskAccounts .account-select')).map(n=>n.getBoundingClientRect().height),listHeight:document.querySelector('#deskAccounts').clientHeight,listScroll:document.querySelector('#deskAccounts').scrollHeight,mainWidth:document.querySelector('main').getBoundingClientRect().width,settingsVisible:!!document.querySelector('#deskSettings').getBoundingClientRect().height,first:document.querySelector('#deskOpenPrice').textContent,add:document.querySelector('#deskAddPrice').textContent,amount:document.querySelector('#deskAddAmount').textContent})"));
    if(layout.scroll>layout.client||layout.width!==width||layout.mainWidth>layout.client||layout.cardHeights.some(h=>h<82)||!layout.settingsVisible)throw Error("Layout failure "+JSON.stringify(layout));
    if(width>760&&layout.listScroll<=layout.listHeight)throw Error("Account list must scroll");
    results.push({width,height,count,minCardHeight:Math.min(...layout.cardHeights),...layout,cardHeights:undefined});
    if(count===64){const shot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});fs.writeFileSync(path.join(directory,width+"x"+height+"-onepage.png"),Buffer.from(shot.data,"base64"));}
   }
   await evaluate("document.querySelector('[data-filter=running]').click()");
   await until("document.querySelectorAll('#deskAccounts .account-select').length===1");
   await evaluate("document.querySelector('[data-filter=all]').click(); const search=document.querySelector('#deskSearch');search.value='超长';search.dispatchEvent(new Event('input'));");
   await until("document.querySelectorAll('#deskAccounts .account-select').length===1");
   await evaluate("document.querySelector('#deskAccounts .account-select').click()");
   await until("document.querySelector('#deskAccount').textContent.startsWith('超长')&&!document.querySelector('#deskSave').disabled");
   await evaluate("window.confirm=()=>false;const setting=document.querySelector('#deskSettings [name=baseAmount]');setting.value='777';setting.dispatchEvent(new Event('input',{bubbles:true}));const selector=document.querySelector('#connectionSwitcher');selector.value='sample-0';selector.dispatchEvent(new Event('change'));");
   await until("document.querySelector('#deskSettings [name=baseAmount]').value==='777' && document.querySelector('#connectionSwitcher').value==='sample-1'");
   await evaluate("window.confirm=()=>true;const selector=document.querySelector('#connectionSwitcher');selector.value='sample-0';selector.dispatchEvent(new Event('change'));");
   await until("document.querySelector('#deskAccount').textContent==='经典模拟 · ETH'");
   await evaluate("document.querySelector('#openConnections').click()");
   await until("document.querySelector('#connectionDialog').open && document.querySelectorAll('.connection-item').length===150");
   const modal=JSON.parse(await evaluate("JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})"));
   if(modal.scroll>modal.client)throw Error("Connection dialog overflow");
   await evaluate("document.querySelector('#closeConnections').click()");
  }
  await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/?scenario=offline"});
  await until("document.querySelector('#deskMessage').textContent.includes('合成行情断流')");
  const offline=await evaluate("Array.from(document.querySelectorAll('[data-action]')).every(n=>n.disabled)&&document.querySelector('#deskSave').disabled");
  if(!offline)throw Error("Offline controls not locked");
  results.push({scenario:"offline",controlsDisabled:true});
  fs.writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2));return results;
 }finally{if(ws)ws.close();child.kill();await new Promise(r=>server.close(r));}
}
if(require.main===module)check().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
