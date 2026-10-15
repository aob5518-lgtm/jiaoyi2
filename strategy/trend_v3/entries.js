"use strict";
const { calculateInitialStop } = require("./stops");
const { describePullback } = require("./telemetry");

function evaluatePullback(direction, input, config = {}) {
  const long = direction === "long";
  const touched = long ? input.pullbackTouchedLong : input.pullbackTouchedShort;
  const structureHeld = long
    ? !Number.isFinite(input.structureLow) || Number(input.pullbackLow) >= Number(input.structureLow) - Number(input.atr) * Number(config.pullbackInvalidationAtr ?? 0.2)
    : !Number.isFinite(input.structureHigh) || Number(input.pullbackHigh) <= Number(input.structureHigh) + Number(input.atr) * Number(config.pullbackInvalidationAtr ?? 0.2);
  const microBreak = long ? Number(input.close) > Number(input.microHigh) : Number(input.close) < Number(input.microLow);
  const diRecovery = long ? Number(input.diPlus) > Number(input.diMinus) : Number(input.diMinus) > Number(input.diPlus);
  const reclaim = long ? Number(input.close) > Number(input.emaFast) : Number(input.close) < Number(input.emaFast);
  const previous = input.candles?.at(-2);
  const previousHigh = Number(input.previousHigh ?? previous?.high), previousLow = Number(input.previousLow ?? previous?.low);
  const directionalClose = long ? Number(input.close) > Number(input.open) : Number(input.close) < Number(input.open);
  const recoveryBreak = reclaim && directionalClose && (long ? Number.isFinite(previousHigh) && Number(input.close) > previousHigh : Number.isFinite(previousLow) && Number(input.close) < previousLow);
  const factors = [touched, structureHeld, microBreak, diRecovery, reclaim];
  const score = factors.filter(Boolean).length * 4;
  // Require a real closed-candle confirmation, but do not insist on a full
  // five-bar break: directional EMA reclaim + previous-bar break is also valid.
  const confirmation = microBreak || recoveryBreak;
  return { type: "pullback_entry", triggered: !!touched && !!structureHeld && confirmation && diRecovery, score, ...describePullback(input,direction,config),confirmationType:microBreak?"MICRO_BREAK":recoveryBreak?"EMA_RECLAIM_PREV_BAR_BREAK":null,diRecovery,factors: { touched: !!touched, structureHeld, microBreak, diRecovery, reclaim, recoveryBreak, confirmation } };
}

function evaluateBreakout(direction, input, config) {
  const long = direction === "long";
  const level = long ? Number(input.breakoutHigh) : Number(input.breakoutLow);
  const broke = Number.isFinite(level) && (long ? Number(input.close) > level : Number(input.close) < level);
  const distance = Number(input.atr) > 0 ? Math.abs(Number(input.close) - Number(input.emaFast)) / Number(input.atr) : Infinity;
  const extended = distance > Number(config.maxEntryExtensionAtr);
  const body = Math.abs(Number(input.close) - Number(input.open || input.close));
  const bodyQuality = Number(input.atr) > 0 && body >= Number(input.atr) * 0.35;
  const compression = input.breakoutCompression ?? input.compression;
  const score = (broke ? 8 : 0) + (compression ? 4 : 0) + (input.expansion ? 4 : 0) + (bodyQuality ? 2 : 0) + (!extended ? 2 : 0);
  return { type: "breakout_entry", triggered: broke && !extended && score >= 12, waitRetest: broke && extended, score, distanceFromEmaAtr: distance, factors: { broke, compression: !!compression, expansion: !!input.expansion, bodyQuality, extended } };
}

function evaluateContinuation(direction, input) {
  const long = direction === "long";
  const structure = long ? input.swingContinuationLong : input.swingContinuationShort;
  const released = !!input.expansion && (long ? Number(input.close) > Number(input.microHigh) : Number(input.close) < Number(input.microLow));
  const compression = input.continuationCompressionRecent ?? input.continuationCompression ?? input.compression;
  const score = (structure ? 8 : 0) + (compression ? 6 : 0) + (released ? 6 : 0);
  return { type: "continuation_entry", triggered: !!structure && !!compression && released, score, factors: { structure: !!structure, compression: !!compression, released } };
}

function chooseEntry(direction, input, config) {
  const enabled = new Set(Array.isArray(config.entryModes) ? config.entryModes : []);
  const all = [evaluatePullback(direction, input, config), evaluateBreakout(direction, input, config), evaluateContinuation(direction, input, config)];
  const candidates = all.map(item => {
    const stop = item.triggered && enabled.has(item.type) ? calculateInitialStop({ side: direction, entryMode: item.type, entryPrice: Number(input.close), atr: Number(input.atr), signal: input, input, config }) : null;
    return { ...item, enabled: enabled.has(item.type), stopAllowed: stop?.allowed ?? null, stopReason: stop && !stop.allowed ? stop.reason : "" };
  });
  // CHOP conditional zone still only admits high-quality pullbacks.
  const eligible = candidates.filter(item => item.enabled && item.triggered && (Number(input.chop) < config.chopTransitionMax || item.type === "pullback_entry"));
  const sorted = eligible.sort((a, b) => b.score - a.score);
  const selected = sorted.find(item => item.stopAllowed !== false) || sorted[0] || null;
  const breakout = candidates.find(item => item.type === "breakout_entry");
  return { selected, candidates, waitRetest: !selected && !!(breakout?.enabled && breakout.waitRetest) };
}

module.exports = { evaluatePullback, evaluateBreakout, evaluateContinuation, chooseEntry };
