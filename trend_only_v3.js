"use strict";

const crypto = require("crypto");
const V1 = require("./trend_only");
const V2 = require("./trend_only_v2");
const { DEFAULTS, PRESETS, normalizeConfig } = require("./strategy/trend_v3/config");
const { indicatorsFor, directionOf, detectSwings } = require("./strategy/trend_v3/indicators");
const { detectMarketRegime } = require("./strategy/trend_v3/regime");
const { calculateInitialStop } = require("./strategy/trend_v3/stops");
const { calculatePositionSize } = require("./strategy/trend_v3/position_sizing");
const { buildTradeCostModel } = require("./strategy/trend_v3/costs");
const { evaluateExit } = require("./strategy/trend_v3/exits");
const { buildDecisionFunnel } = require("./strategy/trend_v3/diagnostics");
const { evaluateReentry, recordExitState } = require("./strategy/trend_v3/reentry");
const { compareV2Shadow } = require("./strategy/trend_v3/shadow");
const { registerMissedCandidate, updateMissedOpportunities } = require("./strategy/trend_v3/posthoc");
const { buildCandidateSetup } = require("./strategy/trend_v3/candidate");
const { updatePostExitAnalytics } = require("./strategy/trend_v3/post_exit");
const { calculateRewardSpace } = require("./strategy/trend_v3/reward_space");
const { transition } = require("./strategy/trend_v3/state_machine");

function initialState(equity, now) {
  return { ...V2.initialState(equity, now), strategyVersion: "trend_only_v3", strategyState: "SCANNING", stateTransitionLog: [], reentryState: {}, trendEntryCounts: {}, shadowComparisons: [], missedOpportunityJournal: [] };
}

function evaluation(signal) {
  return {
    data: (signal.hardBlockers || []).some(value => /数据|行情/.test(value)) ? "BLOCK" : "PASS",
    trend: signal.directionRaw === "none" ? "WAITING" : "PASS",
    environment: signal.setupState === "BLOCKED" ? "BLOCK" : Number(signal.scoreBreakdown?.environment || 0) <= 2 ? "CONDITIONAL" : "PASS",
    setup: signal.entryPermission === "allowed" ? "PASS" : signal.setupState === "BLOCKED" ? "BLOCK" : "WAITING",
    cost: "WAITING", rewardSpace: "WAITING", risk: "WAITING", execution: "WAITING",
    blocker: ""
  };
}
function reject(reason, key, executionEvaluation, extra = {}) {
  const result = { ...executionEvaluation, [key]: "BLOCK", execution: "BLOCK", blocker: reason };
  return { allowed: false, reason, executionEvaluation: result, ...extra };
}

