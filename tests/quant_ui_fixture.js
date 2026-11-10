"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "../public");
const files = new Set(["index.html", "hypothesis/workbench.css", "hypothesis/connections.js", "quant/desk.css", "quant/desk.js"]);
function start(port = 0) {
 let count = 64;
 let accounts = [];
 const makeAccounts = () => Array.from({length: count}, (_, i) => ({
  id: "sample-" + i, name: i === 0 ? "经典模拟 · ETH" : i === 1 ? "超长账户名称测试".repeat(9) : "模拟账户 " + (i + 1),
  symbol: i % 2 ? "BTC" : "ETH", quoteAsset: "USDT", platform: "binance", paper: i < 50, eligible: i < 50,
  ready: i === 0, running: i === 0, hasPosition: i === 0, strategy: i === 0 ? "经典补仓" : "未绑定"
 }));
 accounts = makeAccounts();
 let selected = accounts[0].id;
 const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, data) => {res.writeHead(code, {"Content-Type": "application/json"});res.end(JSON.stringify(data));};
  if (url.pathname === "/" && [64,100,150].includes(Number(url.searchParams.get("count")))) {count=Number(url.searchParams.get("count"));accounts=makeAccounts();selected=accounts[0].id;}
  if (url.pathname === "/" && url.searchParams.get("scenario")) server.scenario = url.searchParams.get("scenario");
  if (url.pathname === "/" && !url.searchParams.get("scenario")) server.scenario = null;
  if (req.method === "POST" && url.pathname === "/api/account/select") {
   let body = "";req.on("data", chunk => body += chunk);req.on("end", () => {
    const id = JSON.parse(body).id;if (accounts.some(a => a.id === id)) selected = id;json(200,{ok:true});
   });return;
  }
  if (req.method !== "GET") return json(405, {ok: false, error: "合成验收，不执行交易"});
  if (url.pathname === "/api/v4/connections") return json(200, {ok: true, currentAccountId: selected, accounts: accounts.map(a => ({...a, tradeMode: a.paper ? "simulation" : "live", simulationEnabled: a.paper, hasApiKey: a.id === "sample-0", hasApiSecret: a.id === "sample-0"}))});
  if (url.pathname === "/api/v4/desk") {
   if (server.scenario === "offline") return json(503,{ok:false,error:"合成行情断流"});
   const a = accounts.find(x => x.id === (url.searchParams.get("id") || selected));
   const cfg = {side:"long",leverage:2,baseAmount:300,addAmount:200,maxAdds:3,addTrigger:.01,takeProfit:.02};
   const snapshot = a.ready ? {equity:10140.35,floating:-12.45,realized:152.8,available:9889.35,margin:251,mark:2500.46,updatedAt:Date.now(),market:"行情正常",notice:"等待补仓或止盈条件",lastAction:"模拟补仓 #1",settings:cfg,position:{side:"long",entry:2562.31,qty:.2008,adds:1,nextAdd:2470.15,takeProfit:2588.19}} :
    {equity:10000,realized:0,floating:0,available:10000,margin:0,market:"等待行情",notice:"保存经典参数后，可启动模拟交易",position:null};
   if (a.ready) snapshot.plan = {first:{price:2530,amount:cfg.baseAmount,status:"已成交"},add:{price:2470.15,amount:200,quantity:200/2470.15,lastPrice:2495,done:1,limit:3,status:"等待触发"},exit:{price:2588.19,status:"监测止盈"},fills:[{at:Date.now()-100000,kind:"open",price:2530,qty:.1,notional:253},{at:Date.now()-30000,kind:"add",price:2495,qty:.1008,notional:251.496}]};
   return json(200,{ok:true,selected:a,accounts,snapshot,defaultSettings:cfg});
  }
  if (url.pathname === "/api/v4/desk/history") return json(200,{ok:true,total:1,items:[{time:Date.now(),side:"long",entryPrice:2480,exitPrice:2510,netPnl:10.2,tradingFee:.4,reason:"策略止盈"}]});
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (file === "index.html") selected = accounts[0].id;
  if (!files.has(file)) return json(404,{ok:false});
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css" : "text/javascript");
  res.end(fs.readFileSync(path.join(root,file)));
 });
 server.listen(port,"127.0.0.1");
 return server;
}
module.exports = {start};
