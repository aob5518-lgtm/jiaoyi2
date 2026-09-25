"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const V3 = require("../trend_only_v3");
const { calculateInitialStop } = require("../strategy/trend_v3/stops");
const { calculatePositionSize } = require("../strategy/trend_v3/position_sizing");
const { evaluateExit } = require("../strategy/trend_v3/exits");
const { evaluateReentry } = require("../strategy/trend_v3/reentry");
const { compareV2Shadow } = require("../strategy/trend_v3/shadow");
const { registerMissedCandidate, updateMissedOpportunities } = require("../strategy/trend_v3/posthoc");
const { buildStrategyAnalytics } = require("../strategy/trend_v3/analytics");
const { updatePostExitAnalytics } = require("../strategy/trend_v3/post_exit");
const { buildDecisionFunnel } = require("../strategy/trend_v3/diagnostics");
const { transition } = require("../strategy/trend_v3/state_machine");

function config(extra = {}) { return V3.normalizeConfig({ allowWeekendOpen: true, ...extra }); }
function input(extra = {}) {
  return {
    config: config(), signalTime: 1000, close: 101, open: 100.5, price: 101, atr: 1, chop: 44,
    emaFast: 100, emaMid: 99, diPlus: 35, diMinus: 15, adx: 32, adxHistory: [27, 30, 32],
    trendDirection: "long", higherDirection: "none", entryDirection: "long", structureLow: 99, structureHigh: 105,
    microHigh: 100.5, microLow: 99.5, pullbackLow: 99.2, pullbackHigh: 101, pullbackTouchedLong: true,
    pullbackTouchedShort: false, breakoutHigh: 102, breakoutLow: 98, swingContinuationLong: false,
    swingContinuationShort: false, compression: false, expansion: false, roundTripCostRate: 0.001,
    trendIndicators: { structureDirection: "long", emaFast: 100, emaMid: 99, emaFastSlope: 0.5, close: 101, adx: 32, adxHistory: [27, 30, 32], diPlus: 35, diMinus: 15, latestSwingHigh: 106, latestSwingLow: 97, swings: { highs: [{ price: 106 }], lows: [{ price: 97 }] } },
    higherIndicators: { structureDirection: "none", adx: 18, latestSwingHigh: 110, latestSwingLow: 94, swings: { highs: [{ price: 110 }], lows: [{ price: 94 }] } },
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
  assert.equal(voucher.grossR, voucher.grossPnl / voucher.initialEffectiveRiskU);
  assert.equal(voucher.netR, voucher.netPnl / voucher.initialEffectiveRiskU);
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

test("V3 再入场限制同 K 线、冷却、新结构与单趋势次数", () => {
  const c = { ...config(), entryIntervalMs: 15 * 60 * 1000 }, signal = { tradeDirection: "long", signalTime: 10_000_000, entryMode: "pullback_entry", structureLow: 101 };
  assert.equal(evaluateReentry({ lastEntrySignalTime: signal.signalTime }, signal, c).state, "REENTRY_COOLDOWN");
  const prior = { reentryState: { lastExitSignalTime: signal.signalTime - c.entryIntervalMs, direction: "long", structureLow: 100 } };
  assert.equal(evaluateReentry(prior, signal, c).state, "REENTRY_COOLDOWN");
  signal.signalTime += c.entryIntervalMs * c.reentryMinBars;
  assert.equal(evaluateReentry(prior, signal, c).allowed, true);
  const trendId = `long:${signal.signalTime}`;
  assert.equal(evaluateReentry({ trendContext: { trendId }, trendEntryCounts: { [trendId]: c.maxEntriesPerTrend } }, signal, c).state, "BLOCKED");
});

test("V2 Shadow 永远没有下单权限并保留 V2/V3 决策对照", () => {
  const v3Signal = V3.detectMarketRegime([], input()), comparison = compareV2Shadow("acc", input(), v3Signal);
  assert.equal(comparison.shadowOrderAllowed, false);
  assert.equal(comparison.postHocOnly, true);
  assert.ok(["allowed", "blocked", "wait_pullback", "wait_breakout", "wait_continuation"].includes(comparison.v3Decision));
  assert.ok(typeof comparison.v2Decision === "string");
});

test("错过机会分析仅使用信号之后的 K 线且不修改实时信号", () => {
  const state = {}, signal = { signalTime: 1000, entryPermission: "wait_pullback", directionRaw: "long", setupState: "WAIT_PULLBACK", structureLow: 99, blockers: ["等待回踩"] };
  assert.equal(registerMissedCandidate(state, signal, { close: 100, atr: 1 }), true);
  const before = JSON.stringify(signal), candles = [{ time: 900, high: 999, low: 1 }, ...Array.from({ length: 8 }, (_, idx) => ({ time: 1001 + idx, high: 100 + idx * .4, low: 99.8 }))];
  updateMissedOpportunities(state, candles);
  assert.equal(JSON.stringify(signal), before);
  assert.equal(state.missedOpportunityJournal[0].postHocOnly, true);
  assert.ok(state.missedOpportunityJournal[0].outcomes[8].forwardMFE < 4);
});

test("V3 分析按版本、实验、配置隔离并统一使用 netPnl/netR", () => {
  const rows = [
    { strategyVersion: "trend_only_v3", experimentId: "A", configHash: "h1", entryMode: "pullback_entry", exitTime: 1, grossPnl: 20, netPnl: 10, rMultiple: 2, netR: 1, tradingFee: 10 },
    { strategyVersion: "trend_only_v3", experimentId: "A", configHash: "h1", entryMode: "pullback_entry", exitTime: 2, grossPnl: -5, netPnl: -10, rMultiple: -.5, netR: -1, tradingFee: 5, closeReason: "hard_sl" },
    { strategyVersion: "trend_only_v3", experimentId: "B", configHash: "h2", entryMode: "breakout_entry", exitTime: 3, netPnl: 100, netR: 4 },
    { strategyVersion: "trend_only_v2", experimentId: "A", configHash: "h1", entryMode: "pullback_entry", exitTime: 4, netPnl: 100, netR: 4 }
  ];
  const result = buildStrategyAnalytics(rows, { strategyVersion: "trend_only_v3", experimentId: "A", configHash: "h1" });
  assert.equal(result.summary.trades, 2); assert.equal(result.summary.netPnl, 0); assert.equal(result.summary.avgNetR, 0); assert.equal(result.summary.winRate, .5);
  assert.equal(result.modes.pullback_entry.trades, 2); assert.equal(result.modes.breakout_entry.trades, 0);
  assert.equal(result.summary.falseEntryRate, .5);
});

test("Post Exit Analytics 仅使用退出后的 K 线并标记为事后数据", () => {
  const voucher = { strategyVersion: "trend_only_v3", exitTime: 1000, exitPrice: 100, side: "long", plannedRiskAmount: 10, positionSize: 10 };
  const candles = [{ time: 999, high: 999, low: 1 }, ...Array.from({ length: 32 }, (_, index) => ({ time: 1001 + index, high: 100 + index * .1, low: 99.5 }))];
  assert.equal(updatePostExitAnalytics([voucher], candles), true);
  assert.equal(voucher.postExitAnalyticsPostHocOnly, true);
  assert.ok(voucher.PostExitMFE_8 < 1);
  assert.ok(Number.isFinite(voucher.PostExitMFE_R_32));
  assert.equal(updatePostExitAnalytics([voucher], candles), false);
});

test("所有 V3 判断路径始终保留 structureHigh / structureLow", () => {
  const cases = [
    V3.detectMarketRegime([], input({ pullbackTouchedLong: false })),
    V3.detectMarketRegime([], input({ entryDirection: "short" })),
    V3.detectMarketRegime([], input({ chop: 70 })),
    V3.detectMarketRegime([], input({ gradeAThreshold: 99, gradeBThreshold: 98 })),
    V3.detectMarketRegime([], input({ pullbackTouchedLong: false, close: 104, breakoutHigh: 102, compression: true, expansion: true, emaFast: 100, maxEntryExtensionAtr: .5 }))
  ];
  for (const signal of cases) { assert.equal(signal.structureHigh, 105); assert.equal(signal.structureLow, 99); }
});

test("entryModes 只允许配置中启用的入场方式", () => {
  const breakoutMarket = input({ config: config({ entryModes: ["pullback_entry"] }), pullbackTouchedLong: false, close: 102.1, emaFast: 101, breakoutHigh: 102, compression: true, expansion: true, open: 101.5 });
  const blocked = V3.detectMarketRegime([], breakoutMarket);
  assert.notEqual(blocked.entryMode, "breakout_entry");
  const enabled = V3.detectMarketRegime([], { ...breakoutMarket, config: config({ entryModes: ["breakout_entry"] }) });
  assert.equal(enabled.entryMode, "breakout_entry");
});

test("CHOP、ADX 与 DI 配置会真实改变同一行情评分或许可", () => {
  const base = input({ chop: 50, adx: 24, diPlus: 31, diMinus: 20, trendIndicators: { ...input().trendIndicators, adx: 24, diPlus: 31, diMinus: 20 } });
  const normal = V3.detectMarketRegime([], { ...base, config: config() });
  const chopStrict = V3.detectMarketRegime([], { ...base, config: config({ chopTransitionMax: 49 }) });
  const adxStrict = V3.detectMarketRegime([], { ...base, config: config({ adxTrendStart: 26, adxTrendValid: 30, adxStrong: 35 }) });
  const diStrict = V3.detectMarketRegime([], { ...base, config: config({ minDiSpread: 20 }) });
  assert.notEqual(normal.scoreBreakdown.environment, chopStrict.scoreBreakdown.environment);
  assert.ok(adxStrict.scoreBreakdown.strength < normal.scoreBreakdown.strength);
  assert.ok(diStrict.scoreBreakdown.strength < normal.scoreBreakdown.strength);
});

test("higherTimeframeMode strict_align / not_against / off 行为不同", () => {
  const neutral = input({ higherDirection: "none" });
  assert.equal(V3.detectMarketRegime([], { ...neutral, config: config({ higherTimeframeMode: "strict_align" }) }).setupState, "BLOCKED");
  assert.notEqual(V3.detectMarketRegime([], { ...neutral, config: config({ higherTimeframeMode: "not_against" }) }).setupState, "BLOCKED");
  const opposite = input({ higherDirection: "short", higherIndicators: { structureDirection: "short", adx: 40 } });
  assert.equal(V3.detectMarketRegime([], { ...opposite, config: config({ higherTimeframeMode: "not_against" }) }).setupState, "BLOCKED");
  assert.notEqual(V3.detectMarketRegime([], { ...opposite, config: config({ higherTimeframeMode: "off" }) }).setupState, "BLOCKED");
});

test("Potential R 缺少可靠结构不假设 2.5R，空间不足阻断，3R 继续", () => {
  const state = V3.initialState(), account = { paper: true, equity: 10000, available: 10000, trendOnlyState: state, trendOnlyConfig: config({ maxStopDistanceAtr: 3 }) };
  const noSpaceInput = input({ trendIndicators: { ...input().trendIndicators, latestSwingHigh: null, swings: { highs: [], lows: [] } }, higherIndicators: { structureDirection: "none", adx: 18, swings: { highs: [], lows: [] } } });
  const signal = V3.detectMarketRegime([], noSpaceInput);
  const unknown = V3.tryOpenTrendOnlyPosition(account, signal, noSpaceInput);
  assert.equal(unknown.potentialR, null); assert.equal(unknown.setupState, "WAIT_STRUCTURE_SPACE");
  const near = input({ forwardResistance: 102 });
  assert.match(V3.tryOpenTrendOnlyPosition(account, V3.detectMarketRegime([], near), near).reason, /结构空间/);
  const far = input({ forwardResistance: 110 });
  assert.equal(V3.tryOpenTrendOnlyPosition(account, V3.detectMarketRegime([], far), far).allowed, true);
});

test("Cost Efficiency 不是固定送分且评分明细严格加总", () => {
  const cheap = V3.detectMarketRegime([], input({ roundTripCostRate: 0.0001 }));
  const costly = V3.detectMarketRegime([], input({ roundTripCostRate: 0.0015 }));
  assert.ok(cheap.scoreBreakdown.costEfficiency > costly.scoreBreakdown.costEfficiency);
  for (const signal of [cheap, costly]) {
    const b = signal.scoreBreakdown;
    assert.equal(b.structure + b.strength + b.multiTimeframe + b.environment + b.entryQuality + b.costEfficiency, b.total);
  }
});

test("净保本价格覆盖预计成本，实时与最终 Net R 使用相同 Risk Unit", () => {
  const state = V3.initialState(), account = { id: "risk", paper: true, equity: 10000, available: 10000, trendOnlyState: state, trendOnlyConfig: config({ maxStopDistanceAtr: 3 }) };
  const market = input({ forwardResistance: 110 }), signal = V3.detectMarketRegime([], market), plan = V3.tryOpenTrendOnlyPosition(account, signal, market);
  state.position = V3.positionFromFill(plan, { qty: plan.qty, price: plan.entryPrice, fee: 1, clientOrderId: "e", exchangeOrderId: "e" }, 1000, account.trendOnlyConfig);
  const p = state.position;
  assert.ok(p.netBreakEvenPrice > p.entryPrice);
  V3.manageTrendOnlyPosition(account, { price: p.entryPrice + p.plannedR * 1.6 }, { signalTime: 2000, close: p.entryPrice + p.plannedR * 1.6, atr: 1, emaFast: p.entryPrice, diPlus: 30, diMinus: 10, adxHistory: [30,31], entryDirection: "long", trendDirection: "long", higherDirection: "none" });
  assert.ok(p.currentStopLossPrice >= p.netBreakEvenPrice);
  const before = p.floatingNetR, voucher = V3.recordClose(account, { qty: p.positionSize, price: p.entryPrice + p.plannedR * 1.6, fee: 1, slippageCost: 0, clientOrderId: "x", exchangeOrderId: "x" }, "trend_tp", 3000);
  assert.equal(voucher.initialEffectiveRiskU, p.initialEffectiveRiskU); assert.ok(Math.abs(before - voucher.realizedNetR) < .1);
});

test("仓位 cap 后 R 按真实初始风险而不是预算风险", () => {
  const sizing = calculatePositionSize({ equity: 100000, available: 100, entryPrice: 100, stopDistance: 2, riskPerTrade: .01, riskMultiplier: 1, costRate: .001, leverage: 10, maxPositionRatio: .1, qtyStep: .001, minNotional: 10 });
  assert.equal(sizing.positionCapped, true); assert.ok(sizing.initialEffectiveRiskU < sizing.riskBudgetU);
  assert.equal(sizing.initialEffectiveRiskU / sizing.initialEffectiveRiskU, 1);
});

test("V3 最终净亏损含 slippage 并更新 dailyLoss 与 consecutiveLosses", () => {
  const state = V3.initialState(), account = { id: "loss", paper: true, equity: 10000, available: 10000, trendOnlyState: state, trendOnlyConfig: config({ maxStopDistanceAtr: 3 }) };
  const market = input({ forwardResistance: 110 }), plan = V3.tryOpenTrendOnlyPosition(account, V3.detectMarketRegime([], market), market);
  state.position = V3.positionFromFill(plan, { qty: plan.qty, price: plan.entryPrice, clientOrderId: "e", exchangeOrderId: "e" }, 1000, account.trendOnlyConfig);
  const v = V3.recordClose(account, { qty: plan.qty, price: plan.entryPrice, fee: 0, slippageCost: 7, clientOrderId: "x", exchangeOrderId: "x" }, "manual_close", 2000);
  assert.ok(Math.abs(v.netPnl + v.tradingFee + 7) < 1e-9); assert.equal(state.dailyLoss, -v.netPnl); assert.equal(state.consecutiveLosses, 1);
});

test("统一 Funnel 的 Cost / PotentialR 阻断与实际执行一致", () => {
  const costEval = { data:"PASS", trend:"PASS", environment:"PASS", setup:"PASS", cost:"BLOCK", rewardSpace:"WAITING", risk:"WAITING", execution:"BLOCK" };
  assert.equal(buildDecisionFunnel({}, { executionEvaluation: costEval }).find(step => step.key === "cost").status, "BLOCK");
  const rewardEval = { ...costEval, cost:"PASS", rewardSpace:"BLOCK" };
  assert.equal(buildDecisionFunnel({}, { executionEvaluation: rewardEval }).find(step => step.key === "rewardSpace").status, "BLOCK");
});

test("V2 Shadow 使用固定快照，不随 V3 参数变化", () => {
  const v3 = V3.detectMarketRegime([], input()), a = compareV2Shadow("a", input({ config: config({ chopTransitionMax: 50 }) }), v3), b = compareV2Shadow("a", input({ config: config({ chopTransitionMax: 60 }) }), v3);
  assert.equal(a.v2Decision, b.v2Decision); assert.equal(a.shadowConfigHash, b.shadowConfigHash); assert.equal(a.shadowBaselineId, "V2_STANDARD_20260922");
});

test("State Machine 拒绝非法跳转并允许标准生命周期", () => {
  assert.equal(transition("SCANNING", "READY_A", "signal").allowed, true);
  assert.equal(transition("READY_A", "ENTERED", "fill").allowed, true);
  const invalid = transition("MANAGING", "READY_A", "bad"); assert.equal(invalid.allowed, false); assert.match(invalid.error, /非法状态迁移/);
});

test("V3 DEFENSIVE 真正使用结构缓冲、最小距离和确认根数", () => {
  const c = config({ structureBreakBufferAtr: .25, structureReversalConfirmBars: 2, softExitMinBars: 2, defensiveStructureBufferAtr: .25, minDefensiveStopDistanceAtr: .5, defensiveTrailingAtrMultiplier: 1.2 });
  const p = { side:"long", entryPrice:100, initialStopLossPrice:98, currentStopLossPrice:98, signalTime:1, positionSize:1, initialEffectiveRiskU:2.2, expectedCostPerUnit:.2 };
  const weak = { signalTime: 1 + 3 * 15 * 60 * 1000, close:98.7, emaFast:99, diPlus:10, diMinus:30, adxHistory:[30,29], entryDirection:"short", trendDirection:"long", higherDirection:"none", structureLow:99, atr:1 };
  const first = evaluateExit(p,{price:98.7},weak,c);
  assert.equal(first.reason,"");assert.equal(p.defensiveMode,true);assert.equal(p.structureReversalCount,1);assert.ok(p.currentStopLossPrice <= 98.2);
  const second = evaluateExit(p,{price:98.65},{...weak,signalTime:weak.signalTime+15*60*1000,close:98.65},c);
  assert.equal(second.reason,"trend_reversal");
});
