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
    // Compression describes the setup *before* the current confirmation candle.
    // Including the current expansion candle made compression and release mutually
    // exclusive in many real markets, so continuation setups could never complete.
    const rows = result.candles.slice(0, -1).slice(-Math.max(4, Number(bars) || 4));
    const rowRanges = rows.map(item => Number(item.high) - Number(item.low)).filter(Number.isFinite);
    const split = Math.max(2, Math.floor(rowRanges.length / 2));
    const earlier = rowRanges.slice(0, split), later = rowRanges.slice(split);
    const avg = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    return earlier.length >= 2 && later.length >= 2 && avg(later) < avg(earlier) * 0.75;
  };
  return {
    ...result,
    open: Number(result.candles.at(-1)?.open),
    high: Number(result.candles.at(-1)?.high),
    low: Number(result.candles.at(-1)?.low),
    structureDirection,
    // V1/V2 already calculate the real EMA slope. emaFastHistory is not exposed,
    // therefore the previous fallback silently produced zero on every V3 tick.
    emaFastSlope: Number(result.emaSlope || 0),
    compression: Number.isFinite(recentRange) && Number.isFinite(priorRange) && recentRange < priorRange * 0.75,
    breakoutCompression: compressed(config.breakoutCompressionBars),
    continuationCompression: compressed(config.continuationCompressionBars),
    expansion: ranges.length >= 2 && ranges.at(-1) > ranges.slice(0, -1).reduce((sum, value) => sum + value, 0) / (ranges.length - 1) * 1.2,
    latestSwingHigh: highs.at(-1)?.price ?? result.structureHigh,
    latestSwingLow: lows.at(-1)?.price ?? result.structureLow
  };
}

function directionOf(input, role = "entry") {
  if (!input) return "none";
  // Entry alignment remains deliberately strict. The slower trend timeframes use
  // a small ATR hysteresis so a normal pullback does not erase the 1H trend just
  // when a pullback entry is becoming interesting.
  if (role === "entry") return V2.directionOf(input);
  const close = Number(input.close), fast = Number(input.emaFast), mid = Number(input.emaMid);
  const slope = Number(input.emaFastSlope ?? input.emaSlope), atr = Number(input.atr);
  const diPlus = Number(input.diPlus), diMinus = Number(input.diMinus);
  if (![close, fast, mid, slope, atr, diPlus, diMinus].every(Number.isFinite) || atr <= 0) return "none";
  const crossoverBuffer = atr * 0.15, pullbackBuffer = atr * 0.25;
  const structure = input.structureDirection || "none";
  if (diPlus > diMinus && fast >= mid - crossoverBuffer && close >= mid - pullbackBuffer && (slope > 0 || structure === "long")) return "long";
  if (diMinus > diPlus && fast <= mid + crossoverBuffer && close <= mid + pullbackBuffer && (slope < 0 || structure === "short")) return "short";
  return V2.directionOf(input);
}

module.exports = { indicatorsFor, directionOf, detectSwings: V2.detectSwings };
