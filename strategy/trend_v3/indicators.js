"use strict";

const V2 = require("../../trend_only_v2");

function indicatorsFor(candles, config, interval, now) {
  const result = V2.indicatorsFor(candles, config, interval, now);
  const highs = result.swings?.highs || [], lows = result.swings?.lows || [];
  const lastHighs = highs.slice(-2), lastLows = lows.slice(-2);
  const structureDirection = lastHighs.length === 2 && lastLows.length === 2
    ? lastHighs[1].price > lastHighs[0].price && lastLows[1].price > lastLows[0].price ? "long"
      : lastHighs[1].price < lastHighs[0].price && lastLows[1].price < lastLows[0].price ? "short" : "none"
    : "none";
  const recent = result.candles.slice(-Math.max(8, config.breakoutCompressionBars, config.continuationCompressionBars));
  const ranges = recent.map(item => Number(item.high) - Number(item.low)).filter(Number.isFinite);
  const recentRange = ranges.slice(-3).reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.slice(-3).length);
  const priorRange = ranges.slice(0, -3).reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.slice(0, -3).length);
  const compressed = bars => {
    const rows = result.candles.slice(-Math.max(4, Number(bars) || 4));
    const rowRanges = rows.map(item => Number(item.high) - Number(item.low)).filter(Number.isFinite);
    const split = Math.max(2, Math.floor(rowRanges.length / 2));
    const earlier = rowRanges.slice(0, split), later = rowRanges.slice(split);
    const avg = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    return earlier.length >= 2 && later.length >= 2 && avg(later) < avg(earlier) * 0.75;
  };
  return {
    ...result,
    structureDirection,
    emaFastSlope: Number(result.emaFast) - Number(result.emaFastHistory?.at?.(-2) ?? result.emaFast),
    compression: Number.isFinite(recentRange) && Number.isFinite(priorRange) && recentRange < priorRange * 0.75,
    breakoutCompression: compressed(config.breakoutCompressionBars),
    continuationCompression: compressed(config.continuationCompressionBars),
    expansion: ranges.length >= 2 && ranges.at(-1) > ranges.slice(0, -1).reduce((sum, value) => sum + value, 0) / (ranges.length - 1) * 1.2,
    latestSwingHigh: highs.at(-1)?.price ?? result.structureHigh,
    latestSwingLow: lows.at(-1)?.price ?? result.structureLow
  };
}

module.exports = { indicatorsFor, directionOf: V2.directionOf, detectSwings: V2.detectSwings };
