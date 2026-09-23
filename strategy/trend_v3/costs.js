"use strict";

const { getEstimatedTradeCost } = require("../../trade_cost");

function buildTradeCostModel(account, entryMode, { notional = 0, plannedRiskAmount = 0, fundingEstimate = 0 } = {}) {
  const base = getEstimatedTradeCost(account, entryMode);
  const roundTripCostPct = base.roundTripCostRate;
  const roundTripCostU = Math.max(0, Number(notional)) * roundTripCostPct + Number(fundingEstimate || 0);
  return {
    ...base,
    estimatedEntrySlippage: base.expectedSlippageRate / 2,
    estimatedExitSlippage: base.expectedSlippageRate / 2,
    fundingEstimate: Number(fundingEstimate || 0),
    roundTripCostU,
    roundTripCostPct,
    roundTripCostR: Number(plannedRiskAmount) > 0 ? roundTripCostU / Number(plannedRiskAmount) : 0
  };
}

module.exports = { buildTradeCostModel };
