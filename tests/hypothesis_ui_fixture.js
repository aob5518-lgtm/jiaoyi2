"use strict";
// Read-only synthetic rendering fixture. No production config, runtime or SDK.
const http=require("http"),fs=require("fs"),path=require("path"),B=require("../strategy/hypothesis_v5/book"),V=require("../strategy/hypothesis_v5/service");
function start(port=43911){
 const b=B.create({id:"synthetic-ui-only",symbol:"ETH"});b.running=false;
 b.lastSnapshot={markPrice:2500,signal:{dataHealth:"healthy",signalTime:Date.UTC(2024,11,31,23),direction:"none",regime:{state:"RANGE",adx:18,atr:15},atr:15,signalPermission:"blocked",quote:{allowed:true},blockers:["合成视觉验收：日线样本不代表实时行情，等待已收盘突破"]},decision:{time:Date.UTC(2024,11,31,23),planDecision:"NOT_EVALUATED",executionPermission:"blocked",finalDecision:"NO_SIGNAL",blockers:["合成视觉验收：等待已收盘突破"]}};
 const pub=path.resolve(__dirname,"../public"),files={"/":"/intelligent-trend.html","/hypothesis/workbench.css":"/hypothesis/workbench.css","/hypothesis/workbench.js":"/hypothesis/workbench.js"};
 const server=http.createServer((req,res)=>{const u=new URL(req.url,"http://localhost");if(req.method!=="GET"){res.writeHead(405);return res.end("Read-only fixture");}
  if(u.pathname==="/api/v5/status"||u.pathname==="/api/v5/research"){res.setHeader("Content-Type","application/json");return res.end(JSON.stringify(u.pathname.endsWith("status")?{ok:true,accounts:[V.projections(b)]}:{ok:true,...V.researchSummary()}));}
  const file=files[u.pathname];if(!file){res.writeHead(404);return res.end();}res.setHeader("Content-Type",file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":"text/html");res.end(fs.readFileSync(pub+file));
 });server.listen(port,"127.0.0.1",()=>console.log("SYNTHETIC_UI_ONLY http://127.0.0.1:"+server.address().port));return server;
}
if(require.main===module)start();module.exports={start};
