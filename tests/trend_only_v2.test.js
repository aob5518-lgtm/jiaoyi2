const { test } = require("node:test");
const assert = require("node:assert/strict");
const V2 = require("../trend_only_v2");

const now = Date.parse("2026-09-15T12:00:00Z");
function input(overrides = {}) {
  const config = V2.normalizeConfig({ allowWeekendOpen: true });
  return { config, signalTime: now, close: 100, price: 100, atr: 2, chop: 47.99, adx: 39,
    adxHistory: [39, 39, 39], emaFast: 102, emaMid: 105, emaSlope: -1, diPlus: 10, diMinus: 35,
    breakoutHigh: 110, breakoutLow: 99, microHigh: 104, microLow: 99, pullbackHigh: 103, pullbackLow: 98,
    trendDirection: "short", higherDirection: "none", lowerHigh: false, lowerLow: false, ...overrides };
}
function account(position = null) {
  const trendOnlyConfig = V2.normalizeConfig({ allowWeekendOpen: true });
  const trendOnlyState = V2.initialState(); trendOnlyState.position = position;
  return { id: "v2", name: "V2", platform: "hyperliquid", symbol: "ETH", quoteAsset: "USDC", paper: true, equity: 10000, available: 10000, trendOnlyConfig, trendOnlyState };
}
function position() {
  return { side: "long", entryPrice: 100, initialStopLossPrice: 98, currentStopLossPrice: 98, highestPriceSinceEntry: 100, lowestPriceSinceEntry: 100,
    positionSize: 1, positionValue: 100, leverage: 10, signalTime: now - 900000, breakoutLevel: 99, config: V2.normalizeConfig({ allowWeekendOpen: true }),
    breakEvenActivated: false, softBreakEvenActivated: false, locked1R: false, trailingActive: false, defensiveMode: false, reversalCount: 0 };
}

