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

function initialState(equity, now) {
  return { ...V2.initialState(equity, now), strategyVersion: "trend_only_v3", reentryState: {}, trendEntryCounts: {}, shadowComparisons: [], missedOpportunityJournal: [] };
}

function tryOpenTrendOnlyPosition(account, signal, input) {
  const config = normalizeConfig(account.trendOnlyConfig), state = account.trendOnlyState || {};
  if (signal.entryPermission !== "allowed" || !signal.tradeDirection) return { allowed: false, reason: (signal.blockers || []).join("；") || "当前没有可执行的 V3 setup" };
  if (!account.paper) return { allowed: false, reason: "Trend Only V3 当前仅开放 Paper；Live 须完成 Forward Test 后另行启用。" };
  if (state.riskLock) return { allowed: false, reason: `risk_lock：${state.riskLockReason || "安全锁定"}` };
  const trendId = state.trendContext?.trendId || `${signal.tradeDirection}:${signal.signalTime}`;
  if (Number(state.trendEntryCounts?.[trendId] || 0) >= config.maxEntriesPerTrend) return { allowed: false, reason: `同一趋势最多允许 ${config.maxEntriesPerTrend} 次入场` };
  if (Number(state.lastEntrySignalTime) === Number(signal.signalTime)) return { allowed: false, reason: "同一根 K 线禁止重复开仓" };
  const entryPrice = Number(input.price || input.close), atr = Number(input.atr);
  const stop = calculateInitialStop({ side: signal.tradeDirection, entryMode: signal.entryMode, entryPrice, atr, signal, input, config });
  if (!stop.allowed) return stop;
  const cost = buildTradeCostModel(account, signal.entryMode);
  const costR = entryPrice * cost.roundTripCostRate / (stop.distance + entryPrice * cost.roundTripCostRate);
  if (costR > config.maxAllowedCostR) return { allowed: false, reason: `预计交易成本 ${costR.toFixed(3)}R 超过上限 ${config.maxAllowedCostR}R`, costR };
  const structuralSpace = signal.tradeDirection === "long" ? Number(input.forwardResistance) - entryPrice : entryPrice - Number(input.forwardSupport);
  const potentialR = Number.isFinite(Number(input.potentialR)) ? Number(input.potentialR) : Number.isFinite(structuralSpace) && structuralSpace > 0 ? structuralSpace / stop.distance : 2.5;
  if (potentialR < config.minimumPotentialR) return { allowed: false, reason: `前方结构空间仅 ${potentialR.toFixed(2)}R，低于 ${config.minimumPotentialR}R`, potentialR };
  const sizing = calculatePositionSize({ equity: account.equity, available: account.available ?? account.equity, entryPrice, stopDistance: stop.distance, riskPerTrade: config.riskPerTrade, riskMultiplier: signal.riskMultiplier, costRate: cost.roundTripCostRate, leverage: config.leverage, maxPositionRatio: config.maxPositionRatio, qtyStep: Number(input.qtyStep || 0.000001), minNotional: Number(input.minNotional || 10) });
  if (!sizing.allowed) return sizing;
  const costModel = buildTradeCostModel(account, signal.entryMode, { notional: sizing.positionValue, plannedRiskAmount: sizing.plannedRiskAmount });
  return { allowed: true, side: signal.tradeDirection, qty: sizing.qty, entryPrice, positionValue: sizing.positionValue, riskAmount: sizing.plannedRiskAmount, plannedRiskAmount: sizing.plannedRiskAmount, effectiveRiskU: sizing.effectiveRiskU, priceRiskU: sizing.priceRiskU, expectedCostU: sizing.expectedCostU, initialStopLossPrice: stop.stop, stopDistance: stop.distance, stopDistanceAtr: stop.distanceAtr, stopSource: stop.source, atrAtEntry: atr, signal, entryMode: signal.entryMode, grade: signal.grade, riskMultiplier: signal.riskMultiplier, costR, potentialR, estimatedTradeCost: cost, costModel, equity: Number(account.equity), trendId, experimentId: config.experimentId, strategyVersion: "trend_only_v3", configHash: crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex") };
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
  position.effectiveRiskU = plan.effectiveRiskU;
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
  const position = account.trendOnlyState.position;
  const voucher = V1.recordClose(account, fill, reason, now);
  const plannedRisk = Number(position?.plannedRiskAmount || voucher.plannedRiskAmount || 0);
  const slippageCost = Number(fill.slippageCost || 0);
  voucher.slippageCost = slippageCost;
  voucher.netPnl = Number(voucher.grossPnl) - Number(voucher.tradingFee) + Number(voucher.fundingPnl) - slippageCost;
  voucher.pnl = voucher.netPnl;
  voucher.grossR = plannedRisk > 0 ? Number(voucher.grossPnl) / plannedRisk : null;
  voucher.netR = plannedRisk > 0 ? Number(voucher.netPnl) / plannedRisk : null;
  voucher.rMultiple = voucher.netR;
  voucher.costR = plannedRisk > 0 ? (Number(voucher.tradingFee) + slippageCost - Number(voucher.fundingPnl)) / plannedRisk : null;
  voucher.strategyVersion = "trend_only_v3";
  voucher.experimentId = position?.experimentId || normalizeConfig(account.trendOnlyConfig).experimentId;
  voucher.configHash = position?.configHash || "";
  voucher.trendScore = position?.trendScore;
  voucher.entryScore = position?.entryScore;
  voucher.grade = position?.grade;
  voucher.potentialR = position?.potentialR;
  voucher.whyEntered = position?.whyEntered || "";
  voucher.whyExited = reason;
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
  signalStats: V2.signalStats, buildDecisionFunnel, buildTradeCostModel
};
