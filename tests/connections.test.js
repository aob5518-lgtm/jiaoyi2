"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict"), http = require("http");
const Connections = require("../terminal/connections"), Reset = require("../terminal/paper-reset");
async function setup(t) {
 let config = {currentAccountId: "paper", accounts: [
  {id: "paper", name: "Paper", platform: "binance", symbol: "ETH", quoteAsset: "USDT", tradeMode: "simulation", simulationEnabled: true, simulationBalance: 10000, strategyType: "classic", apiKey: "saved-key", apiSecret: "saved-secret", privateKey: "saved-private"},
  {id: "live", name: "Live", platform: "hyperliquid", symbol: "ETH", tradeMode: "live", simulationEnabled: false, privateKey: "live-private"}
 ]};
 const states = {paper: {running: false}, live: {running: false}};
 let checks = 0, native = 0, failNative = false,failSave=false;
 const d = {
  accounts: () => config.accounts, configuration: () => structuredClone(config), getCurrentAccount: () => config.accounts[0],
  getAccountById: id => config.accounts.find(account => account.id === id), state: id => states[id],
  save: value => {if(failSave)throw Error("保存失败");config = value;for (const account of value.accounts) states[account.id] ||= {running: false};},
  simulationOrders:()=>[],
  lock: () => ({}), unlock() {}, json: (res, code, body) => {res.writeHead(code, {"Content-Type": "application/json"});res.end(JSON.stringify(body));},
  verifyLiveFlat: async () => {native++;if (failNative) throw Error("unknown native risk");},
  checkConnection: async () => {checks++;return {balance: 1, positionCount: 0};}
 };
 const server = http.createServer((req, res) => Connections.handle(req, res, new URL(req.url, "http://localhost"), d));
 await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
 t.after(() => new Promise(resolve => server.close(resolve)));
 const call = async (route = "", input) => {
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/v4/connections" + route, input === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(input)});
  return {code: response.status, data: await response.json()};
 };
 return {call, states, config: () => config, counters: () => ({checks, native}), rejectNative: () => {failNative = true;},rejectSave:()=>{failSave=true;}};
}

