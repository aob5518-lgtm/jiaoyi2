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
  const evaluate=async expression=>(await call("Runtime.evaluate",{expression,returnByValue:true})).result.value;
  async function until(expression){for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,40));}throw Error("UI did not settle: "+expression);}
  for(const [width,height] of [[1920,1080],[1600,900],[1440,900],[1366,768],[390,844],[375,812]]){
   await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<800});
   await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/"});
   await until("document.querySelectorAll('#deskAccounts tr').length===64 && document.querySelector('#deskEquity').textContent.includes('10,140.35')");
   for(const view of ["overview","strategy","history","connections"]){
    await evaluate("document.querySelector('.sidebar [data-view="+view+"]').click()");
    if(view==="history")await until("document.querySelector('#deskHistoryCount').textContent.includes('1')");
    if(view==="connections")await until("document.querySelectorAll('.connection-item').length===64");
    const layout=JSON.parse(await evaluate("JSON.stringify({width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,view:document.querySelector('[data-page]:not([hidden])').dataset.page})"));
    if(layout.view!==view||layout.scroll>layout.client||layout.width!==width)throw Error("Layout overflow "+JSON.stringify(layout));
    const shot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    fs.writeFileSync(path.join(directory,width+"x"+height+"-"+view+".png"),Buffer.from(shot.data,"base64"));
    results.push({width,height,...layout});
   }
   await evaluate("document.querySelector('.sidebar [data-view=overview]').click(); const search=document.querySelector('#deskSearch');search.value='超长';search.dispatchEvent(new Event('input'));");
   await until("document.querySelectorAll('#deskAccounts .account-select').length===1");
   await evaluate("document.querySelector('#deskAccounts .account-select').click()");
   await until("document.querySelector('#deskAccount').textContent.startsWith('超长')&&document.querySelector('[data-action=start]').disabled");
   await evaluate("document.querySelector('.sidebar [data-view=strategy]').click()");
   await until("!document.querySelector('#deskSave').disabled");
  }
  fs.writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2));return results;
 }finally{if(ws)ws.close();child.kill();await new Promise(r=>server.close(r));}
}
if(require.main===module)check().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
