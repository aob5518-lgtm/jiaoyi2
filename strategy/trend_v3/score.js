"use strict";

function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, value)); }

function marketEnvironment(chop, config) {
  if (!Number.isFinite(Number(chop))) return { score: 0, state: "BLOCK", label: "数据不足" };
  if (chop >= config.chopHardBlock) return { score: 0, state: "BLOCK", label: "强震荡禁止" };
  if (chop < 45) return { score: 10, state: "PASS", label: "优质趋势" };
  if (chop < 52) return { score: 8, state: "PASS", label: "趋势过渡" };
  if (chop < 55) return { score: 5, state: "CONDITIONAL", label: "条件交易" };
  return { score: 2, state: "CONDITIONAL", label: "仅允许高质量回踩" };
}

function scoreTrend(input, direction, config) {
  const trend = input.trendIndicators || input;
  const higher = input.higherIndicators || {};
  const sign = direction === "long" ? 1 : -1;
  const structure = (trend.structureDirection === direction ? 10 : trend.structureDirection === "none" ? 5 : 0)
    + (sign * (Number(trend.emaFast) - Number(trend.emaMid)) > 0 ? 6 : 0)
    + (sign * Number(trend.emaFastSlope || 0) > 0 ? 4 : 0)
    + (sign * (Number(trend.close) - Number(trend.emaFast)) > 0 ? 5 : 0);
  const adx = Number(trend.adx), spread = direction === "long" ? Number(trend.diPlus) - Number(trend.diMinus) : Number(trend.diMinus) - Number(trend.diPlus);
  const history = (trend.adxHistory || []).filter(Number.isFinite), adxSlope = history.length >= 2 ? history.at(-1) - history.at(-2) : 0;
  let strength = adx >= 40 ? 18 : adx >= 30 ? 20 : adx >= 22 ? 16 : adx >= 16 && adxSlope > 1 ? 10 : Math.max(0, adx / 3);
  if (spread > 8) strength += 2;
  strength = clamp(strength, 0, 20);
  const opposite = direction === "long" ? "short" : "long";
  const higherDirection = input.higherDirection || "none";
  const multiTimeframe = higherDirection === direction ? 15 : higherDirection === "none" ? 10 : Number(higher.adx) >= config.htfStrongAdx && higher.structureDirection === opposite ? 0 : Math.max(0, 10 - config.htfMildPenalty);
  const environment = marketEnvironment(Number(input.chop), config);
  return { structure, strength, multiTimeframe, environment: environment.score, baseScore: structure + strength + multiTimeframe + environment.score, environmentState: environment.state, environmentLabel: environment.label, adxSlope };
}

function gradeFor(score, config) {
  if (score >= config.gradeAThreshold) return { grade: "A", riskMultiplier: config.gradeARiskMultiplier };
  if (score >= config.gradeBThreshold) return { grade: "B", riskMultiplier: config.gradeBRiskMultiplier };
  return { grade: null, riskMultiplier: 0 };
}

module.exports = { clamp, marketEnvironment, scoreTrend, gradeFor };
