"use strict";

const { chooseEntry } = require("./entries");
const { scoreTrend, gradeFor, clamp, costEfficiencyFromR } = require("./score");
const { calculateInitialStop } = require("./stops");

function hardBlockers(input, direction, config) {
  const blockers = [];
  for (const [name, value] of [["价格", input.close], ["ATR", input.atr], ["CHOP", input.chop]]) if (!Number.isFinite(Number(value)) || (name !== "CHOP" && Number(value) <= 0)) blockers.push(`${name}数据无效`);
  if (input.dataStale || input.crossExchangeFallback) blockers.push("行情 stale 或跨交易所 fallback 未验证");
  if (Number(input.chop) >= config.chopHardBlock) blockers.push("CHOP 强震荡禁止交易");
  const opposite = direction === "long" ? "short" : "long", higher = input.higherIndicators || {};
  if (["long", "short"].includes(direction) && config.higherTimeframeMode !== "off" && input.higherDirection === opposite && Number(higher.adx) >= config.htfStrongAdx && higher.structureDirection === opposite) blockers.push("HARD_HTF_CONFLICT：4H 强趋势与结构明确反向");
  return blockers;
}

function detectMarketRegime(candles, input) {
  const config = input.config;
  const directionRaw = ["long", "short"].includes(input.trendDirection) ? input.trendDirection : "none";
  const blockers = hardBlockers(input, directionRaw, config);
  const base = { signalTime: input.signalTime, directionRaw, direction: directionRaw, tradeDirection: "none", entryPermission: "blocked", entryMode: null, blockers, reasons: blockers, score: 0, trendScore: 0, entryQualityScore: 0, grade: null, setupState: "SCANNING", states: { breakout: false, pullback: false, continuation: false }, structureHigh: input.structureHigh, structureLow: input.structureLow, distanceFromEmaAtr: Number(input.atr) > 0 ? Math.abs(Number(input.close) - Number(input.emaFast)) / Number(input.atr) : null };
  if (blockers.length) return { ...base, regime: "blocked", setupState: "BLOCKED", hardBlockers: blockers };
  if (directionRaw === "none") return { ...base, regime: "unclear", blockers: ["1H 主趋势结构尚未成立"], reasons: ["1H 主趋势结构尚未成立"] };
  const score = scoreTrend(input, directionRaw, config);
  const entry = chooseEntry(directionRaw, input, config);
  const selected = entry.selected;
  const entryDirection = input.entryDirection || "none";
  const emptyBreakdown = { structure: score.structure, strength: score.strength, multiTimeframe: score.multiTimeframe, environment: score.environment, entryQuality: 0, costEfficiency: 0, total: score.baseScore };
  const opposite = directionRaw === "long" ? "short" : "long";
  const higherOpposite = input.higherDirection === opposite;
  if (config.higherTimeframeMode === "strict_align" && input.higherDirection !== directionRaw) return { ...base, regime: "trend", trendScore: score.baseScore, score: score.baseScore, setupState: "BLOCKED", blockers: ["strict_align：4H 必须与 1H 主趋势同向"], reasons: ["strict_align：4H 必须与 1H 主趋势同向"], scoreBreakdown: emptyBreakdown };
  if (config.higherTimeframeMode === "not_against" && higherOpposite && Number(input.higherIndicators?.adx) >= config.htfStrongAdx && input.higherIndicators?.structureDirection === opposite) return { ...base, regime: "blocked", setupState: "BLOCKED", blockers: ["HARD_HTF_CONFLICT：4H 强趋势与结构明确反向"], reasons: ["HARD_HTF_CONFLICT：4H 强趋势与结构明确反向"], hardBlockers: ["HARD_HTF_CONFLICT：4H 强趋势与结构明确反向"], scoreBreakdown: emptyBreakdown };
  if (entryDirection !== "none" && entryDirection !== directionRaw) return { ...base, regime: "trend", trendScore: score.baseScore, score: score.baseScore, setupState: "WAIT_ENTRY_ALIGNMENT", entryPermission: "wait_entry_alignment", blockers: ["1H 主趋势有效，15m 当前明确反向，等待入场周期重新确认"], reasons: ["1H 主趋势有效，15m 当前明确反向，等待入场周期重新确认"], scoreBreakdown: emptyBreakdown };
  if (entry.waitRetest) return { ...base, regime: "trend", trendScore: score.baseScore, score: score.baseScore, setupState: "WAIT_RETEST", entryPermission: "wait_pullback", blockers: ["突破位置远离 EMA20，等待回踩确认，不追单"], reasons: ["突破位置远离 EMA20，等待回踩确认，不追单"], scoreBreakdown: emptyBreakdown };
  if (!selected) return { ...base, regime: "trend", trendScore: score.baseScore, score: score.baseScore, setupState: "WAIT_PULLBACK", entryPermission: "wait_pullback", blockers: ["趋势已识别，等待已启用的入场形态触发"], reasons: ["趋势已识别，等待已启用的入场形态触发"], scoreBreakdown: emptyBreakdown, entryCandidates: entry.candidates };
  const stopPreview = calculateInitialStop({ side: directionRaw, entryMode: selected.type, entryPrice: Number(input.close), atr: Number(input.atr), signal: base, input, config });
  const modeMinAtr = selected.type === "breakout_entry" ? config.breakoutMinStopAtr : selected.type === "continuation_entry" ? config.continuationMinStopAtr : config.pullbackMinStopAtr;
  const estimatedStop = stopPreview.allowed ? stopPreview.distance : Math.max(Number(input.atr) * Math.max(modeMinAtr, config.minStopDistanceAtr, config.minimumEffectiveStopAtr), Number(input.close) * config.minimumEffectiveStopBps / 10000);
  const costPerUnit = Number(input.close) * Number(input.roundTripCostRate);
  const estimatedCostR = Number.isFinite(Number(input.costR)) ? Number(input.costR) : estimatedStop > 0 && Number.isFinite(costPerUnit) ? costPerUnit / (estimatedStop + costPerUnit) : null;
  const costEfficiency = costEfficiencyFromR(estimatedCostR, config);
  const total = clamp(score.baseScore + selected.score + costEfficiency.score);
  const scoreBreakdown = { structure: score.structure, strength: score.strength, multiTimeframe: score.multiTimeframe, environment: score.environment, entryQuality: selected.score, costEfficiency: costEfficiency.score, total };
  const graded = gradeFor(total, config);
  if (costEfficiency.state === "BLOCK") return { ...base, regime: "blocked", trendScore: total, score: total, entryQualityScore: selected.score, setupState: "BLOCKED", entryPermission: "blocked", blockers: [`预计交易成本 ${estimatedCostR.toFixed(3)}R 超过上限 ${config.maxAllowedCostR}R`], reasons: [`预计交易成本 ${estimatedCostR.toFixed(3)}R 超过上限 ${config.maxAllowedCostR}R`], entryMode: selected.type, costR: estimatedCostR, scoreBreakdown, entryCandidates: entry.candidates };
  if (Number(input.chop) >= config.chopTransitionMax && selected.type !== "pullback_entry") return { ...base, regime: "conditional", trendScore: total, score: total, entryQualityScore: selected.score, setupState: "WAIT_PULLBACK", entryPermission: "wait_pullback", blockers: [`CHOP ${config.chopTransitionMax}~${config.chopHardBlock} 仅允许高质量 Pullback`], reasons: [`CHOP ${config.chopTransitionMax}~${config.chopHardBlock} 仅允许高质量 Pullback`], scoreBreakdown, entryCandidates: entry.candidates };
  if (Number(input.chop) >= config.chopTransitionMax && selected.score < config.highQualityPullbackScore) return { ...base, regime: "conditional", trendScore: total, score: total, entryQualityScore: selected.score, setupState: "WAIT_PULLBACK", entryPermission: "wait_pullback", blockers: ["偏震荡环境下 Pullback 质量不足"], reasons: ["偏震荡环境下 Pullback 质量不足"], scoreBreakdown, entryCandidates: entry.candidates };
  if (!graded.grade) return { ...base, regime: "trend", trendScore: total, score: total, entryQualityScore: selected.score, setupState: "TREND_FOUND", entryPermission: "blocked", blockers: [`Trend Score ${total.toFixed(1)} 未达到 Grade B`], reasons: [`Trend Score ${total.toFixed(1)} 未达到 Grade B`], entryMode: selected.type, costR: estimatedCostR, scoreBreakdown, entryCandidates: entry.candidates };
  return { ...base, regime: `trend_${selected.type.replace("_entry", "")}`, trendScore: total, score: total, entryQualityScore: selected.score, grade: graded.grade, riskMultiplier: graded.riskMultiplier, setupState: graded.grade === "A" ? "READY_A" : "READY_B", entryPermission: "allowed", tradeDirection: directionRaw, entryMode: selected.type, blockers: [], reasons: [], costR: estimatedCostR, costEfficiencyState: costEfficiency.state, scoreBreakdown, entryCandidates: entry.candidates, states: { breakout: selected.type === "breakout_entry", pullback: selected.type === "pullback_entry", continuation: selected.type === "continuation_entry" } };
}

module.exports = { hardBlockers, detectMarketRegime };
