"use strict";

const { chooseEntry } = require("./entries");
const { scoreTrend, gradeFor, clamp } = require("./score");

function hardBlockers(input, direction, config) {
  const blockers = [];
  for (const [name, value] of [["价格", input.close], ["ATR", input.atr], ["CHOP", input.chop]]) if (!Number.isFinite(Number(value)) || (name !== "CHOP" && Number(value) <= 0)) blockers.push(`${name}数据无效`);
  if (input.dataStale || input.crossExchangeFallback) blockers.push("行情 stale 或跨交易所 fallback 未验证");
  if (Number(input.chop) >= config.chopHardBlock) blockers.push("CHOP 强震荡禁止交易");
  const opposite = direction === "long" ? "short" : "long", higher = input.higherIndicators || {};
  if (input.higherDirection === opposite && Number(higher.adx) >= config.htfStrongAdx && higher.structureDirection === opposite) blockers.push("HARD_HTF_CONFLICT：4H 强趋势与结构明确反向");
  return blockers;
}

function detectMarketRegime(candles, input) {
  const config = input.config;
  const directionRaw = ["long", "short"].includes(input.trendDirection) ? input.trendDirection : "none";
  const blockers = hardBlockers(input, directionRaw, config);
  const base = { signalTime: input.signalTime, directionRaw, direction: directionRaw, tradeDirection: "none", entryPermission: "blocked", entryMode: null, blockers, reasons: blockers, score: 0, trendScore: 0, entryQualityScore: 0, grade: null, setupState: "SCANNING", states: { breakout: false, pullback: false, continuation: false } };
  if (blockers.length) return { ...base, regime: "blocked", setupState: "BLOCKED", hardBlockers: blockers };
  if (directionRaw === "none") return { ...base, regime: "unclear", blockers: ["1H 主趋势结构尚未成立"], reasons: ["1H 主趋势结构尚未成立"] };
  const score = scoreTrend(input, directionRaw, config);
  const entry = chooseEntry(directionRaw, input, config);
  const selected = entry.selected;
  const entryDirection = input.entryDirection || "none";
  if (entryDirection !== "none" && entryDirection !== directionRaw) return { ...base, regime: "trend", trendScore: score.baseScore, score: score.baseScore, setupState: "WAIT_ENTRY_ALIGNMENT", entryPermission: "wait_entry_alignment", blockers: ["1H 主趋势有效，15m 当前明确反向，等待入场周期重新确认"], reasons: ["1H 主趋势有效，15m 当前明确反向，等待入场周期重新确认"], scoreBreakdown: score };
  if (entry.waitRetest) return { ...base, regime: "trend", trendScore: score.baseScore, score: score.baseScore, setupState: "WAIT_RETEST", entryPermission: "wait_pullback", blockers: ["突破位置远离 EMA20，等待回踩确认，不追单"], reasons: ["突破位置远离 EMA20，等待回踩确认，不追单"], scoreBreakdown: score };
  if (!selected) return { ...base, regime: "trend", trendScore: score.baseScore, score: score.baseScore, setupState: "WAIT_PULLBACK", entryPermission: "wait_pullback", blockers: ["趋势已识别，等待回踩、突破或压缩后延续触发"], reasons: ["趋势已识别，等待回踩、突破或压缩后延续触发"], scoreBreakdown: score, entryCandidates: entry.candidates };
  const total = clamp(score.baseScore + selected.score + 10);
  const graded = gradeFor(total, config);
  if (Number(input.chop) >= 55 && selected.type !== "pullback_entry") return { ...base, regime: "conditional", trendScore: total, entryQualityScore: selected.score, setupState: "WAIT_PULLBACK", entryPermission: "wait_pullback", blockers: ["CHOP 55~61.8 仅允许高质量 Pullback"], reasons: ["CHOP 55~61.8 仅允许高质量 Pullback"], scoreBreakdown: score, entryCandidates: entry.candidates };
  if (Number(input.chop) >= 55 && selected.score < config.highQualityPullbackScore) return { ...base, regime: "conditional", trendScore: total, entryQualityScore: selected.score, setupState: "WAIT_PULLBACK", entryPermission: "wait_pullback", blockers: ["偏震荡环境下 Pullback 质量不足"], reasons: ["偏震荡环境下 Pullback 质量不足"] };
  if (!graded.grade) return { ...base, regime: "trend", trendScore: total, score: total, entryQualityScore: selected.score, setupState: "TREND_FOUND", entryPermission: "blocked", blockers: [`Trend Score ${total.toFixed(1)} 未达到 Grade B`], reasons: [`Trend Score ${total.toFixed(1)} 未达到 Grade B`], entryMode: selected.type };
  return { ...base, regime: `trend_${selected.type.replace("_entry", "")}`, trendScore: total, score: total, entryQualityScore: selected.score, grade: graded.grade, riskMultiplier: graded.riskMultiplier, setupState: graded.grade === "A" ? "READY_A" : "READY_B", entryPermission: "allowed", tradeDirection: directionRaw, entryMode: selected.type, blockers: [], reasons: [], scoreBreakdown: score, entryCandidates: entry.candidates, states: { breakout: selected.type === "breakout_entry", pullback: selected.type === "pullback_entry", continuation: selected.type === "continuation_entry" }, structureHigh: input.structureHigh, structureLow: input.structureLow, distanceFromEmaAtr: Number(input.atr) > 0 ? Math.abs(Number(input.close) - Number(input.emaFast)) / Number(input.atr) : null };
}

module.exports = { hardBlockers, detectMarketRegime };
