"use strict";

function calculateInitialStop({ side, entryMode, entryPrice, atr, signal, input, config }) {
  const sign = side === "long" ? 1 : -1;
  const minByMode = entryMode === "breakout_entry" ? config.breakoutMinStopAtr : entryMode === "continuation_entry" ? config.continuationMinStopAtr : config.pullbackMinStopAtr;
  const minimum = Math.max(Number(atr) * Math.max(minByMode, config.minStopDistanceAtr, config.minimumEffectiveStopAtr), Number(entryPrice) * config.minimumEffectiveStopBps / 10000);
  let structure;
  if (entryMode === "pullback_entry") structure = side === "long" ? Number(input.pullbackLow ?? signal.structureLow) - atr * config.pullbackStopBuffer : Number(input.pullbackHigh ?? signal.structureHigh) + atr * config.pullbackStopBuffer;
  else if (entryMode === "breakout_entry") structure = side === "long" ? Number(input.breakoutLow ?? signal.structureLow) - atr * 0.25 : Number(input.breakoutHigh ?? signal.structureHigh) + atr * 0.25;
  else structure = side === "long" ? Number(signal.structureLow) - atr * 0.35 : Number(signal.structureHigh) + atr * 0.35;
  const legal = Number.isFinite(structure) && structure > 0 && sign * (entryPrice - structure) > 0;
  const distance = Math.max(minimum, legal ? Math.abs(entryPrice - structure) : minimum);
  if (!(distance > 0) || distance > atr * config.maxStopDistanceAtr) return { allowed: false, reason: "结构止损距离超过 maxStopDistanceAtr，放弃当前 setup" };
  const stop = entryPrice - sign * distance;
  if (!(side === "long" ? stop < entryPrice : stop > entryPrice)) return { allowed: false, reason: "止损位于入场价错误一侧" };
  return { allowed: true, stop, distance, distanceAtr: distance / atr, source: legal ? "structure_atr" : "minimum_effective" };
}

module.exports = { calculateInitialStop };
