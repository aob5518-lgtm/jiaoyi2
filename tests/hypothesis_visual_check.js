"use strict";
// Isolated headless Chrome test of OUR localhost fixture; never attaches to a user browser.
const fs=require("fs"),path=require("path"),os=require("os"),{spawn}=require("child_process"),{start}=require("./hypothesis_ui_fixture");
async function check({browser=process.env.CHROME_PATH||"C:/Program Files/Google/Chrome/Application/chrome.exe",directory=path.resolve(".audit/v5-visual")}={}){
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
  for(const [width,height]of [[1920,1080],[1600,900],[1440,900],[1366,768],[390,844],[375,812]]){
   await call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<800});
   await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/"});
   for(let n=0;n<100;n++){const x=await call("Runtime.evaluate",{expression:"document.getElementById('decision')?.textContent.includes('合成视觉验收')",returnByValue:true});if(x.result.value)break;if(n===99)throw Error("UI never rendered backend data");await new Promise(r=>setTimeout(r,50));}
   const dom=await call("Runtime.evaluate",{expression:"JSON.stringify({width:innerWidth,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,mainWidth:document.querySelector('main').getBoundingClientRect().width,blocked:document.getElementById('decision').textContent,startEnabled:!document.getElementById('start').disabled,pauseEnabled:!document.getElementById('pause').disabled,report:document.getElementById('backtest').textContent})",returnByValue:true}),facts=JSON.parse(dom.result.value);
   const screenshot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});fs.writeFileSync(path.join(directory,width+"x"+height+".png"),Buffer.from(screenshot.data,"base64"));
   results.push({width,height,...facts});
   if(facts.scrollWidth>facts.clientWidth||facts.width!==width||facts.mainWidth>width)throw Error("Horizontal overflow: "+JSON.stringify(facts));
   if(!facts.startEnabled||facts.pauseEnabled||!facts.report.includes("NOT_PASSED"))throw Error("Rendered state mismatch");
   for(const view of ["plan","connections","experiments","history","analysis","archive"]){
    const selector='[data-view="'+view+'"]';
    await call("Runtime.evaluate",{expression:"document.querySelector("+JSON.stringify(selector)+").click();true",returnByValue:true});
    if(view==="archive")for(let n=0;n<100;n++){const loaded=await call("Runtime.evaluate",{expression:"document.querySelectorAll('.archive-item').length",returnByValue:true});if(loaded.result.value===64)break;if(n===99)throw Error("Archive did not load");await new Promise(r=>setTimeout(r,25));}
    if(view==="connections")for(let n=0;n<100;n++){const loaded=await call("Runtime.evaluate",{expression:"document.querySelectorAll('.connection-item').length",returnByValue:true});if(loaded.result.value===64)break;if(n===99)throw Error("Connection accounts did not load");await new Promise(r=>setTimeout(r,25));}
    const state=await call("Runtime.evaluate",{expression:"JSON.stringify({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,visible:Array.from(document.querySelectorAll('[data-page]')).filter(x=>!x.hidden).map(x=>x.dataset.page),archive:document.querySelectorAll('.archive-item').length})",returnByValue:true}),layout=JSON.parse(state.result.value);
    if(layout.scroll>layout.client||layout.visible.length!==1||layout.visible[0]!==view)throw Error("View layout failure: "+view+" "+JSON.stringify(layout));
    if(["plan","connections","experiments","archive"].includes(view)){const shot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});fs.writeFileSync(path.join(directory,width+"x"+height+"-"+view+".png"),Buffer.from(shot.data,"base64"));}
    results.push({width,height,view,...layout});
   }
  }
  for(const scenario of ["empty","error"]){
   server.scenario=scenario;await call("Page.navigate",{url:"http://127.0.0.1:"+port+"/"});
   const expression=scenario==="empty"?"document.getElementById('experimentCount').textContent==='0'":"document.getElementById('error').textContent.includes('合成断流场景')";
   for(let n=0;n<100;n++){const checked=await call("Runtime.evaluate",{expression,returnByValue:true});if(checked.result.value)break;if(n===99)throw Error("Scenario failed: "+scenario);await new Promise(r=>setTimeout(r,25));}
   const state=await call("Runtime.evaluate",{expression:"JSON.stringify({start:document.getElementById('start').disabled,pause:document.getElementById('pause').disabled,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})",returnByValue:true}),facts=JSON.parse(state.result.value);
   if(!facts.start||!facts.pause||facts.scroll>facts.client)throw Error("Scenario controls failure: "+scenario);
   results.push({scenario,...facts});
  }
  fs.writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2));return results;
 }finally{if(ws)ws.close();child.kill();await new Promise(r=>server.close(r));}
}
if(require.main===module)check().then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={check};
