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

test("H01 homepage exposes only H01 and retains a separate historical safety entry", () => {
  const root = path.resolve(__dirname, "../public");
  const main = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(main, /H01 趋势工作台/);
  assert.doesNotMatch(main, /Trend V3|Short-Term V1|4H Compound V1|\/terminal\/app.js/);
  assert.match(main, /href="\/legacy-terminal.html"/);
  assert.deepEqual([...main.matchAll(/data-view="([^"]+)"/g)].map(x => x[1]), ["overview", "settings", "history", "analysis"]);
  assert.equal(main.replace(/\r\n/g, "\n"), fs.readFileSync(path.join(root, "intelligent-trend.html"), "utf8").replace(/\r\n/g, "\n"));
  assert.match(fs.readFileSync(path.join(root, "legacy-terminal.html"), "utf8"), /\/terminal\/app.js/);
});

test("H01 gateway failure is contained and never returns server credential content", async t => {
  const port = await listen(t, (req, res) => gateway.handle(req, res, req.url, {accessFile: "/missing-h01-access-file"}));
  const response = await fetch("http://127.0.0.1:" + port + "/api/v5/status");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {ok: false, error: "独立研究服务连接尚未配置"});
});
