"use strict";

function evaluateReentry(state, signal, config) {
  const parentTrendId = state.trendContext?.trendId || `${signal.tradeDirection}:${signal.signalTime}`;
  let trendWave = state.activeEntryWave?.parentTrendId === parentTrendId ? state.activeEntryWave : null;
  let trendId = trendWave?.id || parentTrendId;
  let count = Number(state.trendEntryCounts?.[trendId] || 0);
  const previous = state.reentryState || {};
  const elapsed = Math.floor((Number(signal.signalTime) - Number(previous.lastExitSignalTime)) / Number(config.entryIntervalMs || 900000));
  const sign = signal.tradeDirection === "long" ? 1 : -1;
  const freshWave = [signal.structureHigh, signal.structureLow, previous.structureHigh, previous.structureLow].every(Number.isFinite)
    && sign * (signal.structureHigh - previous.structureHigh) > 0 && sign * (signal.structureLow - previous.structureLow) > 0;
  // A days-long direction is not a single entry wave. Keep the two-entry cap,
  // but recognize a new *confirmed* HH/HL or LH/LL wave after full cooldown.
  if (count >= config.maxEntriesPerTrend && previous.direction === signal.tradeDirection && previous.lastExitSignalTime && elapsed > config.reentryMaxBars && freshWave && ["pullback_entry", "continuation_entry"].includes(signal.entryMode)) {
    trendId = `${parentTrendId}:wave:${signal.structureHigh}:${signal.structureLow}`;
    trendWave = { id: trendId, parentTrendId, structureHigh: signal.structureHigh, structureLow: signal.structureLow };
    count = Number(state.trendEntryCounts?.[trendId] || 0);
  }
  if (count >= config.maxEntriesPerTrend) return { allowed: false, state: "BLOCKED", reason: `同一趋势最多允许 ${config.maxEntriesPerTrend} 次入场`, trendId };
  if (Number(state.lastEntrySignalTime) === Number(signal.signalTime)) return { allowed: false, state: "REENTRY_COOLDOWN", reason: "同一根 K 线禁止重复开仓", trendId };
  const prior = state.reentryState || {};
  if (!prior.lastExitSignalTime || prior.direction !== signal.tradeDirection) return { allowed: true, state: "READY", trendId, trendWave };
  const interval = Number(config.entryIntervalMs || 15 * 60 * 1000);
  const bars = Math.floor((Number(signal.signalTime) - Number(prior.lastExitSignalTime)) / interval);
  if (bars < config.reentryMinBars) return { allowed: false, state: "REENTRY_COOLDOWN", reason: `再入场冷却中，还需 ${config.reentryMinBars - Math.max(0, bars)} 根 K 线`, trendId };
  if (bars > config.reentryMaxBars) {
    state.reentryState = {};
    return { allowed: true, state: "READY", reason: "旧再入场上下文已过期，按当前新趋势重新评估", trendId, trendWave, contextExpired: true, barsSinceExit: bars };
  }
  const newSetup = ["pullback_entry", "continuation_entry"].includes(signal.entryMode);
  const structureUpdated = signal.tradeDirection === "long"
    ? Number.isFinite(signal.structureLow) && (!Number.isFinite(prior.structureLow) || signal.structureLow > prior.structureLow)
    : Number.isFinite(signal.structureHigh) && (!Number.isFinite(prior.structureHigh) || signal.structureHigh < prior.structureHigh);
  if (!newSetup || !structureUpdated) return { allowed: false, state: "WAIT_PULLBACK", reason: "冷却结束，但尚未形成新的回踩或压缩延续结构", trendId };
  return { allowed: true, state: "READY", trendId, trendWave, barsSinceExit: bars };
}

function recordExitState(state, position, voucher) {
  state.reentryState = {
    lastExitSignalTime: Number(position.lastManagedSignalTime || voucher.exitTime || Date.now()),
    direction: position.side,
    structureLow: position.signal?.structureLow,
    structureHigh: position.signal?.structureHigh,
    entryMode: position.entryMode,
    exitReason: voucher.closeReason
  };
}

module.exports = { evaluateReentry, recordExitState };
