"use strict";

function calculatePositionSize({ equity, available, entryPrice, stopDistance, riskPerTrade, riskMultiplier, costRate, leverage, maxPositionRatio, qtyStep = 0.000001, minNotional = 10 }) {
  const riskBudget = Number(equity) * Number(riskPerTrade) * Number(riskMultiplier);
  const effectiveRiskPerUnit = Number(stopDistance) + Number(entryPrice) * Number(costRate);
  if (!(riskBudget > 0 && effectiveRiskPerUnit > 0 && entryPrice > 0)) return { allowed: false, reason: "风险仓位输入无效" };
  const riskQty = riskBudget / effectiveRiskPerUnit;
  const maxNotional = Math.min(Number(equity) * Number(leverage) * Number(maxPositionRatio), Number(available) * Number(leverage) * 0.98);
  const rawQty = Math.min(riskQty, maxNotional / entryPrice);
  const qty = Math.floor(rawQty / qtyStep + 1e-9) * qtyStep;
  if (!(qty > 0) || qty * entryPrice < minNotional) return { allowed: false, reason: "风险仓位小于交易所最小下单金额" };
  const priceRiskU = qty * stopDistance, expectedCostU = qty * entryPrice * costRate, effectiveRiskU = priceRiskU + expectedCostU;
  return { allowed: true, qty, positionValue: qty * entryPrice, plannedRiskAmount: riskBudget, priceRiskU, expectedCostU, effectiveRiskU, actualPlannedRiskRatio: effectiveRiskU / equity };
}

module.exports = { calculatePositionSize };
