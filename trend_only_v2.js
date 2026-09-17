"use strict";

const V1 = require("./trend_only");

const { maxChopToTrade: _legacyMaxChopToTrade, ...V1_BASE_DEFAULTS } = V1.DEFAULTS;
const DEFAULTS = Object.freeze({
  ...V1_BASE_DEFAULTS,
  version: "v2",
  chopIdealMax: 45,
  chopTransitionMax: 55,
  chopHardBlock: 61.8,
  adxTrendStart: 22,
  adxTrendValid: 28,
  adxStrong: 32,
  adxVeryStrong: 40,
  minDiSpread: 8,
  higherTimeframeMode: "not_against",
  entryModes: ["breakout_entry", "pullback_entry", "continuation_entry"],
  pullbackEmaBandAtr: 0.5,
  pullbackConfirmLookback: 5,
  pullbackInvalidationAtr: 0.2,
  continuationLookback: 8,
  microBreakLookback: 5,
  maxEntryExtensionAtr: 1.5,
  maxStopDistanceAtr: 2.2,
  minStopDistanceAtr: 0.8,
  softBreakEvenAtR: 1,
  realBreakEvenAtR: 1.5,
  lockProfitAtR: 2.5,
  trailStartAtR: 3,
  defensiveTrailingAtrMultiplier: 1.2,
  reversalConfirmBars: 2,
  reentryCooldownBars: 6
});

const STRICTNESS_PRESETS = Object.freeze({
  conservative: Object.freeze({ chopIdealMax: 45, chopTransitionMax: 52, chopHardBlock: 61.8, adxTrendStart: 25, adxTrendValid: 30, adxStrong: 35, higherTimeframeMode: "strict_align", maxEntryExtensionAtr: 1.2 }),
  standard: Object.freeze({ chopIdealMax: 45, chopTransitionMax: 55, chopHardBlock: 61.8, adxTrendStart: 22, adxTrendValid: 28, adxStrong: 32, higherTimeframeMode: "not_against", maxEntryExtensionAtr: 1.5 }),
  sensitive: Object.freeze({ chopIdealMax: 48, chopTransitionMax: 58, chopHardBlock: 65, adxTrendStart: 20, adxTrendValid: 25, adxStrong: 30, higherTimeframeMode: "not_against", maxEntryExtensionAtr: 1.8, riskPerTrade: 0.005 })
});

