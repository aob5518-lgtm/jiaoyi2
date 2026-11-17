"use strict";
const fs=require("fs"),path=require("path"),http=require("http"),os=require("os");
const F=require("./turtle_fixture"),C=require("../strategy/turtle_4h/config"),B=require("../strategy/turtle_4h/book"),R=require("../strategy/turtle_4h/runtime"),API=require("../terminal/turtle-api");
function start(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"turtle-ui-"));let scenario="",config={accounts:[]},states={},engine,mutations=[];
 const reset=(count=64,mode="")=>{
  scenario=mode;config={accounts:Array.from({length:mode==="empty"?0:count},(_,i)=>i<2?F.account({id:"new-"+i,name:i?"超长账户名称与策略说明".repeat(10):"海龟 4H · ETH 模拟",symbol:i?"BTC":"ETH"}):{id:"old-"+i,name:"原有模拟账户 "+i,symbol:i%2?"BTC":"ETH",platform:i%3?"hyperliquid":"binance",quoteAsset:i%3?"USDC":"USDT",strategyType:"classic",tradeMode:"simulation",simulationEnabled:true})};states={};
  const ledger=path.join(directory,"turtle_4h_paper.json");if(fs.existsSync(ledger))fs.unlinkSync(ledger);
  engine=R.create({directory,provider:{load:async(a)=>{if(scenario==="outage")throw Error("Binance 原生行情断流，未使用替代报价");const m=F.market(Date.now());m.symbol=a.symbol+"USDT";return m;}},permit:()=>({allowed:true})});
  for(const a of config.accounts.filter(a=>a.strategyType===C.ID)){let b=B.initial(a);if(mode==="position"||mode==="pending"){b.running=true;b=B.advance(b,F.event({time:Date.now()-2000,data:F.market(Date.now()-2000),account:a}),C.defaults);if(mode==="position")b=B.advance(b,F.event({time:Date.now()-1000,data:F.market(Date.now()-1000),account:a}),C.defaults);}engine.commit(a,b);}
 };
 reset();
 const d={accounts:()=>config.accounts,getAccountById:id=>config.accounts.find(a=>a.id===id),state:id=>states[id]||=( {}),configuration:()=>structuredClone(config),save:n=>{if(scenario==="savefail")throw Error("保存失败：合成磁盘故障");config=n;},lock:()=>({}),unlock(){},json:(res,code,v)=>{res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(v));}};
 const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");
  if(u.pathname==="/turtle.html")reset(Number(u.searchParams.get("count")||64),u.searchParams.get("scenario")||"");
  if(u.pathname.startsWith("/api/v4/turtle/")){if(req.method==="POST")mutations.push(u.pathname);
   if(req.method==="GET"&&u.pathname.endsWith("/status")){const a=d.getAccountById(u.searchParams.get("id"));try{await engine.refresh(a);}catch(e){d.state(a.id).activeError=e.message;}}
   return API.handle(req,res,u,{...d,engine});}
  const relative=u.pathname==="/turtle.html"?"turtle.html":u.pathname.slice(1);
  if(!["turtle.html","turtle/desk.js","turtle/desk.css","quant/dialogs.js","quant/dialogs.css","quant/trade-labels.js","quant/trade-labels.css"].includes(relative)){res.writeHead(404);return res.end();}
  res.writeHead(200,{"Content-Type":relative.endsWith(".js")?"application/javascript":relative.endsWith(".css")?"text/css":"text/html"});res.end(fs.readFileSync(path.join(__dirname,"../public",relative)));
 });
 server.mutations=mutations;server.config=()=>config;server.listeningDone=new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));server.cleanup=()=>fs.rmSync(directory,{recursive:true,force:true});return server;
}
module.exports={start};
