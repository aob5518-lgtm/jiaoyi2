"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const V3 = require("../trend_only_v3");
const { calculateInitialStop } = require("../strategy/trend_v3/stops");
const { calculatePositionSize } = require("../strategy/trend_v3/position_sizing");
const { evaluateExit } = require("../strategy/trend_v3/exits");

function config(extra = {}) { return V3.normalizeConfig({ allowWeekendOpen: true, ...extra }); }
function input(extra = {}) {
  return {
    config: config(), signalTime: 1000, close: 101, open: 100.5, price: 101, atr: 1, chop: 44,
    emaFast: 100, emaMid: 99, diPlus: 35, diMinus: 15, adx: 32, adxHistory: [27, 30, 32],
    trendDirection: "long", higherDirection: "none", entryDirection: "long", structureLow: 99, structureHigh: 105,
    microHigh: 100.5, microLow: 99.5, pullbackLow: 99.2, pullbackHigh: 101, pullbackTouchedLong: true,
    pullbackTouchedShort: false, breakoutHigh: 102, breakoutLow: 98, swingContinuationLong: false,
    swingContinuationShort: false, compression: false, expansion: false,
    trendIndicators: { structureDirection: "long", emaFast: 100, emaMid: 99, emaFastSlope: 0.5, close: 101, adx: 32, adxHistory: [27, 30, 32], diPlus: 35, diMinus: 15 },
    higherIndicators: { structureDirection: "none", adx: 18 },
    ...extra
  };
}

test("V3 独立版本、标准默认值且 Live 默认关闭", () => {
  const c = config();
  assert.equal(c.version, "v3"); assert.equal(c.gradeAThreshold, 82); assert.equal(c.gradeBThreshold, 74);
  assert.equal(c.chopHardBlock, 61.8); assert.equal(c.maxAllowedCostR, 0.15); assert.equal(c.minimumPotentialR, 1.8); assert.equal(c.allowLive, false);
});

test("1H 强趋势、4H neutral、15m alignment 可达到可交易分数", () => {
  const signal = V3.detectMarketRegime([], input());
  assert.equal(signal.entryPermission, "allowed"); assert.equal(signal.tradeDirection, "long"); assert.ok(signal.trendScore >= 82); assert.equal(signal.grade, "A");
});

test("4H 轻微反向只扣分，强反向才 HARD_HTF_CONFLICT", () => {
  const mild = V3.detectMarketRegime([], input({ higherDirection: "short", higherIndicators: { structureDirection: "none", adx: 20 } }));
  assert.doesNotMatch((mild.blockers || []).join(" "), /HARD_HTF_CONFLICT/);
  const strong = V3.detectMarketRegime([], input({ higherDirection: "short", higherIndicators: { structureDirection: "short", adx: 35 } }));
  assert.match(strong.blockers.join(" "), /HARD_HTF_CONFLICT/); assert.equal(strong.setupState, "BLOCKED");
});

test("CHOP 52 不直接禁止，60 仅允许高质量 Pullback，65 Hard Block", () => {
  const at52 = V3.detectMarketRegime([], input({ chop: 52 })); assert.doesNotMatch(at52.blockers.join(" "), /强震荡禁止/);
  const at60 = V3.detectMarketRegime([], input({ chop: 60 })); assert.equal(at60.entryPermission, "allowed"); assert.equal(at60.entryMode, "pullback_entry");
  const at60Breakout = V3.detectMarketRegime([], input({ chop: 60, pullbackTouchedLong: false, close: 103, breakoutHigh: 102, compression: true, expansion: true })); assert.equal(at60Breakout.entryPermission, "wait_pullback");
  const at65 = V3.detectMarketRegime([], input({ chop: 65 })); assert.equal(at65.setupState, "BLOCKED"); assert.match(at65.blockers.join(" "), /强震荡/);
});

test("Pullback、Breakout、Continuation 生成不同结构止损且方向合法", () => {
  const c = config({ maxStopDistanceAtr: 3 });
  const pullback = calculateInitialStop({ side: "long", entryMode: "pullback_entry", entryPrice: 100, atr: 1, signal: { structureLow: 99 }, input: { pullbackLow: 99 }, config: c });
  const breakout = calculateInitialStop({ side: "long", entryMode: "breakout_entry", entryPrice: 100, atr: 1, signal: { structureLow: 99 }, input: { breakoutLow: 98.8 }, config: c });
  const continuation = calculateInitialStop({ side: "long", entryMode: "continuation_entry", entryPrice: 100, atr: 1, signal: { structureLow: 99 }, input: {}, config: c });
  assert.equal(new Set([pullback.stop, breakout.stop, continuation.stop]).size, 3);
  assert.ok([pullback, breakout, continuation].every(item => item.allowed && item.stop < 100));
  const short = calculateInitialStop({ side: "short", entryMode: "pullback_entry", entryPrice: 100, atr: 1, signal: { structureHigh: 101 }, input: { pullbackHigh: 101 }, config: c });
  assert.ok(short.allowed && short.stop > 100);
});

test("止损距离增加会降低仓位且最大计划风险不增加", () => {
  const base = { equity: 10000, available: 10000, entryPrice: 100, riskPerTrade: 0.01, riskMultiplier: 1, costRate: 0.002, leverage: 10, maxPositionRatio: 0.1, qtyStep: 0.001, minNotional: 10 };
  const tight = calculatePositionSize({ ...base, stopDistance: 1 }), wide = calculatePositionSize({ ...base, stopDistance: 2 });
  assert.ok(wide.qty < tight.qty); assert.ok(tight.effectiveRiskU <= tight.plannedRiskAmount + 0.01); assert.ok(wide.effectiveRiskU <= wide.plannedRiskAmount + 0.01);
});

