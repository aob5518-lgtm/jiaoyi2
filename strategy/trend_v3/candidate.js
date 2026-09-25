"use strict";

const { calculateInitialStop } = require("./stops");
const { buildTradeCostModel } = require("./costs");
const { calculateRewardSpace } = require("./reward_space");

function buildCandidateSetup(account, signal, input, config) {
  const direction = signal.tradeDirection || signal.directionRaw;
  if (!direction || direction === "none") return null;
  const entryMode = signal.entryMode || signal.entryCandidates?.slice().sort((a, b) => b.score - a.score)[0]?.type || null;
  const entryPrice = Number(input.close || input.price), stop = entryMode ? calculateInitialStop({ side: direction, entryMode, entryPrice, atr: Number(input.atr), signal, input, config }) : null;
  const riskMultiplier = signal.riskMultiplier || 0;
  const plannedRiskU = Number(account.equity || 0) * Number(config.riskPerTrade) * riskMultiplier;
  const cost = buildTradeCostModel(account, entryMode || "candidate", { plannedRiskAmount: plannedRiskU });
  const stopDistance = stop?.allowed ? stop.distance : null;
  const rewardSpace = stopDistance ? calculateRewardSpace(input, direction, entryPrice, stopDistance) : { potentialR: null, forwardLevel: null, source: "unknown" };
  const potentialR = rewardSpace.potentialR;
  const costR = stopDistance ? entryPrice * cost.roundTripCostRate / (stopDistance + entryPrice * cost.roundTripCostRate) : null;
  return {
    direction,
    setupType: entryMode,
    trendScore: Number(signal.trendScore || signal.score || 0),
    entryScore: Number(signal.entryQualityScore || 0),
    grade: signal.grade,
    triggerZone: Number.isFinite(Number(input.emaFast)) && Number(input.atr) > 0 ? [Number(input.emaFast) - input.atr * 0.25, Number(input.emaFast) + input.atr * 0.25] : null,
    plannedStop: stop?.allowed ? stop.stop : null,
    stopDistance,
    stopDistanceAtr: stop?.allowed ? stop.distanceAtr : null,
    plannedRiskU,
    riskPercent: config.riskPerTrade * riskMultiplier,
    costR,
    potentialR,
    rewardSpace,
    state: signal.setupState,
    waitingReason: (signal.blockers || [])[0] || "全部条件已满足"
  };
}

module.exports = { buildCandidateSetup };
