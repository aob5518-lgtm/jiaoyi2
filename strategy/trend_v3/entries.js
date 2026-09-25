"use strict";

function evaluatePullback(direction, input) {
  const long = direction === "long";
  const touched = long ? input.pullbackTouchedLong : input.pullbackTouchedShort;
  const structureHeld = long
    ? !Number.isFinite(input.structureLow) || Number(input.pullbackLow) >= Number(input.structureLow) - Number(input.atr) * 0.2
    : !Number.isFinite(input.structureHigh) || Number(input.pullbackHigh) <= Number(input.structureHigh) + Number(input.atr) * 0.2;
  const microBreak = long ? Number(input.close) > Number(input.microHigh) : Number(input.close) < Number(input.microLow);
  const diRecovery = long ? Number(input.diPlus) > Number(input.diMinus) : Number(input.diMinus) > Number(input.diPlus);
  const reclaim = long ? Number(input.close) > Number(input.emaFast) : Number(input.close) < Number(input.emaFast);
  const factors = [touched, structureHeld, microBreak, diRecovery, reclaim];
  const score = factors.filter(Boolean).length * 4;
  return { type: "pullback_entry", triggered: !!touched && !!structureHeld && score >= 12, score, factors: { touched: !!touched, structureHeld, microBreak, diRecovery, reclaim } };
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
  const compression = input.continuationCompression ?? input.compression;
  const score = (structure ? 8 : 0) + (compression ? 6 : 0) + (released ? 6 : 0);
  return { type: "continuation_entry", triggered: !!structure && !!compression && released, score, factors: { structure: !!structure, compression: !!compression, released } };
}

function chooseEntry(direction, input, config) {
  const enabled = new Set(Array.isArray(config.entryModes) ? config.entryModes : []);
  const all = [evaluatePullback(direction, input, config), evaluateBreakout(direction, input, config), evaluateContinuation(direction, input, config)];
  const candidates = all.map(item => ({ ...item, enabled: enabled.has(item.type) }));
  const selected = candidates.find(item => item.enabled && item.triggered) || null;
  const breakout = candidates.find(item => item.type === "breakout_entry");
  return { selected, candidates, waitRetest: !!(breakout?.enabled && breakout.waitRetest) };
}

module.exports = { evaluatePullback, evaluateBreakout, evaluateContinuation, chooseEntry };
