"use strict";

function finiteLevels(values) { return values.map(Number).filter(value => Number.isFinite(value) && value > 0); }
function swingPrices(indicator, side) { return finiteLevels((indicator?.swings?.[side] || []).map(item => item?.price)); }

function calculateRewardSpace(input, direction, entryPrice, stopDistance) {
  const trend = input.trendIndicators || {}, higher = input.higherIndicators || {};
  if (!(entryPrice > 0 && stopDistance > 0)) return { potentialR: null, forwardLevel: null, source: "invalid_risk_unit" };
  if (direction === "long") {
    const levels = finiteLevels([input.forwardResistance, trend.latestSwingHigh, higher.latestSwingHigh, trend.structureHigh, higher.structureHigh, ...swingPrices(trend, "highs"), ...swingPrices(higher, "highs")]).filter(value => value > entryPrice);
    const forwardLevel = levels.length ? Math.min(...levels) : null;
    return { potentialR: forwardLevel ? (forwardLevel - entryPrice) / stopDistance : null, forwardLevel, source: forwardLevel ? "confirmed_swing_resistance" : "unknown" };
  }
  const levels = finiteLevels([input.forwardSupport, trend.latestSwingLow, higher.latestSwingLow, trend.structureLow, higher.structureLow, ...swingPrices(trend, "lows"), ...swingPrices(higher, "lows")]).filter(value => value < entryPrice);
  const forwardLevel = levels.length ? Math.max(...levels) : null;
  return { potentialR: forwardLevel ? (entryPrice - forwardLevel) / stopDistance : null, forwardLevel, source: forwardLevel ? "confirmed_swing_support" : "unknown" };
}

module.exports = { calculateRewardSpace };