const ENTRY_MODES = new Set(["breakout_entry", "pullback_entry", "continuation_entry"]);
function normalizeConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("趋势 V2 配置必须是对象");
  const v1Input = {};
  for (const key of Object.keys(V1.DEFAULTS)) if (key !== "maxChopToTrade" && input[key] !== undefined) v1Input[key] = input[key];
  const { maxChopToTrade: _ignoredLegacyChop, ...legacy } = V1.normalizeConfig({ ...v1Input, maxChopToTrade: 45 });
  const c = { ...DEFAULTS, ...legacy };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (input[key] === undefined) continue;
    if (Array.isArray(fallback)) {
      if (!Array.isArray(input[key]) || !input[key].length || input[key].some(v => !ENTRY_MODES.has(v))) throw Error(`趋势参数 ${key} 无效`);
      c[key] = [...new Set(input[key])];
    } else if (typeof fallback === "number") {
      const value = Number(input[key]);
      if (!Number.isFinite(value) || value < 0) throw Error(`趋势参数 ${key} 无效`);
      c[key] = value;
    } else c[key] = input[key];
  }
  c.version = "v2";
  if (!(c.chopIdealMax < c.chopTransitionMax && c.chopTransitionMax < c.chopHardBlock && c.chopHardBlock <= 100)) throw Error("CHOP 分层参数无效");
  if (!(c.adxTrendStart <= c.adxTrendValid && c.adxTrendValid <= c.adxStrong && c.adxStrong <= c.adxVeryStrong)) throw Error("ADX 分层参数无效");
  if (!new Set(["strict_align", "not_against", "off"]).has(c.higherTimeframeMode)) throw Error("多周期确认模式无效");
  if (!(c.minStopDistanceAtr > 0 && c.minStopDistanceAtr <= c.maxStopDistanceAtr)) throw Error("止损距离参数无效");
  if (!(c.softBreakEvenAtR <= c.realBreakEvenAtR && c.realBreakEvenAtR <= c.lockProfitAtR && c.lockProfitAtR <= c.trailStartAtR)) throw Error("R 倍数保护参数无效");
  for (const key of ["pullbackConfirmLookback", "continuationLookback", "microBreakLookback", "reversalConfirmBars", "reentryCooldownBars"]) {
    if (!Number.isInteger(c[key]) || c[key] < 2 || c[key] > 100) throw Error(`趋势周期 ${key} 无效`);
  }
  return c;
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1); let current = values[0];
  return values.map(value => current += (value - current) * alpha);
}
function detectSwings(candles, lookback, pivotLeft = 2, pivotRight = 2) {
  const source = (candles || []).slice(-Math.max(5, lookback));
  const highs = [], lows = [];
  const left = Math.max(1, Math.floor(Number(pivotLeft) || 2)), right = Math.max(1, Math.floor(Number(pivotRight) || 2));
  for (let index = left; index < source.length - right; index++) {
    const candle = source[index], before = source.slice(index - left, index), after = source.slice(index + 1, index + right + 1);
    if (before.every(item => candle.high > item.high) && after.every(item => candle.high >= item.high)) highs.push({ time: candle.time, price: candle.high, index });
    if (before.every(item => candle.low < item.low) && after.every(item => candle.low <= item.low)) lows.push({ time: candle.time, price: candle.low, index });
  }
  return { highs, lows };
}
function strictlyMoves(items, count, direction, minMove = 0) {
  const values = items.slice(-count).map(item => Number(item.price));
  if (values.length < count) return false;
  return values.slice(1).every((value, index) => direction === "up" ? value > values[index] + minMove : value < values[index] - minMove);
}

function indicatorsFor(raw, config, interval, now = Date.now()) {
  const c = normalizeConfig(config);
  const result = V1.indicatorsFor(raw, { ...c, maxChopToTrade: 45 }, interval, now);
  const candles = result.candles;
  const recent = candles.slice(-Math.max(c.continuationLookback, c.pullbackConfirmLookback, c.microBreakLookback) - 2);
  const microPrevious = candles.slice(-c.microBreakLookback - 1, -1);
  const pullback = candles.slice(-c.pullbackConfirmLookback - 1, -1);
  const closes = candles.map(candle => candle.close), fastSeries = emaSeries(closes, c.emaFast), midSeries = emaSeries(closes, c.emaMid);
  const pullbackStart = candles.length - c.pullbackConfirmLookback - 1;
  const band = result.atr * c.pullbackEmaBandAtr;
  const pullbackTouched = pullback.some((candle, offset) => {
    const index = pullbackStart + offset, fast = fastSeries[index], mid = midSeries[index];
    return [fast, mid].some(level => Number.isFinite(level) && candle.low <= level + band && candle.high >= level - band);
  });
  const swings = detectSwings(candles.slice(0, -1), c.continuationLookback + 8), minSwingMove = result.atr * 0.05;
  const swingContinuationLong = strictlyMoves(swings.lows, 3, "up", minSwingMove) && strictlyMoves(swings.highs, 2, "up", minSwingMove) && result.close > result.emaFast;
  const swingContinuationShort = strictlyMoves(swings.highs, 3, "down", minSwingMove) && strictlyMoves(swings.lows, 2, "down", minSwingMove) && result.close < result.emaFast;
  return {
    ...result,
    recentCandles: recent,
    microHigh: Math.max(...microPrevious.map(x => x.high)),
    microLow: Math.min(...microPrevious.map(x => x.low)),
    pullbackHigh: Math.max(...pullback.map(x => x.high)),
    pullbackLow: Math.min(...pullback.map(x => x.low)),
    pullbackTouchedLong: pullbackTouched,
    pullbackTouchedShort: pullbackTouched,
    swings,
    structureHigh: swings.highs.at(-1)?.price,
    structureLow: swings.lows.at(-1)?.price,
    swingContinuationLong,
    swingContinuationShort
  };
}

