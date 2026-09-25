"use strict";

const V1 = require("../../trend_only");

function evaluateExit(position, market, input = {}, config) {
  const price = Number(market.price), sign = position.side === "long" ? 1 : -1, initialRisk = Math.abs(position.entryPrice - position.initialStopLossPrice), logs = [];
  position.oneRMilestone = !!position.oneRMilestone;
  position.netBreakEvenActivated = !!position.netBreakEvenActivated;
  position.lockedProfit = !!position.lockedProfit;
  position.trailingActive = !!position.trailingActive;
  if (!(price > 0 && initialRisk > 0)) return { reason: "", logs: ["价格或初始风险无效，保留硬止损"] };
  position.highestPriceSinceEntry = Math.max(Number(position.highestPriceSinceEntry || position.entryPrice), price);
  position.lowestPriceSinceEntry = Math.min(Number(position.lowestPriceSinceEntry || position.entryPrice), price);
  position.maximumAdverseExcursion = Math.max(Number(position.maximumAdverseExcursion || 0), sign > 0 ? position.entryPrice - position.lowestPriceSinceEntry : position.highestPriceSinceEntry - position.entryPrice, 0);
  position.maximumFavorableExcursion = Math.max(Number(position.maximumFavorableExcursion || 0), sign > 0 ? position.highestPriceSinceEntry - position.entryPrice : position.entryPrice - position.lowestPriceSinceEntry, 0);
  position.MAE_R = position.maximumAdverseExcursion / initialRisk; position.MFE_R = position.maximumFavorableExcursion / initialRisk;
  if (sign * (price - position.currentStopLossPrice) <= 0) return { reason: position.trailingActive || position.netBreakEvenActivated ? "trend_tp" : "hard_sl", logs };
  const qty = Number(position.positionSize || position.filledQty || 0);
  const legacyCostR = Number(position.costR || 0);
  const expectedCostPerUnit = Number.isFinite(Number(position.expectedCostPerUnit)) ? Number(position.expectedCostPerUnit) : legacyCostR > 0 && legacyCostR < 1 ? initialRisk * legacyCostR / (1 - legacyCostR) : 0;
  const estimatedGrossPnl = sign * (price - position.entryPrice) * qty;
  const estimatedTradingCost = expectedCostPerUnit * qty;
  const estimatedNetPnl = estimatedGrossPnl - estimatedTradingCost;
  const riskUnit = Number(position.initialEffectiveRiskU || position.effectiveRiskU || 0);
  const grossR = sign * (price - position.entryPrice) / initialRisk;
  position.estimatedGrossPnl = estimatedGrossPnl;
  position.estimatedTradingCost = estimatedTradingCost;
  position.estimatedNetPnl = estimatedNetPnl;
  position.floatingNetR = riskUnit > 0 ? estimatedNetPnl / riskUnit : null;
  position.grossR = grossR; position.netR = position.floatingNetR;
  if (grossR >= 1 && !position.oneRMilestone) { position.oneRMilestone = true; logs.push("达到 1R，仅记录里程碑，不移动止损"); }
  const tighten = value => { if (Number.isFinite(value)) position.currentStopLossPrice = sign > 0 ? Math.max(position.currentStopLossPrice, value) : Math.min(position.currentStopLossPrice, value); };
  if (grossR >= config.netBreakEvenAtR && !position.netBreakEvenActivated) { tighten(position.netBreakEvenPrice || position.entryPrice + sign * expectedCostPerUnit); position.netBreakEvenActivated = true; logs.push("达到 1.5R，移动到覆盖预计成本后的净保本"); }
  if (grossR >= config.lockProfitAtR && !position.lockedProfit) { tighten(position.entryPrice + sign * initialRisk * config.lockProfitR); position.lockedProfit = true; logs.push(`锁定 ${config.lockProfitR}R`); }
  if (grossR >= config.trailStartAtR) position.trailingActive = true;
  const fresh = Number(input.signalTime) > Number(position.lastManagedSignalTime || position.signalTime || 0);
  if (fresh) {
    position.lastManagedSignalTime = input.signalTime;
    const opposite = position.side === "long" ? "short" : "long";
    const weak = [input.entryDirection === opposite, sign * (Number(input.close) - Number(input.emaFast)) < 0, position.side === "long" ? input.diMinus > input.diPlus : input.diPlus > input.diMinus, input.adxHistory?.length >= 2 && input.adxHistory.at(-1) < input.adxHistory.at(-2)].filter(Boolean).length;
    position.defensiveScore = weak;
    const structure = sign > 0 ? Number(input.structureLow) : Number(input.structureHigh), atr = Number(input.atr);
    const lightStructureBreak = Number.isFinite(structure) && (sign > 0 ? input.close < structure : input.close > structure);
    const bufferedStructureBreak = lightStructureBreak && atr > 0 && (sign > 0 ? input.close < structure - atr * config.structureBreakBufferAtr : input.close > structure + atr * config.structureBreakBufferAtr);
    const emergencyStructureBreak = lightStructureBreak && atr > 0 && (sign > 0 ? input.close < structure - atr * 0.5 : input.close > structure + atr * 0.5);
    position.structureReversalCount = bufferedStructureBreak ? Number(position.structureReversalCount || 0) + 1 : 0;
    position.defensiveMode = weak >= 2 || lightStructureBreak;
    if (position.defensiveMode) logs.push(`检测到 ${weak} 个弱化信号，进入 DEFENSIVE`);
    const trendReverse = input.trendDirection === opposite, higherReverse = input.higherDirection === opposite;
    if (emergencyStructureBreak || (trendReverse && higherReverse)) return { reason: "trend_reversal", logs };
    const interval = Number(V1.INTERVALS?.[config.entryTimeframe] || 15 * 60 * 1000);
    const barsSinceEntry = Math.max(0, Math.floor((Number(input.signalTime) - Number(position.signalTime || input.signalTime)) / interval));
    if (barsSinceEntry >= config.softExitMinBars && position.structureReversalCount >= config.structureReversalConfirmBars) return { reason: "trend_reversal", logs };
    position.reversalConfirmCount = weak >= 3 ? Number(position.reversalConfirmCount || 0) + 1 : 0;
    const costCovered = Math.abs(price - position.entryPrice) >= expectedCostPerUnit;
    if (barsSinceEntry >= config.softExitMinBars && costCovered && position.reversalConfirmCount >= config.reversalConfirmBars) return { reason: "trend_reversal", logs };
    if (!costCovered && weak) logs.push("价格波动尚不足覆盖预计往返成本，弱反转仅进入防守模式");
  }
  if (position.defensiveMode && Number(input.atr) > 0) {
    const atr = Number(input.atr), minimumDistance = atr * config.minDefensiveStopDistanceAtr;
    const away = value => sign > 0 ? Math.min(value, price - minimumDistance) : Math.max(value, price + minimumDistance);
    tighten(away(price - sign * atr * config.defensiveTrailingAtrMultiplier));
    const structure = sign > 0 ? Number(input.structureLow) : Number(input.structureHigh);
    if (Number.isFinite(structure)) tighten(away(structure - sign * atr * config.defensiveStructureBufferAtr));
    else logs.push("结构位不足，仅使用 ATR 防守止损");
  }
  if (position.trailingActive && Number(input.atr) > 0 && Number(input.signalTime) > Number(position.lastTrailingSignalTime || 0)) {
    position.lastTrailingSignalTime = input.signalTime;
    const swing = sign > 0 ? Number(input.structureLow) - input.atr * 0.5 : Number(input.structureHigh) + input.atr * 0.5;
    const peakStop = (sign > 0 ? position.highestPriceSinceEntry : position.lowestPriceSinceEntry) - sign * input.atr * config.trailingAtrMultiplier;
    const candidate = sign > 0 ? Math.max(swing || -Infinity, peakStop) : Math.min(swing || Infinity, peakStop);
    const away = sign > 0 ? Math.min(candidate, price - input.atr * config.minTrailingDistanceAtr) : Math.max(candidate, price + input.atr * config.minTrailingDistanceAtr);
    tighten(away);
  }
  return { reason: "", logs };
}

module.exports = { evaluateExit };
