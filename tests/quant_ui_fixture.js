"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const turtleConfig=require("../strategy/turtle_4h/config");
const reversalConfig=require("../strategy/reversal_4h/config");
const carryConfig=require("../strategy/funding_carry/config");
const pullbackConfig=require("../strategy/pullback_15m/config");
const root = path.resolve(__dirname, "../public");
const files = new Set(["index.html", "hypothesis/workbench.css", "hypothesis/connections.js", "quant/desk.css", "quant/desk.js", "quant/settings-preview.js","quant/production.css","quant/production.js","turtle.html","turtle/desk.js","turtle/desk.css"]);
function start(port = 0) {
 let count = 64, scenario = "";
 const saved = new Map(), submissions = [], controls=[], turtleAccounts=new Map();
 let turtleSaveAttempts=0;
 const turtleTrades=Array.from({length:32},(_,i)=>({time:Date.UTC(2026,10,15)-i*3600000,side:"short",entryPrice:2500,exitPrice:2510,netPnl:-10.2,tradingFee:.4,reason:"hard_sl"}));
 let accounts = [];
 const makeAccounts = () => Array.from({length: count}, (_, i) => ({
  id: "sample-" + i, name: i === 0 ? "经典模拟 · ETH" : i === 1 ? "超长账户名称测试".repeat(9) : "模拟账户 " + (i + 1),
  symbol: i % 2 ? "BTC" : "ETH", quoteAsset: "USDT", platform: "binance", paper: true, eligible: !(i===0 && scenario==="readonly"),
  ready: i === 0 && scenario!=="readonly", running: i === 0 && !scenario, hasPosition: i === 0 && !scenario, strategy: i === 0 && scenario==="readonly"?"归档账户":i === 0 ? "经典补仓" : "未绑定",
  strategyType:i===0&&scenario==="readonly"?"trend_only_v3":"classic"
 }));
 accounts = makeAccounts();
 let selected = accounts[0].id;
 const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, data) => {res.writeHead(code, {"Content-Type": "application/json"});res.end(JSON.stringify(data));};
  if (url.pathname === "/") {scenario = url.searchParams.get("scenario") || "";server.scenario = scenario;saved.clear();submissions.length=0;controls.length=0;turtleAccounts.clear();turtleSaveAttempts=0;if ([64,100,150].includes(Number(url.searchParams.get("count")))) count=Number(url.searchParams.get("count"));accounts=makeAccounts();selected=accounts[0].id;}
  const requestBody=async()=>{
   let body="";
   for await(const part of req)body+=part;
   return JSON.parse(body);
  };
 const turtleSnapshot=(a,profile)=>{
   const config=turtleAccounts.get(a.id);
   const history=profile===turtleConfig&&turtleSaveAttempts>2?turtleTrades:[];
   const realized=history.reduce((total,trade)=>total+trade.netPnl,0);
   return {id:a.id,name:a.name,symbol:a.symbol,mode:"Paper",config,configHash:profile.hash(config),history,decision:{code:profile.waitCode||"WAIT_BREAKOUT",reason:"等待收盘"},market:{state:"fresh",quoteTime:Date.now()},fresh:true,balance:10000+realized,equity:10000+realized,floating:0,realized,price:2500,running:a.running,nextEntry:{upper:2520,lower:2400,direction:config.direction,closesAt:Date.now()+3600000},
    ...(profile===carryConfig?{carry:{phase:"flat",spot:2500,perp:2504,basisBps:16,rate:.0003,nextFundingAt:Date.now()+3600000,expected:8,cost:10,edge:-2},decision:{code:"COST_BLOCK",reason:"预计交易成本超过收益"}}:{}),
    ...(profile===pullbackConfig?{decision:{code:"WAIT_PULLBACK",reason:"等待回踩"},analysis:{trend:"long",breakoutLevel:2480}}:{})};
  };
  if(/^\/api\/v4\/(turtle|reversal|carry|pullback)\//.test(url.pathname)){
   const route=url.pathname.split("/").at(-1);
   const mode=url.pathname.split("/")[3],profile={turtle:turtleConfig,reversal:reversalConfig,carry:carryConfig,pullback:pullbackConfig}[mode];
   if(req.method==="GET"&&route==="accounts")return json(200,{ok:true,accounts,defaults:profile.defaults});
   if(req.method==="GET"&&route==="status"){
    const a=accounts.find(x=>x.id===url.searchParams.get("id"));
    return json(200,{ok:true,snapshot:turtleSnapshot(a,profile)});
   }
   if(req.method==="GET"&&route==="history"){
    const items=mode==="carry"?[{time:Date.now(),spotEntry:2500,spotExit:2505,perpEntry:2504,perpExit:2507,fundingPnl:9,basisPnl:2,
     unhedgedPnl:0,tradingFee:3,slippageAmount:1,netPnl:7,reason:"rate_reversed"}]:[];
    return json(200,{ok:true,total:items.length,items});
   }
   return requestBody().then(input=>{
    if(route==="accounts"){
     const a={...input,id:"new-"+mode,strategyType:profile.ID,strategy:profile.label||"海龟趋势 4H",platform:"binance",quoteAsset:"USDT",paper:true,running:false};
     turtleAccounts.set(a.id,profile.normalize(input.config));accounts.push(a);
     return json(200,{ok:true,id:a.id,message:"独立模拟账户已创建"});
    }
    const a=accounts.find(x=>x.id===input.id);
    if(route==="preflight"){
     const snapshot=turtleSnapshot(a,profile);
     return json(200,{ok:true,snapshot,preflight:{allowed:true,configHash:snapshot.configHash,blockers:[],checkedAt:Date.now()}});
    }
    if(route==="config"){
     if(mode==="turtle"&&a.running&&++turtleSaveAttempts<=2)return json(400,{ok:false,error:"正在更新账户，请稍后重试"});
     if(input.expectedHash!==profile.hash(turtleAccounts.get(a.id)))return json(400,{ok:false,error:"参数版本已变更"});
     turtleAccounts.set(a.id,profile.normalize(input.config));
     return json(200,{ok:true,message:"参数已保存"});
    }
    if(route==="control"){
     controls.push(input);
     if(input.action==="start"&&(input.confirm!==true||input.expectedHash!==profile.hash(turtleAccounts.get(a.id))))return json(400,{ok:false,error:"请核对当前参数后启动"});
     a.running=input.action==="start";return json(200,{ok:true,message:a.running?"已启动":"已暂停"});
    }
    return json(404,{ok:false});
   }).catch(()=>json(400,{ok:false,error:"测试输入错误"}));
  }
  if (req.method==="POST"&&url.pathname==="/api/v4/connections/create"){
   return requestBody().then(input=>{
    const a={...input,id:"new-classic",quoteAsset:"USDT",strategyType:"connection_only",strategy:"未绑定",paper:true,eligible:true,ready:false,running:false};
    accounts.push(a);
    return json(200,{ok:true,account:a,message:"模拟账户已创建"});
   }).catch(()=>json(400,{ok:false,error:"测试输入错误"}));
  }
  if (req.method === "POST" && url.pathname === "/api/account/select") {
   let body = "";req.on("data", chunk => body += chunk);req.on("end", () => {
    const id = JSON.parse(body).id;if (accounts.some(a => a.id === id)) selected = id;json(200,{ok:true});
   });return;
  }
  if (req.method === "POST" && url.pathname === "/api/v4/desk/settings") {
   let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{
    const input=JSON.parse(body);submissions.push(input);
    if(scenario==="save-failed")return json(400,{ok:false,error:"合成保存失败：原参数未改变"});
    const account=accounts.find(a=>a.id===input.id);
    if(!account?.eligible||account.running||account.hasPosition)return json(400,{ok:false,error:"合成账户不能修改参数"});
    saved.set(account.id,input.settings);account.ready=true;json(200,{ok:true});
   });return;
  }
  if(req.method==="POST"&&url.pathname==="/api/v4/desk/control"){
   return requestBody().then(input=>{
    const a=accounts.find(x=>x.id===input.id);
    if(!a?.eligible||!a.ready)return json(409,{ok:false,error:"当前账户不能启动"});
    if(input.action==="start"&&scenario==="blocked")return json(400,{ok:false,error:"模拟行情报价暂不可用"});
    controls.push(input);a.running=input.action==="start";return json(200,{ok:true});
   }).catch(()=>json(400,{ok:false,error:"测试输入错误"}));
  }
  if (req.method !== "GET") return json(405, {ok: false, error: "合成验收，不执行交易"});
  if (url.pathname === "/api/v4/connections") return json(200, {ok: true, currentAccountId: selected, accounts: accounts.map(a => ({...a, tradeMode: a.paper ? "simulation" : "live", simulationEnabled: a.paper, hasApiKey: a.id === "sample-0", hasApiSecret: a.id === "sample-0"}))});
  if(url.pathname==="/api/v4/desk/preflight"){
   const a=accounts.find(x=>x.id===url.searchParams.get("id"));
   const allowed=!!(a?.eligible&&a.ready&&scenario!=="blocked");
   return json(200,{ok:true,allowed,settings:saved.get(a?.id),blockers:allowed?[]:["模拟行情报价暂不可用"]});
  }
  if (url.pathname === "/api/v4/desk") {
   if (server.scenario === "offline") return json(503,{ok:false,error:"合成行情断流"});
   const a = accounts.find(x => x.id === (url.searchParams.get("id") || selected));
   const cfg = saved.get(a.id) || {side:"long",leverage:2,baseAmount:300,addAmount:200,maxAdds:3,addTrigger:.01,takeProfit:.02};
   const snapshot = a.hasPosition ? {equity:10140.35,floating:-12.45,realized:152.8,available:9889.35,margin:251,mark:2500.46,updatedAt:Date.now(),market:"行情正常",notice:"等待补仓或止盈条件",lastAction:"模拟补仓 #1",settings:cfg,position:{side:"long",entry:2562.31,qty:.2008,adds:1,nextAdd:2470.15,takeProfit:2588.19}} :
    {equity:10000,realized:0,floating:0,available:10000,margin:0,mark:2500.46,updatedAt:Date.now(),market:"行情正常",notice:a.ready?"等待启动":"保存经典参数后，可启动模拟交易",settings:a.ready?cfg:undefined,position:null};
   if (a.hasPosition) snapshot.plan = {first:{price:2530,amount:cfg.baseAmount,status:"已成交"},add:{price:2470.15,amount:200,quantity:200/2470.15,lastPrice:2495,done:1,limit:3,status:"等待触发"},exit:{price:2588.19,status:"监测止盈"},fills:[{at:Date.now()-100000,kind:"open",price:2530,qty:.1,notional:253},{at:Date.now()-30000,kind:"add",price:2495,qty:.1008,notional:251.496}]};
   return json(200,{ok:true,selected:a,accounts:accounts.map(account=>account.strategyType==="turtle_4h_v1"?{...account,running:false}:account),snapshot,defaultSettings:cfg});
  }
  if (url.pathname === "/api/v4/desk/history") return json(200,{ok:true,total:1,items:[{time:Date.now(),side:"long",entryPrice:2480,exitPrice:2510,netPnl:10.2,tradingFee:.4,reason:"策略止盈"}]});
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (file === "index.html") selected = accounts[0].id;
  if (!files.has(file)) return json(404,{ok:false});
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css" : "text/javascript");
  res.end(fs.readFileSync(path.join(root,file)));
 });
 server.listen(port,"127.0.0.1");
 server.submissions=submissions;
 server.controls=controls;
 server.turtleSaveAttempts=()=>turtleSaveAttempts;
 return server;
}
module.exports = {start};