test("Live connections require explicit confirmation, never accept fake equity and remain unbound and stopped",async t=>{
 const x=await setup(t),input={name:"Real Binance",platform:"binance",symbol:"BTC",accountMode:"live",apiKey:"new-key",apiSecret:"new-secret"};
 assert.equal((await x.call("/create",input)).code,400);
 assert.equal((await x.call("/create",{...input,confirmLive:true,initialEquity:10000})).code,400);
 const r=await x.call("/create",{...input,confirmLive:true});assert.equal(r.code,200);
 const a=x.config().accounts.find(a=>a.id===r.data.account.id);
 assert.equal(a.tradeMode,"live");assert.equal(a.simulationEnabled,false);assert.equal(a.strategyType,"connection_only");assert.equal(a.running,false);
 assert.equal(a.simulationBalance,undefined);assert.equal(x.counters().checks,0);assert.equal(x.counters().native,0);
 assert.doesNotMatch(JSON.stringify(r.data),/new-key|new-secret/);
});
test("Delete archives only a settled stopped account, preserving identity, credentials, balance and recovery audit",async t=>{
 const x=await setup(t),before=structuredClone(x.config().accounts[0]);
 const p=(await x.call("/archive-preview",{id:"paper"})).data.review;assert.equal(p.allowed,true);
 assert.equal((await x.call("/archive",{id:"paper",confirm:true,expectedVersion:"stale"})).code,400);
 const r=await x.call("/archive",{id:"paper",confirm:true,expectedVersion:p.version});assert.equal(r.code,200);
 const a=x.config().accounts[0];assert.ok(a.archivedAt);assert.equal(x.config().accounts.length,2);
 assert.equal(a.apiSecret,before.apiSecret);assert.equal(a.simulationBalance,before.simulationBalance);
 assert.equal((await x.call("/update",{id:"paper",name:"forbidden"})).code,400);
 const restored=await x.call("/restore",{id:"paper",confirm:true,expectedVersion:r.data.account.lifecycleVersion});
 assert.equal(restored.code,200);const b=x.config().accounts[0];
 assert.equal(b.archivedAt,undefined);assert.equal(b.lifecycleAudit.length,2);assert.equal(x.states.paper.running,false);
 const {lifecycleAudit,...original}=b;assert.deepEqual(original,before);
});
test("Delete rechecks each pending/risk/position state and does not clear another request's mutation lock",async t=>{
 const x=await setup(t);
 for(const patch of [{running:true},{pendingOrder:{}},{placingOrder:true},{smartExitPending:true},{riskLock:true},{realPositionSize:-.001},{positionQty:NaN}]){
  Object.assign(x.states.paper,{running:false,pendingOrder:null,placingOrder:false,smartExitPending:false,riskLock:false,realPositionSize:0,positionQty:0},patch);
  assert.equal((await x.call("/archive-preview",{id:"paper"})).data.review.allowed,false);
 }
 x.states.paper.terminalMutating=true;
 assert.equal((await x.call("/archive-preview",{id:"paper"})).code,400);assert.equal(x.states.paper.terminalMutating,true);
});
test("Live deletion cannot rely on local flat state and failed saves leave original configuration intact",async t=>{
 const x=await setup(t);x.rejectNative();
 const result=await x.call("/archive-preview",{id:"live"});
 assert.equal(result.data.review.allowed,false);assert.ok(result.data.review.blockers.some(x=>x.key==="exchange"));
 const paper=(await x.call("/archive-preview",{id:"paper"})).data.review,before=JSON.stringify(x.config());
 x.rejectSave();assert.equal((await x.call("/archive",{id:"paper",confirm:true,expectedVersion:paper.version})).code,400);
 assert.equal(JSON.stringify(x.config()),before);
});
test("Native position display uses exchange entry and leverage, including hedged positions, without config fallbacks",()=>{
 const {summarize,completeNumbers}=require("../terminal/native-account-view");
 assert.equal(completeNumbers(["0",0]),true);
 for(const v of [null,undefined,"",true," "])assert.equal(completeNumbers([v]),false);
 const a={symbol:"ETH",leverage:100};
 const hyper=summarize(a,{balance:100,positions:[{position:{coin:"ETH",szi:"-.01",entryPx:"2500",leverage:{value:3},unrealizedPnl:"1"}}]});
 assert.equal(hyper.positions[0].entry,2500);assert.equal(hyper.positions[0].leverage,3);assert.equal(hyper.positions[0].side,"short");
 const binance=summarize(a,{positions:[{symbol:"ETHUSDT",positionAmt:"1",positionSide:"LONG",entryPrice:"2400",leverage:"5"},
  {symbol:"ETHUSDT",positionAmt:"-2",positionSide:"SHORT",entryPrice:"2600"}]});
 assert.equal(binance.positionCount,2);assert.equal(binance.positions[1].leverage,null);assert.equal(binance.positions[1].symbol,"ETH");
 assert.throws(()=>summarize(a,{positions:[{symbol:"ETHUSDT"}]}),/未知/);
 assert.throws(()=>summarize(a,{positions:[],balance:0,nativeEvidenceValid:false}),/不完整/);
 const extended=summarize(a,{positions:[{market:"ETH-USD",size:2,side:"SHORT",openPrice:2400,leverage:10}]});
 assert.equal(extended.positions[0].side,"short");assert.equal(extended.positions[0].symbol,"ETH");
 const incomplete=summarize(a,{positions:[{market:"ETH-USD",size:2,entryPrice:0,leverage:0}]});
 assert.equal(incomplete.positions[0].entry,null);assert.equal(incomplete.positions[0].leverage,null);
});
test("Archived accounts cannot add risk while old protective reduce-only exits remain permitted",()=>{
 const P=require("../terminal/policy"),a={strategyType:"trend_only_v3",archivedAt:1};
 assert.throws(()=>P.assertEntry(a),/ACCOUNT_ARCHIVED/);assert.doesNotThrow(()=>P.assertEntry(a,true));
});
test("Independent Paper lifecycle cannot hide pending legs, corrupt identity or unknown engines",async()=>{
 const L=require("../terminal/account-lifecycle"),a={id:"p",strategyType:"chart_swing_1h_v1",tradeMode:"simulation",simulationEnabled:true};
 const engine={get:()=>({position:null,pending:{status:"SUBMITTED"},running:false}),busy:()=>false};
 const d={state:()=>({running:false,positionQty:0,realPositionSize:"-"}),independentEngine:()=>engine};
 assert.equal((await L.review(a,d)).allowed,false);
 engine.get=()=>({position:null,pending:null,running:false});assert.equal((await L.review(a,d)).allowed,true);
 engine.get=()=>{throw Error("IDENTITY_MISMATCH");};assert.equal((await L.review(a,d)).allowed,false);
 assert.equal((await L.review({...a,strategyType:"unknown"},{state:()=>({}),simulationOrders:()=>[]})).allowed,false);
});
test("Connection list exposes only configured flags and never complete credentials", async t => {
 const x = await setup(t), r = await x.call();
 assert.equal(r.code, 200);assert.equal(r.data.accounts.length, 2);
 assert.equal(r.data.accounts[0].hasApiSecret, true);
 assert.doesNotMatch(JSON.stringify(r.data), /saved-secret|saved-private|saved-key|live-private/);
});
test("Connection save keeps blank credentials, rejects mode and strategy changes", async t => {
 const x = await setup(t);
 assert.equal((await x.call("/update", {id: "paper", name: "Renamed", apiKey: "", apiSecret: "  ", privateKey: ""})).code, 200);
 assert.equal(x.config().accounts[0].apiSecret, "saved-secret");
 assert.equal(x.config().accounts[0].privateKey, "saved-private");
 assert.equal((await x.call("/update", {id: "paper", tradeMode: "live"})).code, 400);
 assert.equal((await x.call("/update", {id: "paper", strategyType: "trend_only_v3"})).code, 400);
 assert.equal((await x.call("/update", {id: "paper", apiSecret: "new-secret"})).code, 200);
 assert.equal(x.config().accounts[0].apiSecret, "new-secret");
});
test("New exchange connection preserves asset/platform and has no executable strategy", async t => {
 const x = await setup(t);
 const r = await x.call("/create", {name: "BTC Hyper", platform: "hyperliquid", symbol: "BTC", initialEquity: 12000, privateKey: "new-private"});
 assert.equal(r.code, 200);
 const a = x.config().accounts.find(a => a.id === r.data.account.id);
 assert.equal(a.strategyType, "connection_only");assert.equal(a.running, false);
 assert.equal(a.simulationEnabled, true);assert.equal(a.tradeMode, "simulation");
 assert.equal(a.symbol, "BTC");assert.equal(a.privateKey, "new-private");
 assert.throws(() => require("../terminal/policy").assertEntry(a), /UNSUPPORTED_STRATEGY/);
 assert.doesNotMatch(JSON.stringify(r.data), /new-private/);
});
test("Live credential updates require native flat proof and never change real permissions", async t => {
 const x = await setup(t);x.rejectNative();
 assert.equal((await x.call("/update", {id: "live", privateKey: "replacement"})).code, 400);
 assert.equal(x.config().accounts[1].privateKey, "live-private");
 assert.equal(x.config().accounts[1].tradeMode, "live");
 assert.equal(x.counters().native, 1);
 x.states.paper.running = true;
 assert.equal((await x.call("/update", {id: "paper", apiKey: "replacement"})).code, 400);
});
test("Connection test uses read-only adapter without changing config or running state", async t => {
 const x = await setup(t), before = JSON.stringify(x.config());
 const r = await x.call("/check", {id: "paper"});
 assert.equal(r.code, 200);assert.equal(r.data.readOnly, true);
 assert.equal(x.counters().checks, 1);assert.equal(JSON.stringify(x.config()), before);
 assert.equal(x.states.paper.running, false);
});
test("Authorized Paper reset clears only strict simulation accounts and preserves Live and keys", () => {
 const config = {accounts: [
  {id: "p", name: "Paper", tradeMode: "simulation", simulationEnabled: true, simulationBalance: 100000, running: true, privateKey: "paper-key"},
  {id: "l", name: "Live", tradeMode: "live", simulationEnabled: false, running: true, privateKey: "live-key"},
  {id: "u", name: "Ambiguous", tradeMode: "simulation", simulationEnabled: false, running: true}
 ]};
 const ledgers = Object.fromEntries(Reset.files.map(f => [f, {p: {position: {qty: 99}, riskLock: true}, l: {position: {qty: .1}}, u: {pendingOrder: true}}]));
 const snapshot = JSON.stringify({config, ledgers}), result = Reset.plan(config, ledgers);
 assert.equal(result.report.resetAccounts.length, 1);assert.equal(result.report.skippedAccounts.length, 2);
 assert.equal(result.config.accounts[0].running, false);assert.equal(result.config.accounts[0].privateKey, "paper-key");
 assert.deepEqual(result.config.accounts[1], config.accounts[1]);
 for (const f of Reset.files) {assert.equal(result.ledgers[f].p, undefined);assert.deepEqual(result.ledgers[f].l, ledgers[f].l);assert.deepEqual(result.ledgers[f].u, ledgers[f].u);}
 assert.equal(JSON.stringify({config, ledgers}), snapshot);
});
test("Paper reset refuses unknown ledger shapes and absent original starting equity", () => {
 const p = {id: "p", tradeMode: "simulation", simulationEnabled: true};
 assert.throws(() => Reset.plan({accounts: [p]}, {}), /权益/);
 p.simulationBalance = 10000;
 assert.throws(() => Reset.plan({accounts: [p]}, {"profit_history.json": []}), /账本格式/);
});