function directionOf(i) { return V1.directionOf(i); }
function isEntryExtended(direction, price, emaFast, atr, config = {}) {
  const c = normalizeConfig(config);
  if (![price, emaFast, atr].every(Number.isFinite) || atr <= 0) return false;
  return direction === "long" ? price - emaFast > atr * c.maxEntryExtensionAtr : direction === "short" ? emaFast - price > atr * c.maxEntryExtensionAtr : false;
}
function adxState(i, c) {
  const history = (i.adxHistory || []).filter(Number.isFinite);
  const rising = history.length >= 3 && history.at(-1) > history.at(-2) && history.at(-2) > history.at(-3);
  const falling = history.length >= 3 && history.at(-1) < history.at(-2) && history.at(-2) < history.at(-3);
  const spread = Math.abs(i.diPlus - i.diMinus);
  return { rising, falling, spread, start: i.adx >= c.adxTrendStart && rising, valid: i.adx >= c.adxTrendValid && spread >= c.minDiSpread, strong: i.adx >= c.adxStrong, veryStrong: i.adx >= c.adxVeryStrong };
}
function timeframeAllowed(direction, i, c) {
  if (i.trendDirection !== direction) return false;
  if (c.higherTimeframeMode === "off") return true;
  if (c.higherTimeframeMode === "strict_align") return i.higherDirection === direction;
  return i.higherDirection !== (direction === "long" ? "short" : "long");
}
function pullbackState(direction, i, c) {
  if (direction === "long") return i.pullbackConfirmedLong === true || (i.pullbackTouchedLong === true && i.close > i.microHigh && i.diPlus > i.diMinus && (!Number.isFinite(i.structureLow) || i.pullbackLow >= i.structureLow - i.atr * c.pullbackInvalidationAtr));
  return i.pullbackConfirmedShort === true || (i.pullbackTouchedShort === true && i.close < i.microLow && i.diMinus > i.diPlus && (!Number.isFinite(i.structureHigh) || i.pullbackHigh <= i.structureHigh + i.atr * c.pullbackInvalidationAtr));
}
function continuationState(direction, i) {
  if (direction === "long") return i.continuationConfirmedLong === true || i.swingContinuationLong === true;
  return i.continuationConfirmedShort === true || i.swingContinuationShort === true;
}
function detectMarketRegimeV2(candles, input) {
  const c = normalizeConfig(input.config), blockers = [];
  const required = [input.chop, input.adx, input.atr, input.close, input.emaFast, input.emaMid, input.diPlus, input.diMinus];
  const base = { regime: "data_insufficient", directionRaw: "none", tradeDirection: "none", direction: "none", entryPermission: "blocked", entryMode: null, blockers, reasons: blockers, score: 0, signalTime: input.signalTime,
    structureHigh: Number.isFinite(input.structureHigh) ? input.structureHigh : input.pullbackHigh,
    structureLow: Number.isFinite(input.structureLow) ? input.structureLow : input.pullbackLow,
    distanceFromEmaAtr: Number.isFinite(input.close) && Number.isFinite(input.emaFast) && Number(input.atr) > 0 ? Math.abs(input.close - input.emaFast) / input.atr : null };
  const finish = result => {
    const raw = result.directionRaw || "none", states = result.states || { breakout: false, pullback: false, continuation: false };
    const adx = adxState(input, c), adxPassed = adx.start || adx.valid || adx.strong;
    const entryDirection = input.entryDirection || directionOf(input), timeframePassed = ["long", "short"].includes(raw) && timeframeAllowed(raw, input, c);
    const entryConflict = ["long", "short"].includes(entryDirection) && ["long", "short"].includes(raw) && entryDirection !== raw;
    const chopLabel = !Number.isFinite(input.chop) ? "数据不足" : input.chop < c.chopIdealMax ? "趋势" : input.chop < c.chopTransitionMax ? "过渡" : input.chop < c.chopHardBlock ? "偏震荡" : "震荡";
    const diagnostics = {
      chop: { value: Number.isFinite(input.chop) ? input.chop : null, threshold: { ideal: c.chopIdealMax, transition: c.chopTransitionMax, hardBlock: c.chopHardBlock }, passed: Number.isFinite(input.chop) && input.chop < c.chopHardBlock, label: chopLabel },
      adx: { value: Number.isFinite(input.adx) ? input.adx : null, threshold: c.adxTrendStart, validThreshold: c.adxTrendValid, strongThreshold: c.adxStrong, rising: !!adx.rising, passed: !!adxPassed, label: !Number.isFinite(input.adx) ? "数据不足" : input.adx >= c.adxStrong ? "强趋势" : adxPassed ? "趋势有效" : "趋势强度不足" },
      direction: { entryDirection, trendDirection: input.trendDirection || "none", higherDirection: input.higherDirection || "none", passed: timeframePassed && !entryConflict, timeframePassed, entryConflict, conflict: !timeframePassed || entryConflict },
      breakout: { passed: !!states.breakout, breakoutHigh: Number.isFinite(input.breakoutHigh) ? input.breakoutHigh : null, breakoutLow: Number.isFinite(input.breakoutLow) ? input.breakoutLow : null },
      entry: { breakout: !!states.breakout, pullback: !!states.pullback, continuation: !!states.continuation, extended: result.regime === "extended_no_chase" || isEntryExtended(raw, input.close, input.emaFast, input.atr, c) },
      finalBlockers: [...(result.blockers || result.reasons || [])]
    };
    return { ...result, states, diagnostics };
  };
  if (!required.every(Number.isFinite) || input.atr <= 0) { blockers.push("指标不足，禁止开仓"); return finish(base); }
  const directionRaw = input.directionRaw || (["long", "short"].includes(input.trendDirection) ? input.trendDirection : directionOf(input));
  base.directionRaw = directionRaw;
  if (!new Set(["long", "short"]).has(directionRaw)) { blockers.push("EMA 与 DI 尚未形成明确趋势方向"); return finish({ ...base, regime: "unclear" }); }
  const adx = adxState(input, c), tfAllowed = timeframeAllowed(directionRaw, input, c);
  let score = 20;
  if (input.chop < c.chopIdealMax) score += 20;
  else if (input.chop < c.chopTransitionMax) score += 12;
  else if (input.chop < c.chopHardBlock) score += 4;
  else { blockers.push("CHOP 强震荡，禁止新开仓"); return finish({ ...base, directionRaw, regime: "chop", score });
  }
  if (adx.start) score += 18; else if (adx.valid || adx.strong) score += 20; else blockers.push(`ADX=${input.adx.toFixed(1)} 或 DI 差值不足，趋势强度未确认`);
  if (tfAllowed) score += 20; else blockers.push(c.higherTimeframeMode === "strict_align" ? "4H 未确认同向" : "高周期方向明显反向");
  const breakout = directionRaw === "long" ? input.close > input.breakoutHigh : input.close < input.breakoutLow;
  const pullback = pullbackState(directionRaw, input, c);
  const continuation = continuationState(directionRaw, input);
  const extended = isEntryExtended(directionRaw, input.close, input.emaFast, input.atr, c) && !pullback;
  if (!extended) score += 10;
  let entryMode = null, regime = adx.strong && !adx.rising ? "trend_continuation" : "strong_trend";
  if (extended) {
    blockers.push("趋势有效，但价格已远离 EMA20，等待回踩，不追单");
    return finish({ ...base, directionRaw, direction: directionRaw, regime: "extended_no_chase", entryPermission: "wait_pullback", blockers, reasons: blockers, score: Math.min(100, score), distanceFromEmaAtr: Math.abs(input.close - input.emaFast) / input.atr, states: { breakout, pullback, continuation } });
  }
  if (blockers.length) return finish({ ...base, directionRaw, direction: directionRaw, regime: "unclear", entryPermission: tfAllowed ? "wait_continuation" : "blocked", blockers, reasons: blockers, score: Math.min(100, score), states: { breakout, pullback, continuation } });
  if (input.chop >= c.chopTransitionMax && !pullback) {
    blockers.push("CHOP 偏高，仅允许回踩确认入场");
    return finish({ ...base, directionRaw, direction: directionRaw, regime: "chop", entryPermission: "wait_pullback", blockers, reasons: blockers, score: Math.min(100, score), states: { breakout, pullback, continuation } });
  }
  if (pullback && c.entryModes.includes("pullback_entry")) { entryMode = "pullback_entry"; regime = "trend_pullback"; }
  else if (breakout && input.chop < c.chopTransitionMax && c.entryModes.includes("breakout_entry")) { entryMode = "breakout_entry"; regime = "trend_breakout"; }
  else if (continuation && (adx.strong || adx.spread >= c.minDiSpread) && c.entryModes.includes("continuation_entry")) { entryMode = "continuation_entry"; regime = "trend_continuation"; }
  if (!entryMode) {
    const entryPermission = input.chop >= c.chopTransitionMax ? "wait_pullback" : adx.strong ? "wait_continuation" : "wait_breakout";
    blockers.push(entryPermission === "wait_pullback" ? "等待回踩确认" : entryPermission === "wait_continuation" ? "趋势有效，等待延续结构确认" : "等待突破确认");
    return finish({ ...base, directionRaw, direction: directionRaw, regime, entryPermission, blockers, reasons: blockers, score: Math.min(100, score), states: { breakout, pullback, continuation } });
  }
  score += 10;
  return finish({ ...base, directionRaw, tradeDirection: directionRaw, direction: directionRaw, regime, entryPermission: "allowed", entryMode, blockers: [], reasons: [`${entryMode} 条件通过，可准备${directionRaw === "long" ? "做多" : "做空"}`], score: Math.min(100, score), breakoutLevel: directionRaw === "long" ? input.breakoutHigh : input.breakoutLow, distanceFromEmaAtr: Math.abs(input.close - input.emaFast) / input.atr, states: { breakout, pullback, continuation } });
}

