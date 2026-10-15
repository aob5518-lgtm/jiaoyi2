"use strict";

const V2 = require("../../trend_only_v2");
const { REVISION, EXPERIMENT } = require("./scope");

const DEFAULTS = Object.freeze({
  ...V2.DEFAULTS,
  version: "v3",
  experimentId: EXPERIMENT,
  strategyRevision: REVISION,
  maxPortfolioRiskPct: 0.025,
  portfolioRiskKey: "",
  maxCrossVenueBasisBps: 25,
  maxCrossVenueBasisAtr: 0.25,
  gradeAThreshold: 82,
  gradeBThreshold: 74,
  gradeARiskMultiplier: 1,
  gradeBRiskMultiplier: 0.5,
  chopHardBlock: 61.8,
  htfStrongAdx: 30,
  htfMildPenalty: 5,
  highQualityPullbackScore: 15,
  breakoutCompressionBars: 6,
  continuationCompressionBars: 5,
  swingStructureLookback: 48,
  continuationSetupValidBars: 3,
  pullbackStopBuffer: 0.5,
  minimumEffectiveStopAtr: 1,
  minimumEffectiveStopBps: 20,
  netBreakEvenAtR: 1.5,
  lockProfitAtR: 2.5,
  lockProfitR: 0.8,
  trailStartAtR: 3,
  minTrailingDistanceAtr: 0.8,
  maxPreferredCostR: 0.15,
  maxAllowedCostR: 0.35,
  minimumPotentialR: 1.8,
  maxEntriesPerTrend: 2,
  reentryMinBars: 3,
  reentryMaxBars: 6,
  shadowComparison: true,
  allowLive: false
});

const PRESETS = Object.freeze({
  conservative: Object.freeze({ gradeAThreshold: 86, gradeBThreshold: 78, gradeBRiskMultiplier: 0.4, htfMildPenalty: 8, highQualityPullbackScore: 17, minimumPotentialR: 2, maxPreferredCostR: 0.12, maxAllowedCostR: 0.25 }),
  standard: Object.freeze({ gradeAThreshold: 82, gradeBThreshold: 74, gradeBRiskMultiplier: 0.5, htfMildPenalty: 5, highQualityPullbackScore: 15, minimumPotentialR: 1.8, maxPreferredCostR: 0.15, maxAllowedCostR: 0.35 }),
  sensitive: Object.freeze({ gradeAThreshold: 78, gradeBThreshold: 70, gradeBRiskMultiplier: 0.4, htfMildPenalty: 3, highQualityPullbackScore: 13, minimumPotentialR: 1.5, maxPreferredCostR: 0.15, maxAllowedCostR: 0.35, riskPerTrade: 0.005 })
});

function normalizeConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("趋势 V3 配置必须是对象");
  const v2Input = {};
  for (const key of Object.keys(V2.DEFAULTS)) if (input[key] !== undefined) v2Input[key] = input[key];
  const base = V2.normalizeConfig(v2Input);
  const config = { ...DEFAULTS, ...base };
  const legacyCostLimit = input.maxPreferredCostR === undefined && Number(input.maxAllowedCostR) === 0.15;
  const legacyExperiment = input.experimentId === undefined || ["V3_STD_20260922_A", "V3_STD_20260930_B"].includes(input.experimentId);
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (input[key] === undefined) continue;
    if (typeof fallback === "number") {
      const value = Number(input[key]);
      if (!Number.isFinite(value) || value < 0) throw Error(`趋势 V3 参数 ${key} 无效`);
      config[key] = value;
    } else if (typeof fallback === "boolean") config[key] = !!input[key];
    else if (Array.isArray(fallback)) config[key] = [...input[key]];
    else config[key] = String(input[key]);
  }
  config.version = "v3";
  config.strategyRevision = REVISION;
  // Migrate the original single 0.15R limit into a preferred + hard limit.
  // 0.15R remains the quality boundary; only 0.35R is a hard rejection.
  if (legacyCostLimit) { config.maxPreferredCostR = 0.15; config.maxAllowedCostR = 0.35; }
  else if (input.maxAllowedCostR !== undefined && input.maxPreferredCostR === undefined) config.maxPreferredCostR = Math.min(config.maxPreferredCostR, config.maxAllowedCostR);
  if (legacyExperiment) config.experimentId = DEFAULTS.experimentId;
  config.allowLive = false;
  if (!(config.maxPortfolioRiskPct > 0 && config.maxPortfolioRiskPct <= 1)) throw Error("V3 maxPortfolioRiskPct 必须为 0~1 比例");
  if (!Array.isArray(config.entryModes) || !config.entryModes.length || config.entryModes.some(mode => !["breakout_entry", "pullback_entry", "continuation_entry"].includes(mode))) throw Error("V3 entryModes 无效");
  config.entryModes = [...new Set(config.entryModes)];
  if (!["strict_align", "not_against", "off"].includes(config.higherTimeframeMode)) throw Error("V3 higherTimeframeMode 无效");
  if (!(config.gradeAThreshold > config.gradeBThreshold && config.gradeAThreshold <= 100)) throw Error("V3 等级阈值无效");
  if (!(config.gradeARiskMultiplier > 0 && config.gradeARiskMultiplier <= 1 && config.gradeBRiskMultiplier > 0 && config.gradeBRiskMultiplier <= config.gradeARiskMultiplier)) throw Error("V3 风险倍率无效");
  if (!(config.maxPreferredCostR > 0 && config.maxAllowedCostR >= config.maxPreferredCostR && config.minimumPotentialR > 0)) throw Error("V3 成本或空间过滤参数无效");
  if (!(config.reentryMinBars >= 1 && config.reentryMaxBars >= config.reentryMinBars)) throw Error("V3 再入场参数无效");
  if (!Number.isInteger(config.maxEntriesPerTrend) || config.maxEntriesPerTrend < 1) throw Error("V3 每趋势最大入场次数无效");
  if (!Number.isInteger(config.swingStructureLookback) || config.swingStructureLookback < 24 || config.swingStructureLookback > 200) throw Error("V3 swingStructureLookback 必须为 24~200 根");
  if (!Number.isInteger(config.continuationSetupValidBars) || config.continuationSetupValidBars < 1 || config.continuationSetupValidBars > 5) throw Error("V3 continuationSetupValidBars 必须为 1~5 根");
  return config;
}

module.exports = { DEFAULTS, PRESETS, normalizeConfig };