test("CHOP 47.99 + ADX 39 不会把空头原始方向归零", () => {
  const signal = V2.detectMarketRegimeV2([], input());
  assert.equal(signal.directionRaw, "short"); assert.equal(signal.direction, "short");
  assert.ok(signal.regime === "trend_continuation" || signal.entryPermission === "wait_pullback");
});
test("V2 忽略旧 maxChopToTrade 并接受 transition=52", () => {
  const config = V2.normalizeConfig({ maxChopToTrade: 1, chopTransitionMax: 52 });
  assert.equal(config.chopTransitionMax, 52); assert.equal(Object.hasOwn(config, "maxChopToTrade"), false);
  const signal = V2.detectMarketRegimeV2([], input({ config, chop: 47.99, adx: 39 }));
  assert.equal(signal.directionRaw, "short"); assert.notEqual(signal.entryPermission, "blocked");
});
test("ADX 高但未连续上升仍识别趋势延续", () => {
  const signal = V2.detectMarketRegimeV2([], input({ chop: 42, adx: 37, adxHistory: [38, 36, 37] }));
  assert.equal(signal.directionRaw, "short"); assert.equal(signal.regime, "trend_continuation");
});
test("远离 EMA20 超过 1.5 ATR 时等待回踩", () => {
  const signal = V2.detectMarketRegimeV2([], input({ close: 98, emaFast: 102 }));
  assert.equal(signal.entryPermission, "wait_pullback"); assert.equal(signal.regime, "extended_no_chase"); assert.match(signal.blockers.join(" "), /远离 EMA20/);
});
test("做空曾触碰 EMA 后离开并跌破 micro low 允许 pullback_entry", () => {
  const signal = V2.detectMarketRegimeV2([], input({ close: 98, emaFast: 102, microLow: 99, pullbackHigh: 102, structureHigh: 103, pullbackTouchedShort: true }));
  assert.equal(signal.entryPermission, "allowed"); assert.equal(signal.entryMode, "pullback_entry");
});
test("swing lower high / lower low 允许 continuation_entry", () => {
  const signal = V2.detectMarketRegimeV2([], input({ chop: 44, swingContinuationShort: true }));
  assert.equal(signal.entryPermission, "allowed"); assert.equal(signal.entryMode, "continuation_entry");
});
test("震荡假 lower low 不允许 continuation_entry", () => {
  const signal = V2.detectMarketRegimeV2([], input({ chop: 44, swingContinuationShort: false }));
  assert.notEqual(signal.entryMode, "continuation_entry");
});
test("detectSwings 识别局部 swing highs / lows", () => {
  const candles = [
    [10, 8], [11, 7], [14, 9], [12, 8], [10, 5], [11, 8], [13, 9], [11, 7], [9, 6]
  ].map(([high, low], index) => ({ time: index, high, low, open: 9, close: 9 }));
  const swings = V2.detectSwings(candles, candles.length);
  assert.deepEqual(swings.highs.map(item => item.price), [14, 13]);
  assert.deepEqual(swings.lows.map(item => item.price), [5]);
});
test("实盘指标通过 2/2 swing lower highs / lower lows 识别做空延续", () => {
  const ms = V2.INTERVALS["15m"], start = now - 261 * ms;
  const candles = Array.from({ length: 260 }, (_, index) => {
    const center = 200 - index * 0.25 + Math.sin(index * 1.2 + 2) * 1.8;
    return { time: start + index * ms, open: center + 0.2, close: center - 0.2, high: center + 0.6, low: center - 0.6 };
  });
  const indicators = V2.indicatorsFor(candles, V2.normalizeConfig({ allowWeekendOpen: true }), "15m", now);
  assert.equal(indicators.swingContinuationShort, true);
  assert.ok(indicators.swings.highs.length >= 3); assert.ok(indicators.swings.lows.length >= 2);
});
test("震荡 swing 假 lower low 不形成做空延续", () => {
  const ms = V2.INTERVALS["15m"], start = now - 261 * ms;
  const candles = Array.from({ length: 260 }, (_, index) => {
    const center = 150 + Math.sin(index * 1.2) * 1.8;
    return { time: start + index * ms, open: center + 0.2, close: center - 0.2, high: center + 0.6, low: center - 0.6 };
  });
  const indicators = V2.indicatorsFor(candles, V2.normalizeConfig({ allowWeekendOpen: true }), "15m", now);
  assert.equal(indicators.swingContinuationShort, false);
});
test("趋势衰减只进入 defensiveMode，不直接平仓", () => {
  const p = position(), a = account(p);
  const result = V2.manageTrendOnlyPosition(a, { price: 101 }, { signalTime: now, close: 100.4, atr: 1, chop: 54, adxHistory: [40, 38, 36], emaFast: 100.5, emaMid: 99, diPlus: 30, diMinus: 10, trendDirection: "long", higherDirection: "long", structureLow: 99.5 });
  assert.equal(result.reason, ""); assert.equal(p.defensiveMode, true);
});
test("defensiveMode 使用 structureLow 收紧止损", () => {
  const p = position(); p.defensiveMode = true; const a = account(p);
  const result = V2.manageTrendOnlyPosition(a, { price: 100.5 }, { signalTime: now, close: 100.2, atr: 1, chop: 54, adxHistory: [40, 38, 36], emaFast: 100.4, emaMid: 99, diPlus: 30, diMinus: 10, trendDirection: "long", higherDirection: "long", structureLow: 99.8 });
  assert.equal(result.reason, ""); assert.equal(p.currentStopLossPrice, 99.8);
});
test("结构位反向突破立即触发 trend_reversal", () => {
  const p = position(), a = account(p);
  const result = V2.manageTrendOnlyPosition(a, { price: 99 }, { signalTime: now, close: 98.9, atr: 1, chop: 45, adxHistory: [35, 35, 35], emaFast: 100, emaMid: 99, diPlus: 30, diMinus: 10, trendDirection: "long", higherDirection: "long", structureLow: 99.2 });
  assert.equal(result.reason, "trend_reversal");
});
test("结构字段缺失不报错并记录结构位不足", () => {
  const p = position(); p.defensiveMode = true; const a = account(p);
  const result = V2.manageTrendOnlyPosition(a, { price: 100.5 }, { signalTime: now, close: 100.2, atr: 1, chop: 54, adxHistory: [40, 38, 36], emaFast: 100.4, emaMid: 99, diPlus: 30, diMinus: 10, trendDirection: "long", higherDirection: "long" });
  assert.equal(result.reason, ""); assert.match(result.logs.join(" "), /结构位不足/);
});
test("EMA/DI 反转需要等待 reversalConfirmBars", () => {
  const p = position(), a = account(p);
  const reversed = { close: 101, atr: 1, chop: 45, adxHistory: [35, 35, 35], emaFast: 99, emaMid: 100, diPlus: 10, diMinus: 30, trendDirection: "long", higherDirection: "none" };
  assert.equal(V2.manageTrendOnlyPosition(a, { price: 101 }, { ...reversed, signalTime: now }).reason, "");
  assert.equal(V2.manageTrendOnlyPosition(a, { price: 101 }, { ...reversed, signalTime: now + 900000 }).reason, "trend_reversal");
});
for (const [name, price, expected] of [["1R 移动到 -0.2R", 102, { stop: 99.6, soft: true }], ["1.5R 移动到保本", 103, { stop: 100, breakEven: true }], ["2.5R 锁定 1R", 105, { stop: 102, locked: true }], ["3R 启动 ATR 移动止盈", 106, { trailing: true }]]) test(name, () => {
  const p = position(), a = account(p), result = V2.manageTrendOnlyPosition(a, { price }); assert.equal(result.reason, "");
  if (expected.stop !== undefined) assert.equal(p.currentStopLossPrice, expected.stop);
  if (expected.soft) assert.equal(p.softBreakEvenActivated, true); if (expected.breakEven) assert.equal(p.breakEvenActivated, true);
  if (expected.locked) assert.equal(p.locked1R, true); if (expected.trailing) assert.equal(p.trailingActive, true);
});
test("每根已收盘 K 线写一次 shadow signal，最多保留 1000 条", () => {
  const state = V2.initialState();
  for (let n = 1; n <= 1002; n++) { const i = input({ signalTime: now + n * 900000 }); const signal = V2.detectMarketRegimeV2([], i); assert.equal(V2.appendShadowSignal(state, "v2", signal, i, "review"), true); }
  assert.equal(state.signalJournal.length, 1000);
  const i = input({ signalTime: state.lastJournalSignalTime }), signal = V2.detectMarketRegimeV2([], i); assert.equal(V2.appendShadowSignal(state, "v2", signal, i), false);
});
test("V2 仓位计划保持单仓且按延续入场降低风险", () => {
  const a = account(), i = input({ chop: 44, swingContinuationShort: true, qtyStep: 0.001, minNotional: 10 });
  const signal = V2.detectMarketRegimeV2([], i); V2.updateTrendContext(a.trendOnlyState, signal, i);
  const plan = V2.tryOpenTrendOnlyPosition(a, signal, i);
  assert.equal(plan.allowed, true); assert.equal(plan.entryMode, "continuation_entry"); assert.equal(plan.riskMultiplier, 0.7);
});
test("同一趋势退出后冷却，出现新结构后可再次入场", () => {
  const a = account(), state = a.trendOnlyState, config = a.trendOnlyConfig;
  state.lastExitSignalTime = now; state.lastExitEntryMode = "continuation_entry"; state.lastExitReason = "trend_tp"; state.lastExitStructureHigh = 104;
  const earlyI = input({ config, signalTime: now + 3 * V2.INTERVALS[config.entryTimeframe], chop: 44, swingContinuationShort: true, structureHigh: 102, qtyStep: 0.001, minNotional: 10 });
  const earlySignal = V2.detectMarketRegimeV2([], earlyI);
  assert.match(V2.tryOpenTrendOnlyPosition(a, earlySignal, earlyI).reason, /冷却中/);
  const laterI = { ...earlyI, signalTime: now + 7 * V2.INTERVALS[config.entryTimeframe] };
  const laterSignal = V2.detectMarketRegimeV2([], laterI);
  assert.equal(V2.tryOpenTrendOnlyPosition(a, laterSignal, laterI).allowed, true);
  state.lastEntrySignalTime = laterSignal.signalTime;
  assert.match(V2.tryOpenTrendOnlyPosition(a, laterSignal, laterI).reason, /同一根 K 线/);
});
test("Extended Live V2 不允许提交开仓计划", () => {
  const a = account(); a.paper = false; a.platform = "extended";
  const i = input({ chop: 44, swingContinuationShort: true, qtyStep: 0.001, minNotional: 10 });
  const signal = V2.detectMarketRegimeV2([], i);
  assert.match(V2.tryOpenTrendOnlyPosition(a, signal, i).reason, /Extended Live 趋势下单暂未开放/);
});
test("risk_lock 状态禁止新开仓", () => {
  const a = account(); a.trendOnlyState.riskLock = true; a.trendOnlyState.riskLockReason = "保护止损单未确认";
  const i = input({ chop: 44, swingContinuationShort: true, qtyStep: 0.001, minNotional: 10 });
  const signal = V2.detectMarketRegimeV2([], i);
  assert.match(V2.tryOpenTrendOnlyPosition(a, signal, i).reason, /risk_lock.*保护止损单未确认/);
});
