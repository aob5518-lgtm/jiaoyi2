"use strict";

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
  const grossR = sign * (price - position.entryPrice) / initialRisk;
  const costR = Number(position.costR || 0);
  position.grossR = grossR; position.netR = grossR - costR;
  if (grossR >= 1 && !position.oneRMilestone) { position.oneRMilestone = true; logs.push("达到 1R，仅记录里程碑，不移动止损"); }
  const tighten = value => { if (Number.isFinite(value)) position.currentStopLossPrice = sign > 0 ? Math.max(position.currentStopLossPrice, value) : Math.min(position.currentStopLossPrice, value); };
  if (grossR >= config.netBreakEvenAtR && !position.netBreakEvenActivated) { tighten(position.entryPrice + sign * initialRisk * costR); position.netBreakEvenActivated = true; logs.push("达到 1.5R，移动到覆盖成本后的净保本"); }
  if (grossR >= config.lockProfitAtR && !position.lockedProfit) { tighten(position.entryPrice + sign * initialRisk * config.lockProfitR); position.lockedProfit = true; logs.push(`锁定 ${config.lockProfitR}R`); }
  if (grossR >= config.trailStartAtR) position.trailingActive = true;
  const fresh = Number(input.signalTime) > Number(position.lastManagedSignalTime || position.signalTime || 0);
  if (fresh) {
    position.lastManagedSignalTime = input.signalTime;
    const opposite = position.side === "long" ? "short" : "long";
    const weak = [input.entryDirection === opposite, sign * (Number(input.close) - Number(input.emaFast)) < 0, position.side === "long" ? input.diMinus > input.diPlus : input.diPlus > input.diMinus, input.adxHistory?.length >= 2 && input.adxHistory.at(-1) < input.adxHistory.at(-2)].filter(Boolean).length;
    position.defensiveScore = weak;
    position.defensiveMode = weak >= 2;
    if (position.defensiveMode) logs.push(`检测到 ${weak} 个弱化信号，进入 DEFENSIVE`);
    const structure = sign > 0 ? Number(input.structureLow) : Number(input.structureHigh), atr = Number(input.atr), broken = Number.isFinite(structure) && atr > 0 && (sign > 0 ? input.close < structure - atr * 0.5 : input.close > structure + atr * 0.5);
    const trendReverse = input.trendDirection === opposite, higherReverse = input.higherDirection === opposite;
    if ((broken && trendReverse) || (trendReverse && higherReverse)) return { reason: "trend_reversal", logs };
    position.reversalConfirmCount = weak >= 3 ? Number(position.reversalConfirmCount || 0) + 1 : 0;
    if (position.reversalConfirmCount >= config.reversalConfirmBars) return { reason: "trend_reversal", logs };
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
