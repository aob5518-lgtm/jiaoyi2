"use strict";

function registerMissedCandidate(state, signal, input) {
  if (!signal.signalTime || signal.entryPermission === "allowed" || signal.directionRaw === "none") return false;
  state.missedOpportunityJournal ||= [];
  if (state.missedOpportunityJournal.some(item => item.signalTime === signal.signalTime)) return false;
  state.missedOpportunityJournal.push({
    postHocOnly: true,
    signalTime: signal.signalTime,
    direction: signal.directionRaw,
    entryPrice: Number(input.close),
    riskUnit: Math.max(Number(input.atr || 0), Math.abs(Number(input.close) - Number(signal.directionRaw === "long" ? signal.structureLow : signal.structureHigh)) || 0),
    setupState: signal.setupState,
    blockers: [...(signal.blockers || [])],
    outcomes: {}
  });
  if (state.missedOpportunityJournal.length > 500) state.missedOpportunityJournal.splice(0, state.missedOpportunityJournal.length - 500);
  return true;
}

function updateMissedOpportunities(state, closedCandles) {
  const candles = Array.isArray(closedCandles) ? closedCandles : [];
  for (const candidate of state.missedOpportunityJournal || []) {
    const future = candles.filter(item => Number(item.time) > Number(candidate.signalTime));
    for (const horizon of [8, 16, 32]) {
      if (candidate.outcomes[horizon] || future.length < horizon) continue;
      const rows = future.slice(0, horizon), sign = candidate.direction === "long" ? 1 : -1;
      const favorable = Math.max(0, ...rows.map(item => sign > 0 ? Number(item.high) - candidate.entryPrice : candidate.entryPrice - Number(item.low)));
      const adverse = Math.max(0, ...rows.map(item => sign > 0 ? candidate.entryPrice - Number(item.low) : Number(item.high) - candidate.entryPrice));
      const risk = Number(candidate.riskUnit) > 0 ? Number(candidate.riskUnit) : 1;
      const forwardMFE_R = favorable / risk, forwardMAE_R = adverse / risk;
      const classification = forwardMFE_R >= 2 && forwardMAE_R <= 0.75 ? "MISSED_TREND" : forwardMAE_R >= 1 && forwardMFE_R < 1 ? "GOOD_BLOCK" : forwardMFE_R >= 1 ? "CORRECT_WAIT" : "FALSE_ENTRY_RISK";
      candidate.outcomes[horizon] = { bars: horizon, forwardMFE: favorable, forwardMAE: adverse, forwardMFE_R, forwardMAE_R, classification };
    }
  }
  return state.missedOpportunityJournal || [];
}

module.exports = { registerMissedCandidate, updateMissedOpportunities };
