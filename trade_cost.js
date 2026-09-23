"use strict";

const PLATFORM_DEFAULTS = Object.freeze({
  hyperliquid: Object.freeze({ entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageBpsPerSide: 5 }),
  binance: Object.freeze({ entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageBpsPerSide: 5 }),
  extended: Object.freeze({ entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageBpsPerSide: 5 })
});

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function getEstimatedTradeCost(account = {}, entryMode = "", context = {}) {
  const defaults = PLATFORM_DEFAULTS[String(account.platform || "").toLowerCase()] || PLATFORM_DEFAULTS.hyperliquid;
  const config = account.tradeCostConfig && typeof account.tradeCostConfig === "object" ? account.tradeCostConfig : {};
  const entryFeeRate = finiteNonNegative(config.entryFeeRate ?? account.entryFeeRate, defaults.entryFeeRate);
  const exitFeeRate = finiteNonNegative(config.exitFeeRate ?? account.exitFeeRate, defaults.exitFeeRate);
  const configuredBps = account.paper
    ? config.paperSlippageBpsPerSide ?? account.simulationSlippageBps
    : config.liveSlippageBpsPerSide ?? account.liveSlippageBps;
  const slippageBpsPerSide = finiteNonNegative(configuredBps, defaults.slippageBpsPerSide);
  const modeMultiplier = finiteNonNegative(config.entryModeSlippageMultiplier?.[entryMode], 1);
  const expectedSlippageRate = slippageBpsPerSide * 2 / 10000 * modeMultiplier;
  const fundingEstimate = finiteNonNegative(context.fundingEstimate, 0);
  const roundTripCostRate = entryFeeRate + exitFeeRate + expectedSlippageRate;
  const roundTripCostU = finiteNonNegative(context.notional, 0) * roundTripCostRate + fundingEstimate;
  return {
    entryFeeRate,
    exitFeeRate,
    estimatedEntrySlippage: expectedSlippageRate / 2,
    estimatedExitSlippage: expectedSlippageRate / 2,
    expectedSlippageRate,
    fundingEstimate,
    roundTripCostRate,
    roundTripCostPct: roundTripCostRate,
    roundTripCostU,
    roundTripCostR: finiteNonNegative(context.plannedRiskAmount, 0) > 0 ? roundTripCostU / Number(context.plannedRiskAmount) : 0
  };
}

module.exports = { PLATFORM_DEFAULTS, getEstimatedTradeCost };