function tryOpenTrendOnlyPosition(account, signal, input) {
  const config = normalizeConfig(account.trendOnlyConfig), state = account.trendOnlyState || {}, executionEvaluation = evaluation(signal);
  if (signal.entryPermission !== "allowed" || !signal.tradeDirection) return reject((signal.blockers || []).join("；") || "当前没有可执行的 V3 setup", "setup", executionEvaluation);
  if (!account.paper) return reject("Trend Only V3 当前仅开放 Paper；Live 须完成 Forward Test 后另行启用。", "execution", executionEvaluation);
  if (state.riskLock) return reject(`risk_lock：${state.riskLockReason || "安全锁定"}`, "risk", executionEvaluation);
  const reentry = evaluateReentry(state, signal, { ...config, entryIntervalMs: V1.INTERVALS[config.entryTimeframe] });
  if (!reentry.allowed) return reject(reentry.reason, "execution", executionEvaluation, { setupState: reentry.state });
  const trendId = reentry.trendId;
  const entryPrice = Number(input.price || input.close), atr = Number(input.atr);
  const stop = calculateInitialStop({ side: signal.tradeDirection, entryMode: signal.entryMode, entryPrice, atr, signal, input, config });
  if (!stop.allowed) return reject(stop.reason, "risk", executionEvaluation, stop);
  const cost = buildTradeCostModel(account, signal.entryMode);
  const costR = entryPrice * cost.roundTripCostRate / (stop.distance + entryPrice * cost.roundTripCostRate);
  executionEvaluation.cost = costR > config.maxAllowedCostR ? "BLOCK" : "PASS";
  if (costR > config.maxAllowedCostR) return reject(`预计交易成本 ${costR.toFixed(3)}R 超过上限 ${config.maxAllowedCostR}R`, "cost", executionEvaluation, { costR });
  const rewardSpace = calculateRewardSpace(input, signal.tradeDirection, entryPrice, stop.distance);
  const potentialR = rewardSpace.potentialR;
  if (!Number.isFinite(potentialR)) return reject("前方缺少可靠的 1H/4H 确认结构空间，等待结构形成", "rewardSpace", executionEvaluation, { potentialR: null, rewardSpace, setupState: "WAIT_STRUCTURE_SPACE" });
  executionEvaluation.rewardSpace = potentialR < config.minimumPotentialR ? "BLOCK" : "PASS";
  if (potentialR < config.minimumPotentialR) return reject(`前方结构空间仅 ${potentialR.toFixed(2)}R，低于 ${config.minimumPotentialR}R`, "rewardSpace", executionEvaluation, { potentialR, rewardSpace });
  const sizing = calculatePositionSize({ equity: account.equity, available: account.available ?? account.equity, entryPrice, stopDistance: stop.distance, riskPerTrade: config.riskPerTrade, riskMultiplier: signal.riskMultiplier, costRate: cost.roundTripCostRate, leverage: config.leverage, maxPositionRatio: config.maxPositionRatio, qtyStep: Number(input.qtyStep || 0.000001), minNotional: Number(input.minNotional || 10) });
  if (!sizing.allowed) return reject(sizing.reason, "risk", executionEvaluation, sizing);
  const costModel = buildTradeCostModel(account, signal.entryMode, { notional: sizing.positionValue, plannedRiskAmount: sizing.plannedRiskAmount });
  Object.assign(executionEvaluation, { risk: "PASS", execution: "PASS", blocker: "" });
  return { allowed: true, side: signal.tradeDirection, qty: sizing.qty, entryPrice, positionValue: sizing.positionValue, riskAmount: sizing.initialEffectiveRiskU, plannedRiskAmount: sizing.riskBudgetU, riskBudgetU: sizing.riskBudgetU, initialPriceRiskU: sizing.initialPriceRiskU, initialEffectiveRiskU: sizing.initialEffectiveRiskU, effectiveRiskU: sizing.initialEffectiveRiskU, priceRiskU: sizing.priceRiskU, expectedCostU: sizing.expectedCostU, positionCapped: sizing.positionCapped, initialStopLossPrice: stop.stop, stopDistance: stop.distance, stopDistanceAtr: stop.distanceAtr, stopSource: stop.source, atrAtEntry: atr, signal, entryMode: signal.entryMode, grade: signal.grade, riskMultiplier: signal.riskMultiplier, costR, potentialR, rewardSpace, estimatedTradeCost: cost, costModel, equity: Number(account.equity), trendId, experimentId: config.experimentId, strategyVersion: "trend_only_v3", executionEvaluation, configHash: crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex") };
}

function positionFromFill(plan, fill, now, configInput) {
  const config = normalizeConfig(configInput), position = V2.positionFromFill(plan, fill, now, config);
  position.config = config;
  position.strategyMode = "Trend Only V3";
  position.strategyVersion = "trend_only_v3";
  position.experimentId = plan.experimentId || config.experimentId;
  position.configHash = plan.configHash;
  position.trendScore = Number(plan.signal?.trendScore || 0);
  position.entryScore = Number(plan.signal?.entryQualityScore || 0);
  position.grade = plan.grade;
  position.potentialR = plan.potentialR;
  position.costR = plan.costR;
  position.costModel = plan.costModel;
  const qty = Number(position.positionSize || fill.qty), cost = plan.costModel || plan.estimatedTradeCost || buildTradeCostModel({}, plan.entryMode);
  const hasActualEntryFee = fill.fee !== null && fill.fee !== undefined && Number.isFinite(Number(fill.fee));
  const expectedCostPerUnit = hasActualEntryFee
    ? Number(fill.fee) / qty + Number(fill.price) * (Number(cost.exitFeeRate || 0) + Number(cost.expectedSlippageRate || 0) / 2)
    : Number(fill.price) * Number(cost.roundTripCostRate || 0);
  position.riskBudgetU = Number(plan.riskBudgetU ?? plan.plannedRiskAmount);
  position.initialPriceRiskU = qty * Math.abs(position.entryPrice - position.initialStopLossPrice);
  position.expectedCostPerUnit = expectedCostPerUnit;
  position.expectedCostU = qty * expectedCostPerUnit;
  position.initialEffectiveRiskU = position.initialPriceRiskU + position.expectedCostU;
  position.actualEffectiveRiskU = position.initialEffectiveRiskU;
  position.effectiveRiskU = position.initialEffectiveRiskU;
  position.actualRiskAmount = position.actualEffectiveRiskU;
  position.actualRiskRatio = Number(plan.equity) > 0 ? position.actualEffectiveRiskU / Number(plan.equity) : null;
  position.riskDeviationRatio = position.riskBudgetU > 0 ? position.actualEffectiveRiskU / position.riskBudgetU - 1 : Infinity;
  position.postFillRiskExceeded = !position.postFillRiskInvalid && position.riskBudgetU > 0 && position.actualEffectiveRiskU > position.riskBudgetU * (1 + config.maxPostFillRiskDeviation);
  position.netBreakEvenPrice = position.entryPrice + (position.side === "long" ? 1 : -1) * expectedCostPerUnit;
  position.executionEvaluation = plan.executionEvaluation;
  position.signal = { structureHigh: plan.signal?.structureHigh, structureLow: plan.signal?.structureLow, states: plan.signal?.states };
  position.whyEntered = `${plan.signal?.setupState || "READY"}：Trend ${position.trendScore.toFixed(1)} / Entry ${position.entryScore.toFixed(1)} / Grade ${position.grade}`;
  position.oneRMilestone = false;
  position.netBreakEvenActivated = false;
  position.lockedProfit = false;
  position.defensiveScore = 0;
  return position;
}

function manageTrendOnlyPosition(account, market, input = {}) {
  const position = account.trendOnlyState.position;
  if (!position) return { reason: "", logs: [] };
  return evaluateExit(position, market, input, normalizeConfig(position.config));
}

function recordClose(account, fill, reason, now = Date.now()) {
  const state = account.trendOnlyState, position = state.position, config = normalizeConfig(position?.config || account.trendOnlyConfig);
  if (!position || !(fill.qty > 0 && fill.qty <= position.positionSize * 1.000001 && fill.price > 0)) throw Error("平仓成交数量或价格无效");
  const qty = Math.min(Number(fill.qty), Number(position.positionSize)), sign = position.side === "long" ? 1 : -1;
  const grossPnl = (Number(fill.price) - Number(position.entryPrice)) * qty * sign;
  const cost = position.costModel || position.estimatedTradeCost || buildTradeCostModel(account, position.entryMode);
  const hasEntryFee = position.entryFeeActual !== null && position.entryFeeActual !== undefined && Number.isFinite(Number(position.entryFeeActual));
  const hasExitFee = fill.fee !== null && fill.fee !== undefined && Number.isFinite(Number(fill.fee));
  const entryFee = hasEntryFee ? Number(position.entryFeeActual) * qty / Number(position.filledQty || position.positionSize) : Number(position.entryPrice) * qty * Number(cost.entryFeeRate || 0);
  const exitFee = hasExitFee ? Number(fill.fee) : Number(fill.price) * qty * Number(cost.exitFeeRate || 0);
  const tradingFee = entryFee + exitFee;
  const fundingPnl = Number.isFinite(Number(fill.fundingPnl)) ? Number(fill.fundingPnl) : 0;
  const slippageCost = Number(fill.slippageCost || 0);
  const netPnl = grossPnl - tradingFee + fundingPnl - slippageCost;
  const denominator = Number(position.initialEffectiveRiskU || position.effectiveRiskU || 0) * qty / Number(position.filledQty || position.positionSize || qty);
  const date = new Date(now).toISOString().slice(0, 10);
  if (state.dailyDate !== date) { state.dailyDate = date; state.dailyLoss = 0; state.dayStartEquity = Number(account.equity || 0); }
  state.dailyLoss = Number(state.dailyLoss || 0) + Math.max(0, -netPnl);
  position.realizedPnl = Number(position.realizedPnl || 0) + netPnl;
  const voucher = { accountId: account.id, accountName: account.name, platform: account.platform, symbol: account.symbol, quoteAsset: account.quoteAsset,
    ...position, exitTime: now, exitPrice: Number(fill.price), positionSize: qty, positionValue: qty * position.entryPrice,
    pnl: netPnl, grossPnl, tradingFee, fundingPnl, slippageCost, netPnl,
    grossR: denominator > 0 ? grossPnl / denominator : null, netR: denominator > 0 ? netPnl / denominator : null,
    realizedNetR: denominator > 0 ? netPnl / denominator : null, rMultiple: denominator > 0 ? netPnl / denominator : null,
    costR: denominator > 0 ? (tradingFee + slippageCost - fundingPnl) / denominator : null,
    initialEffectiveRiskU: denominator, actualEffectiveRiskU: denominator, closeReason: reason, finalStopLossPrice: position.currentStopLossPrice,
    entryClientOrderId: position.clientOrderId, entryExchangeOrderId: position.exchangeOrderId, clientOrderId: fill.clientOrderId,
    exchangeOrderId: fill.exchangeOrderId, platformTradeId: fill.platformTradeId || fill.exchangeOrderId, txHash: fill.txHash || "", explorerUrl: fill.explorerUrl || "",
    stopTriggerPrice: fill.stopTriggerPrice ?? null, stopExecutionPrice: fill.stopExecutionPrice ?? null, stopSlippageBps: fill.stopSlippageBps ?? null,
    stopSlippageAmount: fill.stopSlippageAmount ?? null, stopExecutionMode: fill.stopExecutionMode || "", entryFee, exitFee,
    estimatedRoundTripCostRate: Number(cost.roundTripCostRate || 0), holdingDurationMs: Math.max(0, now - Number(position.entryTime || now)),
    costSource: hasEntryFee && hasExitFee ? "exchange" : "estimated-fee", roi: netPnl / (qty * position.entryPrice / position.leverage) * 100,
    id: `${fill.clientOrderId}:${fill.exchangeOrderId}:${fill.qty}`, time: new Date(now).toISOString(), tradeMode: account.paper ? "simulation" : "live",
    strategyVersion: "trend_only_v3", experimentId: position.experimentId || config.experimentId, configHash: position.configHash || "",
    trendScore: position.trendScore, entryScore: position.entryScore, grade: position.grade, potentialR: position.potentialR,
    whyEntered: position.whyEntered || "", whyExited: reason, postExitAnalyticsPostHocOnly: true };
  delete voucher.config;
  position.positionSize = Math.max(0, position.positionSize - qty);
  if (position.positionSize < 1e-10) {
    state.consecutiveLosses = position.realizedPnl < 0 ? Number(state.consecutiveLosses || 0) + 1 : 0;
    if (state.consecutiveLosses >= config.maxConsecutiveLosses) { state.pauseUntil = now + config.cooldownHoursAfterLossLimit * 3600000; state.consecutiveLosses = 0; }
    state.position = null;
  }
  state.journal.push(voucher);
  recordExitState(account.trendOnlyState, position, voucher);
  return voucher;
}

function updateTrendContext(state, signal, input) {
  const context = V2.updateTrendContext(state, signal, input);
  if (context) context.strategyVersion = "trend_only_v3";
  return context;
}

function appendShadowSignal(state, accountId, signal, input, finalAction = "") {
  const appended = V2.appendShadowSignal(state, accountId, signal, input, finalAction);
  if (appended) Object.assign(state.signalJournal.at(-1), { strategyVersion: "trend_only_v3", trendScore: signal.trendScore, entryScore: signal.entryQualityScore, grade: signal.grade, setupState: signal.setupState });
  return appended;
}

module.exports = {
  DEFAULTS, STRICTNESS_PRESETS: PRESETS, INTERVALS: V1.INTERVALS, normalizeConfig,
  isWeekendBlocked: V1.isWeekendBlocked, weekendProtection: V1.weekendProtection,
  indicatorsFor, directionOf, detectSwings, detectMarketRegime, initialState,
  tryOpenTrendOnlyPosition, positionFromFill, manageTrendOnlyPosition, recordClose,
  updateTrendContext, appendShadowSignal, journalRetentionBars: V2.journalRetentionBars,
  signalStats: V2.signalStats, buildDecisionFunnel, buildTradeCostModel,
  compareV2Shadow, registerMissedCandidate, updateMissedOpportunities, buildCandidateSetup, updatePostExitAnalytics,
  calculateRewardSpace, transition
};