function initialState() {
  return { ...V1.initialState(), trendContext: null, signalJournal: [], lastJournalSignalTime: 0, lastExitSignalTime: 0, lastExitEntryMode: "", lastExitReason: "", lastExitDirection: "", lastExitStructureHigh: null, lastExitStructureLow: null, reversalCount: 0, riskLock: false, riskLockReason: "", stopOrderId: "", stopOrderPrice: null, stopSyncStatus: "not_required", stopLastSyncAt: 0 };
}
function trendId(signal) { return `${signal.directionRaw}:${signal.regime}:${signal.signalTime || 0}`; }
function updateTrendContext(state, signal, i, now = Date.now()) {
  const prior = state.trendContext;
  const sameDirection = prior && prior.directionRaw === signal.directionRaw && signal.directionRaw !== "none";
  state.trendContext = {
    trendId: sameDirection ? prior.trendId : trendId(signal), directionRaw: signal.directionRaw, regime: signal.regime,
    firstDetectedAt: sameDirection ? prior.firstDetectedAt : now, lastUpdatedAt: now,
    lastBreakoutLevel: signal.breakoutLevel ?? prior?.lastBreakoutLevel ?? null,
    lastPullbackLevel: signal.directionRaw === "long" ? signal.structureLow ?? prior?.lastPullbackLevel ?? null : signal.structureHigh ?? prior?.lastPullbackLevel ?? null,
    lastStructureHigh: signal.structureHigh ?? prior?.lastStructureHigh ?? null,
    lastStructureLow: signal.structureLow ?? prior?.lastStructureLow ?? null,
    entryMode: signal.entryMode, entryQuality: signal.score, blockedReason: (signal.blockers || []).join("；"),
    signalAgeBars: sameDirection ? Number(prior.signalAgeBars || 0) + 1 : 0
  };
  return state.trendContext;
}
function appendShadowSignal(state, accountId, signal, i, finalAction = "") {
  if (!signal.signalTime || signal.signalTime === state.lastJournalSignalTime) return false;
  state.lastJournalSignalTime = signal.signalTime;
  state.signalJournal ||= [];
  state.signalJournal.push({ accountId, time: signal.signalTime, price: i.close, regime: signal.regime, directionRaw: signal.directionRaw, tradeDirection: signal.tradeDirection,
    entryPermission: signal.entryPermission, entryMode: signal.entryMode, score: signal.score, chop: i.chop, adx: i.adx, diPlus: i.diPlus, diMinus: i.diMinus,
    emaFast: i.emaFast, emaMid: i.emaMid, trendDirection: i.trendDirection, higherDirection: i.higherDirection,
    distanceFromEmaAtr: Number.isFinite(signal.distanceFromEmaAtr) ? signal.distanceFromEmaAtr : Math.abs(i.close - i.emaFast) / i.atr,
    breakoutState: !!signal.states?.breakout, pullbackState: !!signal.states?.pullback, continuationState: !!signal.states?.continuation,
    blockers: signal.blockers || [], finalAction });
  if (state.signalJournal.length > 1000) state.signalJournal.splice(0, state.signalJournal.length - 1000);
  return true;
}
function riskMultiplier(entryMode) { return entryMode === "continuation_entry" ? 0.7 : 1; }
function tryOpenTrendOnlyPosition(account, signal, i) {
  const c = normalizeConfig(account.trendOnlyConfig), s = account.trendOnlyState, now = i.now ?? Date.now();
  if (signal.entryPermission !== "allowed" || !signal.tradeDirection) return { allowed: false, reason: (signal.blockers || signal.reasons || []).join("；") || "当前信号不允许开仓" };
  if (!account.paper && account.platform === "extended") return { allowed: false, reason: "Extended Live 趋势下单暂未开放；请使用 Paper 测试或切换 Hyperliquid/Binance。" };
  if (c.higherTimeframeMode === "off" && !account.paper) return { allowed: false, reason: "关闭高周期确认仅允许 Paper 测试" };
  if (s.riskLock) return { allowed: false, reason: `risk_lock：${s.riskLockReason || "保护止损单未确认"}` };
  const sameDirectionReentry = s.lastExitSignalTime > 0 && (!s.lastExitDirection || s.lastExitDirection === signal.tradeDirection);
  if (sameDirectionReentry) {
    const bars = Math.floor((Number(signal.signalTime) - Number(s.lastExitSignalTime)) / V1.INTERVALS[c.entryTimeframe]);
    if (bars < c.reentryCooldownBars) return { allowed: false, reason: `同一趋势再入场冷却中，还需 ${c.reentryCooldownBars - Math.max(0, bars)} 根 K 线` };
    const newStructure = signal.entryMode === "pullback_entry" || signal.entryMode === "continuation_entry";
    const structureUpdated = signal.tradeDirection === "long"
      ? Number.isFinite(signal.structureLow) && (!Number.isFinite(s.lastExitStructureLow) || signal.structureLow > s.lastExitStructureLow)
      : Number.isFinite(signal.structureHigh) && (!Number.isFinite(s.lastExitStructureHigh) || signal.structureHigh < s.lastExitStructureHigh);
    if (!newStructure || !structureUpdated) return { allowed: false, reason: "同一趋势冷却已结束，但尚未形成新的回踩或延续结构" };
  }
  const proxy = { ...account, trendOnlyConfig: { ...c, riskPerTrade: c.riskPerTrade * riskMultiplier(signal.entryMode) } };
  const v1Signal = { ...signal, regime: "trend", direction: signal.tradeDirection, reasons: signal.reasons || [], breakoutLevel: signal.breakoutLevel };
  const plan = V1.tryOpenTrendOnlyPosition(proxy, v1Signal, i);
  if (!plan.allowed) return plan;
  const structure = signal.tradeDirection === "long" ? Number(signal.structureLow) - i.atr * c.pullbackInvalidationAtr : Number(signal.structureHigh) + i.atr * c.pullbackInvalidationAtr;
  const atrStop = plan.entryPrice + (signal.tradeDirection === "long" ? -1 : 1) * i.atr * c.stopLossAtrMultiplier;
  let stop = Number.isFinite(structure) && structure > 0 ? structure : atrStop;
  let distance = Math.abs(plan.entryPrice - stop);
  if (distance > i.atr * c.maxStopDistanceAtr) return { allowed: false, reason: "结构止损距离过大，放弃交易" };
  if (distance < i.atr * c.minStopDistanceAtr) { distance = i.atr * c.minStopDistanceAtr; stop = plan.entryPrice + (signal.tradeDirection === "long" ? -distance : distance); }
  const multiplier = riskMultiplier(signal.entryMode), effectiveRisk = c.riskPerTrade * multiplier;
  const entryPrice = plan.entryPrice, equity = Number(account.equity), costRate = Number(i.costRate ?? 0.002);
  const riskAmount = equity * effectiveRisk, positionValue = riskAmount / (distance / entryPrice + costRate);
  const maxPositionValue = equity * c.leverage * c.maxPositionRatio;
  const finalPositionValue = Math.min(positionValue, maxPositionValue, Math.max(0, Number(account.available ?? equity)) * c.leverage * 0.98);
  const step = Number(i.qtyStep || 0.000001), qty = Math.floor(finalPositionValue / entryPrice / step + 1e-9) * step;
  if (!(qty > 0) || qty * entryPrice < Number(i.minNotional || 10)) return { allowed: false, reason: "风险仓位小于交易所最小下单金额，禁止开仓" };
  return { ...plan, qty, positionValue: qty * entryPrice, riskAmount, signal, stopDistance: distance, initialStopLossPrice: stop, riskMultiplier: multiplier, effectiveRisk, entryMode: signal.entryMode, trendId: s.trendContext?.trendId || trendId(signal) };
}
function positionFromFill(plan, fill, now, config) {
  const p = V1.positionFromFill(plan, fill, now, normalizeConfig(config));
  p.config = normalizeConfig(config);
  p.strategyMode = "Trend Only V2"; p.entryMode = plan.entryMode; p.entryQuality = plan.signal.score; p.riskMultiplier = plan.riskMultiplier; p.effectiveRisk = plan.effectiveRisk; p.trendId = plan.trendId;
  if (plan.initialStopLossPrice > 0) p.initialStopLossPrice = p.currentStopLossPrice = plan.initialStopLossPrice;
  p.plannedR = Math.abs(p.entryPrice - p.initialStopLossPrice); p.defensiveMode = false; p.softBreakEvenActivated = false; p.reversalCount = 0;
  return p;
}
function reverseConfirmed(p, i, c) {
  const sign = p.side === "long" ? 1 : -1;
  const emaReverse = sign > 0 ? i.emaFast < i.emaMid : i.emaFast > i.emaMid;
  const diReverse = sign > 0 ? i.diMinus > i.diPlus : i.diPlus > i.diMinus;
  const structureReverse = sign > 0 ? Number.isFinite(i.structureLow) && i.close < i.structureLow : Number.isFinite(i.structureHigh) && i.close > i.structureHigh;
  const higherReverse = i.higherDirection === (sign > 0 ? "short" : "long");
  const reversed = emaReverse || diReverse || structureReverse || higherReverse;
  p.reversalCount = reversed ? Number(p.reversalCount || 0) + 1 : 0;
  return (structureReverse || higherReverse) || p.reversalCount >= c.reversalConfirmBars;
}
function manageTrendOnlyPosition(account, market, i = {}) {
  const p = account.trendOnlyState.position;
  if (!p) return { reason: "", logs: [] };
  const c = normalizeConfig(p.config), price = Number(market.price), sign = p.side === "long" ? 1 : -1, r = Math.abs(p.entryPrice - p.initialStopLossPrice), logs = [];
  if (!(price > 0 && r > 0)) return { reason: "", logs: ["价格无效，保持已有止损"] };
  const tighten = value => { if (Number.isFinite(value) && value > 0) p.currentStopLossPrice = sign > 0 ? Math.max(p.currentStopLossPrice, value) : Math.min(p.currentStopLossPrice, value); };
  const hit = () => sign * (price - p.currentStopLossPrice) <= 0;
  if (hit()) return { reason: p.softBreakEvenActivated || p.breakEvenActivated || p.trailingActive || p.locked1R ? "trend_tp" : "hard_sl", logs };
  p.highestPriceSinceEntry = Math.max(p.highestPriceSinceEntry, price); p.lowestPriceSinceEntry = Math.min(p.lowestPriceSinceEntry, price); p.rMultiple = sign * (price - p.entryPrice) / r;
  if (p.rMultiple >= c.softBreakEvenAtR && !p.softBreakEvenActivated) { tighten(p.entryPrice - sign * r * 0.2); p.softBreakEvenActivated = true; logs.push("已达到 1R，止损移动到 -0.2R"); }
  if (p.rMultiple >= c.realBreakEvenAtR && !p.breakEvenActivated) { tighten(p.entryPrice); p.breakEvenActivated = true; logs.push("已达到 1.5R，止损移动到保本"); }
  if (p.rMultiple >= c.lockProfitAtR && !p.locked1R) { tighten(p.entryPrice + sign * r); p.locked1R = true; logs.push("已达到 2.5R，锁定 1R 利润"); }
  if (p.rMultiple >= c.trailStartAtR && !p.trailingActive) { p.trailingActive = true; logs.push("已达到 3R，启动 ATR 移动止盈"); }
  const fresh = Number(i.signalTime) > Number(p.lastManagedSignalTime || p.signalTime || 0);
  if (fresh) {
    p.lastManagedSignalTime = i.signalTime;
    const adxFalling = i.adxHistory?.length >= 3 && i.adxHistory.at(-1) < i.adxHistory.at(-2) && i.adxHistory.at(-2) < i.adxHistory.at(-3);
    const lowConflict = i.entryDirection && i.entryDirection !== p.side;
    const faded = adxFalling || i.chop >= c.chopTransitionMax || sign * (i.close - i.emaFast) < 0 || lowConflict;
    if (faded && !p.defensiveMode) { p.defensiveMode = true; logs.push("趋势衰减，进入防守模式"); }
    if (!faded && p.defensiveMode && i.chop < c.chopIdealMax && i.trendDirection === p.side) { p.defensiveMode = false; logs.push("趋势恢复，退出防守模式"); }
    if (reverseConfirmed(p, i, c)) return { reason: "trend_reversal", logs };
  }
  if ((p.trailingActive || p.defensiveMode) && Number(i.atr) > 0) {
    const multiplier = p.defensiveMode ? c.defensiveTrailingAtrMultiplier : c.trailingAtrMultiplier;
    tighten((sign > 0 ? p.highestPriceSinceEntry : p.lowestPriceSinceEntry) - sign * i.atr * multiplier);
    const structure = sign > 0 ? i.structureLow : i.structureHigh;
    if (Number.isFinite(structure)) tighten(structure); else logs.push("结构位不足，仅使用 ATR / 价格止损保护");
  }
  if (hit()) return { reason: "trend_tp", logs };
  return { reason: "", logs };
}

module.exports = {
  DEFAULTS, STRICTNESS_PRESETS, INTERVALS: V1.INTERVALS, normalizeConfig, isWeekendBlocked: V1.isWeekendBlocked, weekendProtection: V1.weekendProtection, detectSwings,
  indicatorsFor, directionOf, detectMarketRegimeV2, detectMarketRegime: detectMarketRegimeV2, isEntryExtended, initialState, updateTrendContext,
  appendShadowSignal, tryOpenTrendOnlyPosition, positionFromFill, manageTrendOnlyPosition, recordClose: V1.recordClose
};
