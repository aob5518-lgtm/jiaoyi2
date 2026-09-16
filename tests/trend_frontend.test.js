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
  assert.match(html, /id="signalReplayFilter"/);
  assert.match(html, /允许开仓.*等待回踩.*等待突破.*等待延续.*追单阻断.*CHOP 阻断.*高周期反向.*风控阻断/s);
  assert.match(html, /距 EMA20.*distanceFromEmaAtr/s);
  assert.match(html, /function marketStatusClass/);
  assert.match(view, /保护止损单状态|stopOrderId|stopOrderPrice|stopLastSyncAt/);
  const renderStart = html.indexOf("const strategyRows = trendOnlyMode ? [");
  const renderEnd = html.indexOf("] : [", renderStart);
  assert.doesNotMatch(html.slice(renderStart, renderEnd), /下次补仓价|补仓次数/);
});

test("信号回放统计正确区分等待、追单、CHOP、高周期与风控阻断", () => {
  const view = require("../public/strategy-view.js");
  const counts = view.summarizeReplay([
    { entryPermission: "allowed", blockers: [] },
    { entryPermission: "wait_pullback", blockers: ["趋势有效，但价格已远离 EMA20，不追单"] },
    { entryPermission: "wait_breakout", blockers: ["等待突破确认"] },
    { entryPermission: "wait_continuation", blockers: ["高周期方向明显反向"] },
    { entryPermission: "blocked", blockers: ["CHOP 强震荡，禁止新开仓"] },
    { entryPermission: "blocked", blockers: ["risk_lock：保护止损单未确认"] }
  ]);
  assert.deepEqual(counts, { allowed: 1, pullback: 1, breakout: 1, continuation: 1, extended: 1, chop: 1, higher: 1, risk: 1 });
});

test("V2 运行时回填结构字段且 Extended Live 有明确提示", () => {
  const runtime = read("trend_runtime.js");
  const html = read("public/index.html");
  const panel = read("public/trend-only-panel.js");
  assert.match(runtime, /structureHigh: s\.signal\.structureHigh/);
  assert.match(runtime, /entryDirection = T\.directionOf\(values\[0\]\)/);
  assert.match(runtime, /distanceFromEmaAtr: s\.signal\.distanceFromEmaAtr/);
  assert.match(html, /Extended Live 趋势下单暂未开放；请使用 Paper 测试或切换 Hyperliquid\/Binance/);
  assert.match(html, /Extended 当前仅支持 Paper 趋势测试，Live 趋势下单未开放/);
  assert.doesNotMatch(panel, /maxChopToTrade/);
});

test("README 与示例配置推荐 Trend Only V2", () => {
  const readme = read("README.md"), config = JSON.parse(read("config.example.json"));
  assert.match(readme, /Trend Only V2 推荐规则/); assert.match(readme, /Extended Live 趋势下单暂未开放/);
  assert.equal(config.accounts[0].strategyType, "trend_only_v2"); assert.equal(config.accounts[0].trendOnlyConfig.version, "v2");
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
  assert.match(html, /function tradingPair/);
  assert.match(html, /raw\.endsWith\(quote\).*raw\.slice\(0, -quote\.length\)/s);
});
