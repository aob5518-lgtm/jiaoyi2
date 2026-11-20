"use strict";
// Read-only synthetic rendering fixture. No production config, runtime or SDK.
const http=require("http"),fs=require("fs"),path=require("path"),B=require("../strategy/hypothesis_v5/book"),V=require("../strategy/hypothesis_v5/service");
function start(port=43911){
 const b=B.create({id:"synthetic-ui-only",symbol:"ETH"});b.running=false;
 b.lastSnapshot={markPrice:2500,signal:{dataHealth:"healthy",signalTime:Date.UTC(2024,11,31,23),direction:"none",regime:{state:"RANGE",adx:18,atr:15},atr:15,signalPermission:"blocked",quote:{allowed:true},blockers:["合成视觉验收：日线样本不代表实时行情，等待已收盘突破"]},decision:{time:Date.UTC(2024,11,31,23),planDecision:"NOT_EVALUATED",executionPermission:"blocked",finalDecision:"NO_SIGNAL",blockers:["合成视觉验收：等待已收盘突破"]}};
 const pub=path.resolve(__dirname,"../public"),files={"/":"/intelligent-trend.html","/hypothesis/workbench.css":"/hypothesis/workbench.css","/hypothesis/workbench.js":"/hypothesis/workbench.js","/hypothesis/connections.js":"/hypothesis/connections.js"};
 const server=http.createServer((req,res)=>{const u=new URL(req.url,"http://localhost");if(req.method!=="GET"){res.writeHead(405);return res.end("Read-only fixture");}
  if(u.pathname==="/api/v5/status"||u.pathname==="/api/v5/research"){res.setHeader("Content-Type","application/json");if(server.scenario==="error"&&u.pathname.endsWith("status")){res.writeHead(503);return res.end(JSON.stringify({ok:false,error:"合成断流场景"}));}return res.end(JSON.stringify(u.pathname.endsWith("status")?{ok:true,accounts:server.scenario==="empty"?[]:[V.projections(b)]}:{ok:true,...V.researchSummary()}));}
  if(u.pathname==="/api/v4/terminal"){res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:true,accounts:Array.from({length:64},(_,n)=>({id:"archive-"+n,name:n===0?"合成历史账户超长名称".repeat(5):"合成历史账户 "+n,platform:"binance",symbol:n%2?"BTC":"ETH",quoteAsset:"USDT",running:false}))}));}
  if(u.pathname==="/api/v4/history"){res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:true,items:[]}));}
  if(u.pathname==="/api/v4/connections"){res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:true,currentAccountId:"connection-0",accounts:Array.from({length:64},(_,n)=>({id:"connection-"+n,name:"合成连接账户 "+n,platform:n%2?"hyperliquid":"binance",symbol:"ETH",quoteAsset:n%2?"USDC":"USDT",tradeMode:n<50?"simulation":"live",simulationEnabled:n<50,running:false,hasApiKey:n===0,hasApiSecret:n===0}))}));}
  const file=files[u.pathname];if(!file){res.writeHead(404);return res.end();}res.setHeader("Content-Type",file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":"text/html");res.end(fs.readFileSync(pub+file));
 });server.listen(port,"127.0.0.1",()=>console.log("SYNTHETIC_UI_ONLY http://127.0.0.1:"+server.address().port));return server;
}
if(require.main===module)start();module.exports={start};