test("Cost R 与 Potential R 执行过滤正确", () => {
  const state = V3.initialState(10000, 0), account = { id: "v3", platform: "hyperliquid", paper: true, equity: 10000, available: 10000, trendOnlyState: state, trendOnlyConfig: config({ maxAllowedCostR: 0.01, maxStopDistanceAtr: 3 }) };
  const signal = V3.detectMarketRegime([], input());
  assert.match(V3.tryOpenTrendOnlyPosition(account, signal, input()).reason, /交易成本/);
  account.trendOnlyConfig = config({ minimumPotentialR: 3, maxStopDistanceAtr: 3 });
  assert.match(V3.tryOpenTrendOnlyPosition(account, signal, input({ potentialR: 1.5 })).reason, /结构空间/);
});

test("Effective Risk sizing 与成交凭证统一 gross/net R", () => {
  const state = V3.initialState(10000, 0), account = { id: "v3", name: "V3", platform: "hyperliquid", symbol: "ETH", quoteAsset: "USDC", paper: true, equity: 10000, available: 10000, trendOnlyState: state, trendOnlyConfig: config({ maxStopDistanceAtr: 3 }) };
  const signal = V3.detectMarketRegime([], input()), plan = V3.tryOpenTrendOnlyPosition(account, signal, input({ potentialR: 3 }));
  assert.equal(plan.allowed, true, plan.reason); state.position = V3.positionFromFill(plan, { qty: plan.qty, price: plan.entryPrice, clientOrderId: "entry", exchangeOrderId: "paper-entry" }, 1000, account.trendOnlyConfig);
  const voucher = V3.recordClose(account, { qty: plan.qty, price: plan.entryPrice + 2, fee: 1, fundingPnl: 0.2, slippageCost: 0.3, clientOrderId: "exit", exchangeOrderId: "paper-exit" }, "trend_tp", 2000);
  assert.equal(voucher.netPnl, voucher.grossPnl - voucher.tradingFee + voucher.fundingPnl - voucher.slippageCost);
  assert.equal(voucher.grossR, voucher.grossPnl / voucher.plannedRiskAmount);
  assert.equal(voucher.netR, voucher.netPnl / voucher.plannedRiskAmount);
  assert.equal(voucher.strategyVersion, "trend_only_v3"); assert.equal(voucher.experimentId, "V3_STD_20260922_A"); assert.match(voucher.configHash, /^[a-f0-9]{64}$/);
});

test("V3 盈利保护：未到 1R 不保本，1.5R 才净保本，单个弱信号不退出", () => {
  const c = config(), position = { side: "long", entryPrice: 100, initialStopLossPrice: 98, currentStopLossPrice: 98, signalTime: 1, costR: 0.1 };
  let result = evaluateExit(position, { price: 101.8 }, { signalTime: 2, close: 101.8, emaFast: 101, diPlus: 30, diMinus: 20, adxHistory: [30, 29], entryDirection: "long", trendDirection: "long", higherDirection: "none", atr: 1 }, c);
  assert.equal(result.reason, ""); assert.equal(position.netBreakEvenActivated, false); assert.equal(position.currentStopLossPrice, 98);
  result = evaluateExit(position, { price: 103.1 }, { signalTime: 3, close: 103.1, emaFast: 104, diPlus: 30, diMinus: 20, adxHistory: [30, 29], entryDirection: "long", trendDirection: "long", higherDirection: "none", atr: 1 }, c);
  assert.equal(result.reason, ""); assert.equal(position.netBreakEvenActivated, true); assert.ok(position.currentStopLossPrice > 100);
});

test("强结构反转允许快速退出，单独 DI/ADX/15m 反向只进入防守计分", () => {
  const c = config(), make = () => ({ side: "long", entryPrice: 100, initialStopLossPrice: 98, currentStopLossPrice: 98, signalTime: 1, costR: 0.1 });
  for (const change of [{ adxHistory: [30, 29] }, { diPlus: 10, diMinus: 30 }, { entryDirection: "short" }]) {
    const p = make(), r = evaluateExit(p, { price: 100 }, { signalTime: 2, close: 100, emaFast: 99, diPlus: 30, diMinus: 20, adxHistory: [30, 31], entryDirection: "long", trendDirection: "long", higherDirection: "none", atr: 1, ...change }, c);
    assert.equal(r.reason, "");
  }
  const p = make(), strong = evaluateExit(p, { price: 98.4 }, { signalTime: 2, close: 98.4, emaFast: 99, diPlus: 10, diMinus: 30, adxHistory: [30, 29], entryDirection: "short", trendDirection: "short", higherDirection: "none", structureLow: 99, atr: 1 }, c);
  assert.equal(strong.reason, "trend_reversal");
});

test("V3 Paper only，Live 计划被明确拒绝", () => {
  const signal = V3.detectMarketRegime([], input()), account = { id: "live", platform: "hyperliquid", paper: false, equity: 10000, available: 10000, trendOnlyState: V3.initialState(), trendOnlyConfig: config() };
  assert.match(V3.tryOpenTrendOnlyPosition(account, signal, input()).reason, /仅开放 Paper/);
});
