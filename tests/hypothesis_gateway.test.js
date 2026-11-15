"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const gateway = require("../terminal/hypothesis-gateway");

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test("H01 main gateway uses server credential and the same isolated book", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "h01-gateway-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const accessFile = path.join(directory, "access.json");
  const access = "server-only-access-".repeat(3);
  fs.writeFileSync(accessFile, JSON.stringify({access}));
  let calls = 0;
  const upstream = await listen(t, (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer " + access);
    assert.equal(req.headers.cookie, undefined);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ok: true, accounts: [{id: "existing-isolated-book"}], allowLive: false}));
  });
  const port = await listen(t, (req, res) => gateway.handle(req, res, req.url, {accessFile, port: upstream}));
  const response = await fetch("http://127.0.0.1:" + port + "/api/v5/status", {
    headers: {Authorization: "Bearer untrusted-client-token", Cookie: "production-session=private"}
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.equal(JSON.parse(body).accounts[0].id, "existing-isolated-book");
  assert.ok(!body.includes(access));
  assert.equal(calls, 1);
  for (const [route, options, expected] of [
    ["/api/v5/orders", {method: "POST"}, 405],
    ["/api/v5/control", {method: "POST", headers: {Origin: "https://other.example"}}, 403],
    ["/api/v5/control", {method: "POST", body: "x".repeat(16385)}, 413]
  ]) assert.equal((await fetch("http://127.0.0.1:" + port + route, options)).status, expected);
  assert.equal(calls, 1);
});

test("Research lab removes retired strategy menus and distinguishes planning from execution", () => {
  const root = path.resolve(__dirname, "../public");
  const main = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(main, /JUST AGENT · 交易工作台/);
  assert.doesNotMatch(main, /Trend V3|Short-Term V1|4H Compound V1|\/terminal\/app.js/);
  assert.equal((main.match(/data-view=/g)||[]).length,0);
  assert.equal((main.match(/data-core-page=/g)||[]).length,0);
  assert.match(main,/<dialog id="page-parameters"[\s\S]*id="deskSettings"/);
  assert.match(main,/<dialog id="page-accounts"/);
  assert.match(main,/id="deskTurtlePane"/);
  assert.doesNotMatch(main,/策略分析|安全迁移|核对清单|href="\/safety-console|id="connectionDialog"/);
  assert.match(main, /id="deskSettings"/);
  assert.match(main, /id="deskFills"/);
  assert.match(main, /id="deskTrades"/);
  assert.match(main, /JUST AGENT/);
  assert.doesNotMatch(main, /SUPER AGENT/);
  assert.match(main, /id="newConnection"/);
  assert.doesNotMatch(main, /\/intelligent-trend.html/);
  assert.match(main, /经典规则没有自动止损/);
  assert.match(fs.readFileSync(path.join(root, "intelligent-trend.html"), "utf8"), /H01 仅作为现有参考基线/);
  assert.match(fs.readFileSync(path.join(root, "legacy-terminal.html"), "utf8"), /url=\/#archive/);
  const safety = fs.readFileSync(path.join(root, "safety-console.html"), "utf8");
  assert.match(safety, /\/terminal\/retired-safety.js/);
  assert.match(safety, /id="newAccount"[^>]*hidden disabled/);
});

test("H01 gateway failure is contained and never returns server credential content", async t => {
  const port = await listen(t, (req, res) => gateway.handle(req, res, req.url, {accessFile: "/missing-h01-access-file"}));
  const response = await fetch("http://127.0.0.1:" + port + "/api/v5/status");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {ok: false, error: "独立研究服务连接尚未配置"});
});

test("Retired risk console removes entry/configuration actions and preserves protective controls", async () => {
  const vm = require("vm");
  const calls = [], errors = [], nodes = {};
  const element = () => ({children: [], replaceChildren(...items) {this.children = items;}, append(...items) {this.children.push(...items);}});
  const A = {
    state: {data: {account: {name: "old"}, overview: {health: {running: false}, orders: [], position: null}}},
    control: async action => calls.push(action), renderOverview() {},
    error: message => errors.push(message), $: id => nodes[id] ||= element(),
    el: () => element(), rows() {}, button: (label, click) => ({label, click})
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../public/terminal/retired-safety.js"), "utf8"), {window: {SA: A}});
  await A.control("start");A.newAccount();
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 2);
  await A.control("pause");await A.control("close");await A.control("cancel_pending");
  assert.deepEqual(calls, ["pause", "close", "cancel_pending"]);
  A.renderStrategies();
  assert.equal(nodes.strategyCards.children.length, 0);
  A.renderOverview();
  assert.equal(nodes.primaryActions.children.length, 2);
  assert.ok(nodes.primaryActions.children.every(item => !/启动|创建|配置/.test(item.label)));
});
