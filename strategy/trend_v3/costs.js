"use strict";

const { getEstimatedTradeCost } = require("../../trade_cost");

function buildTradeCostModel(account, entryMode, { notional = 0, plannedRiskAmount = 0, fundingEstimate = 0 } = {}) {
  const base = getEstimatedTradeCost(account, entryMode);
  const protectiveExitSlippage = account.paper ? Math.max(base.estimatedExitSlippage, Number(account.trendOnlyConfig?.paperStopSlippageBps ?? 5) / 10000) : base.estimatedExitSlippage;
  const expectedSlippageRate = base.estimatedEntrySlippage + protectiveExitSlippage;
  const roundTripCostPct = base.entryFeeRate + base.exitFeeRate + expectedSlippageRate;
  const roundTripCostU = Math.max(0, Number(notional)) * roundTripCostPct + Number(fundingEstimate || 0);
  return {
    ...base,
    expectedSlippageRate,
    roundTripCostRate: roundTripCostPct,
    estimatedEntrySlippage: base.expectedSlippageRate / 2,
    estimatedExitSlippage: protectiveExitSlippage,
    fundingEstimate: Number(fundingEstimate || 0),
    roundTripCostU,
    roundTripCostPct,
    roundTripCostR: Number(plannedRiskAmount) > 0 ? roundTripCostU / Number(plannedRiskAmount) : 0
  };
}

function calculateNetBreakEvenStop(position, config) {
  const price = Number(position.entryPrice), qty = Number(position.filledQty || position.positionSize), cost = position.costModel || position.estimatedTradeCost || {};
  if (!(price > 0 && qty > 0)) return null;
  const feeKnown = position.entryFeeActual !== null && position.entryFeeActual !== undefined && Number.isFinite(Number(position.entryFeeActual));
  const entryFeePerUnit = feeKnown ? Number(position.entryFeeActual) / qty : price * Number(cost.entryFeeRate || 0);
  const exitFee = Number(cost.exitFeeRate || 0);
  // Entry slippage is already inside entryPrice; only reserve exit execution.
  const slip = position.paper !== false ? Math.max(Number(config.paperStopSlippageBps ?? 5) / 10000, Number(cost.estimatedExitSlippage || 0)) : Number(cost.estimatedExitSlippage ?? Number(cost.expectedSlippageRate || 0) / 2);
  const funding = Math.max(0, Number(cost.fundingEstimate || 0)) / qty;
  if (![entryFeePerUnit, exitFee, slip, funding].every(Number.isFinite) || exitFee < 0 || exitFee >= 1 || slip < 0 || slip >= 1) return null;
  const long = position.side === "long";
  const trigger = long ? (price + entryFeePerUnit + funding) / ((1 - slip) * (1 - exitFee)) : (price - entryFeePerUnit - funding) / ((1 + slip) * (1 + exitFee));
  return trigger > 0 ? { trigger, executionPrice: trigger * (long ? 1 - slip : 1 + slip), slippageRate: slip, source: "fees_and_stop_execution" } : null;
}
module.exports = { buildTradeCostModel, calculateNetBreakEvenStop };
