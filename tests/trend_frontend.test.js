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
  assert.match(read("public/trend-only-panel.js"), /一键升级到 Trend Only V2/);
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
  assert.deepEqual(counts, { signalOpportunities: 1, executable: 0, submitted: 0, filled: 0, allowed: 1, pullback: 1, breakout: 1, continuation: 1, extended: 1, chop: 1, higher: 1, risk: 1 });
});

test("24/72 小时统计包含 ADX、CHOP、多周期与追单阻断", () => {
  const view = require("../public/strategy-view.js"), now = Date.parse("2026-09-18T12:00:00Z");
  const items = [
    { time: now - 3600000, entryPermission: "blocked", blockers: ["ADX=17，趋势强度不足"] },
    { time: now - 2 * 3600000, entryPermission: "blocked", blockers: ["CHOP 强震荡"] },
    { time: now - 3 * 3600000, entryPermission: "blocked", blockers: ["高周期方向明显反向"] },
    { time: now - 4 * 3600000, entryPermission: "wait_pullback", blockers: ["价格已远离 EMA20，不追单"] }
  ];
  const stats = view.summarizeReplayWindow(items, 24, now);
  assert.equal(stats.total, 4); assert.equal(stats.adx, 1); assert.equal(stats.chop, 1); assert.equal(stats.higher, 1); assert.equal(stats.extended, 1);
});

test("连续 48 小时无 allowed 信号时显示参数过严提醒", () => {
  const view = require("../public/strategy-view.js"), now = Date.parse("2026-09-18T12:00:00Z");
  const items = Array.from({ length: 50 }, (_, index) => ({ time: now - index * 3600000, entryPermission: "blocked", blockers: ["ADX 趋势强度不足"] }));
  const warnings = view.strictnessWarnings(items, now);
  assert.match(warnings.join(" "), /过去 48 小时没有出现可开仓信号/); assert.match(warnings.join(" "), /主要原因：趋势强度不足/);
});

test("截图场景明确说明是策略过滤而非系统故障", () => {
  const view = require("../public/strategy-view.js");
  const trend = { signal: { entryPermission: "blocked", diagnostics: {
    chop: { value: 52.8, threshold: { ideal: 45, transition: 55, hardBlock: 61.8 }, passed: true, label: "过渡" },
    adx: { value: 17.65, threshold: 22, passed: false, label: "趋势强度不足" },
    direction: { entryDirection: "none", trendDirection: "long", higherDirection: "none", passed: false, timeframePassed: true },
    finalBlockers: ["ADX 趋势强度不足"]
  } } };
  const text = view.diagnosticSummary(trend);
  assert.match(text, /1H 出现做多趋势/); assert.match(text, /ADX=17\.65/); assert.match(text, /CHOP=52\.80 处于偏震荡区/); assert.match(text, /不属于系统故障/);
  assert.equal(view.opportunityStatus(trend), "无机会：ADX 弱");
});

test("V1 总览和配置页显示升级 V2 强提示", () => {
  const html = read("public/index.html"), panel = read("public/trend-only-panel.js");
  assert.match(html, /当前账户正在使用 Trend Only V1。V1 过滤更严格/);
  assert.match(html, /id="overviewUpgradeV2Btn"/);
  assert.match(panel, /当前账户正在使用 Trend Only V1。V1 过滤更严格/);
  assert.match(panel, /一键升级到 Trend Only V2/);
  assert.match(html, /当前有趋势仓位，平仓后才能升级/);
  assert.match(html, /需要先停止趋势监控才能升级/);
  assert.match(panel, /订单尚未确认，暂不能升级/);
});

test("机会状态优先采用 executionState，而不是信号 allowed", () => {
  const view = require("../public/strategy-view.js");
  assert.equal(view.opportunityStatus({ executionState: "MONITOR_STOPPED", signal: { entryPermission: "allowed" } }), "监控已停止");
  assert.equal(view.opportunityStatus({ executionState: "WAIT_LIVE_CONFIRM", signal: { entryPermission: "allowed" } }), "等待 Live 确认");
  assert.equal(view.opportunityStatus({ executionState: "ACCOUNT_CONFLICT", signal: { entryPermission: "allowed" } }), "账户冲突");
});

test("V2 运行时回填结构字段且 Extended Live 有明确提示", () => {
  const runtime = read("trend_runtime.js");
  const html = read("public/index.html");
  const panel = read("public/trend-only-panel.js");
  assert.match(runtime, /structureHigh: s\.signal\.structureHigh/);
  assert.match(runtime, /entryDirection: T\.directionOf\(values\[0\]\)/);
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
