"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict"), http = require("http");
const Connections = require("../terminal/connections"), Reset = require("../terminal/paper-reset");
async function setup(t) {
 let config = {currentAccountId: "paper", accounts: [
  {id: "paper", name: "Paper", platform: "binance", symbol: "ETH", quoteAsset: "USDT", tradeMode: "simulation", simulationEnabled: true, simulationBalance: 10000, strategyType: "classic", apiKey: "saved-key", apiSecret: "saved-secret", privateKey: "saved-private"},
  {id: "live", name: "Live", platform: "hyperliquid", symbol: "ETH", tradeMode: "live", simulationEnabled: false, privateKey: "live-private"}
 ]};
 const states = {paper: {running: false}, live: {running: false}};
 let checks = 0, native = 0, failNative = false;
 const d = {
  accounts: () => config.accounts, configuration: () => structuredClone(config), getCurrentAccount: () => config.accounts[0],
  getAccountById: id => config.accounts.find(account => account.id === id), state: id => states[id],
  save: value => {config = value;for (const account of value.accounts) states[account.id] ||= {running: false};},
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
 return {call, states, config: () => config, counters: () => ({checks, native}), rejectNative: () => {failNative = true;}};
}
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
