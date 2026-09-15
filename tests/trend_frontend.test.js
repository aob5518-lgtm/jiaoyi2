const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const base = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(base, file), "utf8");

test("Trend Only V1 总览不渲染经典补仓字段", () => {
  const html = read("public/index.html");
  assert.match(html, /trendOnlyMode \? \[/);
  assert.match(html, /策略视图模块加载失败，请刷新页面或检查静态资源。/);
  const renderStart = html.indexOf("const strategyRows = trendOnlyMode ? [");
  const renderEnd = html.indexOf("] : [", renderStart);
  const trendBranch = html.slice(renderStart, renderEnd);
  assert.doesNotMatch(trendBranch, /经典补仓策略/);
  assert.doesNotMatch(trendBranch, /下次补仓价/);
});

test("Trend Only V1/V2 模式隐藏手动测试和重置按钮", () => {
  const html = read("public/index.html");
  assert.match(html, /button\.hidden = trendOnly/);
  assert.match(html, /Trend Only 禁止手动加仓/);
  assert.match(html, /趋势状态不可通过重置清除/);
});

test("Trend Only V2 展示阻断原因、信号回放且不显示 DCA 字段", () => {
  const html = read("public/index.html");
  const view = read("public/strategy-view.js");
  assert.match(html, /id="signalReplayPanel"/);
  assert.match(html, /signalJournal/);
  assert.match(view, /当前阻断原因/);
  assert.match(view, /原始趋势方向/);
  assert.match(view, /交易方向/);
  assert.match(read("public/trend-only-panel.js"), /一键升级到 V2/);
  const renderStart = html.indexOf("const strategyRows = trendOnlyMode ? [");
  const renderEnd = html.indexOf("] : [", renderStart);
  assert.doesNotMatch(html.slice(renderStart, renderEnd), /下次补仓价|补仓次数/);
});

test("mobile_view.html 是公开只读页，不加载趋势管理面板", () => {
  const html = read("public/mobile_view.html");
  assert.match(html, /\/api\/public\/status/);
  assert.doesNotMatch(html, /\/api\/trend-only/);
  assert.doesNotMatch(html, /trend-only-panel\.js/);
  assert.doesNotMatch(html, /保存参数|确认本次 Live 开仓|平掉趋势仓位|管理按钮/);
});

test("strategy-view.js 加载失败时页面不白屏", () => {
  const html = read("public/index.html");
  assert.match(html, /__strategyViewLoadFailed/);
  assert.match(html, /fallbackTrendView/);
  assert.match(html, /策略视图模块加载失败，请刷新页面或检查静态资源。/);
});

test("账户搜索和状态筛选控件存在并接入渲染", () => {
  const html = read("public/index.html");
  assert.match(html, /id="accountSearch"/);
  assert.match(html, /id="accountFilter"/);
  assert.match(html, /function accountMatchesFilter/);
  assert.match(html, /hasPendingOrder/);
});
