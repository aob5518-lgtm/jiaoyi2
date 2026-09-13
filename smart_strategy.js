"use strict";

const SMART_STRATEGY_DEFAULTS = Object.freeze({
  strategyType: "smart_regime_v1",
  directionMode: "auto",
  entryTimeframe: "15m",
  trendTimeframe: "1h",
  regimeTimeframe: "4h",
  entryThreshold: 75,
  shortEntryThreshold: 75,
  minScoreEdge: 0,
  addThreshold: 65,
  exitThreshold: 45,
  riskPerTradePct: 0.5,
  maxAdds: 3,
  addMultipliers: [1.3, 1.6, 2.0],
  addAtrMultipliers: [0.8, 1.2, 1.8],
  stopAtr: 2.4,
  takeProfitAtr: 1.5,
  trailingAtr: 2.5,
  estimatedTakerFeePct: 0.045,
  exitSlippageBufferBps: 3,
  exitAtrBuffer: 0.25,
  exitConfirmationBars: 2,
  minHoldMinutes: 30,
  maxMarginPct: 15,
  dailyLossPct: 2,
  consecutiveLossLimit: 3,
  pauseHours: 12,
  lossCooldownMinutes: 15,
  reduceVolPercentile: 90,
  riskOffVolPercentile: 95,
  weights: {
    regime: 25,
    trend: 20,
    setup: 25,
    momentum: 10,
    volume: 10,
    market: 10
  }
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeArray(value, fallback, min, max, length) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
  const normalized = source
    .map(item => clamp(finite(item, NaN), min, max))
    .filter(Number.isFinite)
    .slice(0, length);
  return normalized.length === length ? normalized : [...fallback];
}

function normalizeWeights(value) {
  const source = value && typeof value === "object" ? value : {};
  const raw = {
    regime: clamp(finite(source.regime, 25), 0, 100),
    trend: clamp(finite(source.trend, 20), 0, 100),
    setup: clamp(finite(source.setup, 25), 0, 100),
    momentum: clamp(finite(source.momentum, 10), 0, 100),
    volume: clamp(finite(source.volume, 10), 0, 100),
    market: clamp(finite(source.market, 10), 0, 100)
  };
  const total = Object.values(raw).reduce((sum, item) => sum + item, 0);
  if (total <= 0) return { ...SMART_STRATEGY_DEFAULTS.weights };
  const scaled = {};
  let assigned = 0;
  const keys = Object.keys(raw);
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      scaled[key] = Number((100 - assigned).toFixed(2));
      return;
    }
    scaled[key] = Number((raw[key] / total * 100).toFixed(2));
    assigned += scaled[key];
  });
  return scaled;
}

function normalizeSmartConfig(account = {}) {
  const smart = account.smartStrategy && typeof account.smartStrategy === "object"
    ? account.smartStrategy
    : {};
  const directionModes = new Set(["auto", "long", "short"]);
  const entryFrames = new Set(["5m", "15m", "1h"]);
  const trendFrames = new Set(["15m", "1h", "4h"]);
  const regimeFrames = new Set(["1h", "4h", "1d"]);
  const directionMode = directionModes.has(smart.directionMode) ? smart.directionMode : "auto";
  const entryTimeframe = entryFrames.has(smart.entryTimeframe) ? smart.entryTimeframe : "15m";
  const trendTimeframe = trendFrames.has(smart.trendTimeframe) ? smart.trendTimeframe : "1h";
  const regimeTimeframe = regimeFrames.has(smart.regimeTimeframe) ? smart.regimeTimeframe : "4h";

  const entryThreshold = clamp(finite(smart.entryThreshold, 75), 60, 90);
  return {
    ...SMART_STRATEGY_DEFAULTS,
    directionMode,
    entryTimeframe,
    trendTimeframe,
    regimeTimeframe,
    entryThreshold,
    shortEntryThreshold: clamp(finite(smart.shortEntryThreshold, entryThreshold), 60, 95),
    minScoreEdge: clamp(finite(smart.minScoreEdge, 0), 0, 30),
    addThreshold: clamp(finite(smart.addThreshold, 65), 50, 85),
    exitThreshold: clamp(finite(smart.exitThreshold, 45), 20, 70),
    riskPerTradePct: clamp(finite(smart.riskPerTradePct, 0.5), 0.1, 2),
    maxAdds: Math.floor(clamp(finite(smart.maxAdds, 3), 0, 5)),
    addMultipliers: normalizeArray(
      smart.addMultipliers,
      SMART_STRATEGY_DEFAULTS.addMultipliers,
      0.25,
      3,
      3
    ),
    addAtrMultipliers: normalizeArray(
      smart.addAtrMultipliers,
      SMART_STRATEGY_DEFAULTS.addAtrMultipliers,
      0.25,
      5,
      3
    ),
    stopAtr: clamp(finite(smart.stopAtr, 2.4), 1.5, 4),
    takeProfitAtr: clamp(finite(smart.takeProfitAtr, 1.5), 0.5, 5),
    trailingAtr: clamp(finite(smart.trailingAtr, 2.5), 1, 6),
    estimatedTakerFeePct: clamp(finite(smart.estimatedTakerFeePct, 0.045), 0, 0.2),
    exitSlippageBufferBps: clamp(finite(smart.exitSlippageBufferBps, 3), 0, 25),
    exitAtrBuffer: clamp(finite(smart.exitAtrBuffer, 0.25), 0, 1),
    exitConfirmationBars: Math.floor(clamp(finite(smart.exitConfirmationBars, 2), 1, 4)),
    minHoldMinutes: clamp(finite(smart.minHoldMinutes, 30), 0, 240),
    maxMarginPct: clamp(finite(smart.maxMarginPct, 15), 5, 30),
    dailyLossPct: clamp(finite(smart.dailyLossPct, 2), 0.5, 5),
    consecutiveLossLimit: Math.floor(clamp(finite(smart.consecutiveLossLimit, 3), 1, 10)),
    pauseHours: clamp(finite(smart.pauseHours, 12), 1, 72),
    lossCooldownMinutes: clamp(finite(smart.lossCooldownMinutes, 15), 0, 1440),
    reduceVolPercentile: clamp(finite(smart.reduceVolPercentile, 90), 70, 98),
    riskOffVolPercentile: clamp(finite(smart.riskOffVolPercentile, 95), 80, 99.9),
    weights: normalizeWeights(smart.weights)
  };
}

function calculateSmartAddPlan({
  equity,
  leverage,
  maxMarginPct,
  positionValueU,
  initialNotional,
  addCount,
  maxAdds,
  addMultipliers
} = {}) {
  const safeLeverage = Math.max(1, finite(leverage, 1));
  const safePositionValue = Math.max(0, finite(positionValueU, 0));
  const safeInitialNotional = Math.max(0, finite(initialNotional, 0));
  const safeAddCount = Math.max(0, Math.floor(finite(addCount, 0)));
  const safeMaxAdds = Math.max(0, Math.floor(finite(maxAdds, 0)));
  const multipliers = Array.isArray(addMultipliers) && addMultipliers.length
    ? addMultipliers.map(item => Math.max(0, finite(item, 0)))
    : SMART_STRATEGY_DEFAULTS.addMultipliers;

  if (!(safePositionValue > 0) || safeAddCount >= safeMaxAdds) {
    return { addNotionalU: 0, addMarginU: 0, multiplier: 0, maxNotionalU: 0 };
  }

  const safeEquity = Math.max(0, finite(equity, 0));
  const safeMaxMarginPct = Math.max(0, finite(maxMarginPct, 0));
  const maxNotionalU = safeEquity * safeMaxMarginPct / 100 * safeLeverage;
  const multiplier = multipliers[Math.min(safeAddCount, multipliers.length - 1)] || 0;
  const referenceNotional = safeInitialNotional > 0 ? safeInitialNotional : safePositionValue;
  const desiredNotional = referenceNotional * multiplier;
  const addNotionalU = Math.max(0, Math.min(desiredNotional, maxNotionalU - safePositionValue));

  return {
    addNotionalU: Number(addNotionalU.toFixed(4)),
    addMarginU: Number((addNotionalU / safeLeverage).toFixed(4)),
    multiplier,
    maxNotionalU: Number(maxNotionalU.toFixed(4))
  };
}

function calculateSmartTrailingPrice({
  side,
  entryPrice,
  peakPrice,
  atrValue,
  trailingAtr,
  takeProfitAtr,
  minimumProfitDistance
} = {}) {
  const entry = finite(entryPrice, 0);
  const peak = finite(peakPrice, entry);
  const atrSize = Math.max(0, finite(atrValue, 0));
  if (!(entry > 0) || !(peak > 0) || !(atrSize > 0)) return 0;

  const trailingDistance = atrSize * Math.max(1, finite(trailingAtr, 1));
  const atrProfitLockDistance = atrSize * Math.min(
    0.5,
    Math.max(0.1, finite(takeProfitAtr, 1.5) * 0.25)
  );
  const profitLockDistance = Math.max(
    atrProfitLockDistance,
    Math.max(0, finite(minimumProfitDistance, 0))
  );
  const isLong = side !== "short";
  const rawTrailingPrice = isLong
    ? peak - trailingDistance
    : peak + trailingDistance;
  const minimumProfitPrice = isLong
    ? entry + profitLockDistance
    : entry - profitLockDistance;
  const protectedPrice = isLong
    ? Math.max(rawTrailingPrice, minimumProfitPrice)
    : Math.min(rawTrailingPrice, minimumProfitPrice);

  return Number(protectedPrice.toFixed(2));
}

function calculateSmartMinimumProfitDistance({
  entryPrice,
  atrValue,
  takerFeeRate = 0.00045,
  slippageBufferBps = 3,
  atrBuffer = 0.25
} = {}) {
  const entry = Math.max(0, finite(entryPrice, 0));
  const atrSize = Math.max(0, finite(atrValue, 0));
  if (!(entry > 0)) return 0;

  const roundTripFeeDistance = entry * Math.max(0, finite(takerFeeRate, 0.00045)) * 2;
  const slippageDistance = entry * Math.max(0, finite(slippageBufferBps, 3)) / 10000;
  const volatilityBuffer = atrSize * Math.max(0, finite(atrBuffer, 0.25));
  return Number((roundTripFeeDistance + slippageDistance + volatilityBuffer).toFixed(8));
}

function tightenSmartTrailingPrice({ side, previousPrice, candidatePrice } = {}) {
  const previous = finite(previousPrice, 0);
  const candidate = finite(candidatePrice, 0);
  if (!(candidate > 0)) return previous > 0 ? previous : 0;
  if (!(previous > 0)) return Number(candidate.toFixed(2));
  return Number((side === "short"
    ? Math.min(previous, candidate)
    : Math.max(previous, candidate)).toFixed(2));
}

function isSmartDailyLossLocked({ dailyPnl, dayStartEquity, dailyLossPct } = {}) {
  const equity = Math.max(0, finite(dayStartEquity, 0));
  const limitPct = Math.max(0, finite(dailyLossPct, 0));
  if (!(equity > 0) || !(limitPct > 0)) return false;
  return finite(dailyPnl, 0) <= -(equity * limitPct / 100);
}

function canEnterSmartSignal({ signalTime, lastClosedSignalTime } = {}) {
  const signal = finite(signalTime, 0);
  const closed = finite(lastClosedSignalTime, 0);
  return signal > 0 && signal > closed;
}

function advanceSmartExitConfirmation({
  exitSuggested,
  signalTime,
  previousSignalTime,
  previousCount
} = {}) {
  if (!exitSuggested) return { signalTime: 0, count: 0 };
  const signal = finite(signalTime, 0);
  const previousSignal = finite(previousSignalTime, 0);
  const count = Math.max(0, Math.floor(finite(previousCount, 0)));
  if (!(signal > 0) || signal === previousSignal) {
    return { signalTime: previousSignal, count };
  }
  return { signalTime: signal, count: count + 1 };
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || !values.length) return [];
  const alpha = 2 / (period + 1);
  const result = [Number(values[0])];
  for (let index = 1; index < values.length; index += 1) {
    result.push(Number(values[index]) * alpha + result[index - 1] * (1 - alpha));
  }
  return result;
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((sum, item) => sum + Number(item || 0), 0) / period;
}

function trueRanges(candles) {
  const result = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = index > 0 ? Number(candles[index - 1].close) : Number(candle.open);
    result.push(Math.max(
      Number(candle.high) - Number(candle.low),
      Math.abs(Number(candle.high) - previousClose),
      Math.abs(Number(candle.low) - previousClose)
    ));
  }
  return result;
}

function atr(candles, period = 14) {
  const ranges = trueRanges(candles);
  return sma(ranges, Math.min(period, ranges.length));
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return 50;
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const change = Number(slice[index]) - Number(slice[index - 1]);
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  const relativeStrength = (gains / period) / (losses / period);
  return 100 - 100 / (1 + relativeStrength);
}

function adx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) return 0;
  const plusDm = [];
  const minusDm = [];
  const ranges = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = Number(current.high) - Number(previous.high);
    const downMove = Number(previous.low) - Number(current.low);
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    ranges.push(Math.max(
      Number(current.high) - Number(current.low),
      Math.abs(Number(current.high) - Number(previous.close)),
      Math.abs(Number(current.low) - Number(previous.close))
    ));
  }
  const dxValues = [];
  for (let index = period; index <= ranges.length; index += 1) {
    const tr = ranges.slice(index - period, index).reduce((sum, item) => sum + item, 0);
    if (tr <= 0) continue;
    const plus = plusDm.slice(index - period, index).reduce((sum, item) => sum + item, 0) / tr * 100;
    const minus = minusDm.slice(index - period, index).reduce((sum, item) => sum + item, 0) / tr * 100;
    const denominator = plus + minus;
    if (denominator > 0) dxValues.push(Math.abs(plus - minus) / denominator * 100);
  }
  return dxValues.length ? sma(dxValues, Math.min(period, dxValues.length)) : 0;
}

function percentileRank(values, target) {
  const finiteValues = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finiteValues.length || !Number.isFinite(target)) return 50;
  const below = finiteValues.filter(value => value <= target).length;
  return below / finiteValues.length * 100;
}

function median(values) {
  const finiteValues = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finiteValues.length) return NaN;
  const midpoint = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2
    ? finiteValues[midpoint]
    : (finiteValues[midpoint - 1] + finiteValues[midpoint]) / 2;
}

function completedCandles(candles, minimum = 60) {
  const normalized = (Array.isArray(candles) ? candles : [])
    .map(candle => ({
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume)
    }))
    .filter(candle => Object.values(candle).every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  if (normalized.length < minimum) throw new Error("智能策略K线数据不足");
  return normalized.slice(0, -1);
}

function summarize(candles) {
  const closes = candles.map(item => item.close);
  const volumes = candles.map(item => item.volume);
  const ema20Series = emaSeries(closes, 20);
  const ema50Series = emaSeries(closes, 50);
  const ema200Series = emaSeries(closes, 200);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const currentAtr = atr(candles, 14);
  const ranges = trueRanges(candles);
  const rollingAtrPct = [];
  for (let index = 13; index < ranges.length; index += 1) {
    const rollingAtr = ranges
      .slice(index - 13, index + 1)
      .reduce((sum, value) => sum + value, 0) / 14;
    const close = candles[index]?.close;
    rollingAtrPct.push(close > 0 ? rollingAtr / close * 100 : NaN);
  }
  const atrPct = last.close > 0 ? currentAtr / last.close * 100 : 0;
  const atrBaselinePct = median(rollingAtrPct.slice(-100, -3));
  const volumeAverage = sma(volumes, Math.min(20, volumes.length));
  const fiveBarBase = closes[Math.max(0, closes.length - 6)] || last.close;
  const twentyBarBase = closes[Math.max(0, closes.length - 21)] || last.close;
  const previousTen = candles.slice(-11, -1);

  return {
    last,
    previous,
    close: last.close,
    ema20: ema20Series.at(-1),
    ema50: ema50Series.at(-1),
    ema200: ema200Series.at(-1),
    ema20Slope: ema20Series.length > 6
      ? (ema20Series.at(-1) - ema20Series.at(-6)) / Math.max(Math.abs(ema20Series.at(-6)), 1)
      : 0,
    ema50Slope: ema50Series.length > 6
      ? (ema50Series.at(-1) - ema50Series.at(-6)) / Math.max(Math.abs(ema50Series.at(-6)), 1)
      : 0,
    atr: currentAtr,
    atrPct,
    atrExpansion: atrBaselinePct > 0 ? atrPct / atrBaselinePct : 1,
    volatilityPercentile: percentileRank(rollingAtrPct.slice(-100), atrPct),
    rsi: rsi(closes, 14),
    adx: adx(candles, 14),
    volumeRatio: volumeAverage > 0 ? last.volume / volumeAverage : 1,
    return5: fiveBarBase ? (last.close - fiveBarBase) / fiveBarBase : 0,
    return20: twentyBarBase ? (last.close - twentyBarBase) / twentyBarBase : 0,
    highest10: Math.max(...previousTen.map(item => item.high)),
    lowest10: Math.min(...previousTen.map(item => item.low)),
    rangeToAtr: currentAtr > 0 ? (last.high - last.low) / currentAtr : 0
  };
}

function directionalComponent(condition, points) {
  return condition ? points : 0;
}

function scoreDirection(side, entry, trend, regime, marketContext, weights) {
  const long = side === "long";

  const regimeRaw =
    directionalComponent(long ? regime.close > regime.ema200 : regime.close < regime.ema200, 8) +
    directionalComponent(long ? regime.ema50 > regime.ema200 : regime.ema50 < regime.ema200, 8) +
    directionalComponent(long ? regime.ema50Slope > 0 : regime.ema50Slope < 0, 5) +
    directionalComponent(long ? regime.return20 > 0 : regime.return20 < 0, 4);

  const trendRaw =
    directionalComponent(long ? trend.close > trend.ema50 : trend.close < trend.ema50, 6) +
    directionalComponent(long ? trend.ema20 > trend.ema50 : trend.ema20 < trend.ema50, 6) +
    directionalComponent(trend.adx >= 18, 4) +
    directionalComponent(long ? trend.ema20Slope > 0 : trend.ema20Slope < 0, 4);

  const reclaimed = long
    ? entry.last.low <= entry.ema20 + entry.atr * 0.35 && entry.close > entry.ema20
    : entry.last.high >= entry.ema20 - entry.atr * 0.35 && entry.close < entry.ema20;
  const breakout = long ? entry.close > entry.highest10 : entry.close < entry.lowest10;
  const directionCandle = long
    ? entry.last.close > entry.last.open
    : entry.last.close < entry.last.open;
  const confirmsPrevious = long
    ? entry.close > entry.previous.high
    : entry.close < entry.previous.low;
  const notExtended = Math.abs(entry.close - entry.ema20) <= entry.atr * 1.7;
  const setupRaw =
    directionalComponent(long ? entry.close >= entry.ema20 : entry.close <= entry.ema20, 6) +
    directionalComponent(reclaimed || breakout, 8) +
    directionalComponent(directionCandle, 4) +
    directionalComponent(confirmsPrevious, 4) +
    directionalComponent(notExtended, 3);

  const rsiScore = long
    ? (entry.rsi >= 50 && entry.rsi <= 68 ? 6 : entry.rsi > 68 && entry.rsi <= 75 ? 3 : 0)
    : (entry.rsi >= 32 && entry.rsi <= 50 ? 6 : entry.rsi >= 25 && entry.rsi < 32 ? 3 : 0);
  const momentumRaw = rsiScore + directionalComponent(long ? entry.return5 > 0 : entry.return5 < 0, 4);

  const volumeRaw =
    (entry.volumeRatio >= 1.05 ? 6 : entry.volumeRatio >= 0.8 ? 3 : 0) +
    directionalComponent(directionCandle, 4);

  const fundingRate = Number(marketContext?.fundingRate);
  const basisPct = Number(marketContext?.basisPct);
  let marketRaw = 5;
  if (Number.isFinite(fundingRate)) {
    if (Math.abs(fundingRate) <= 0.0005) marketRaw += 3;
    else if ((long && fundingRate < 0) || (!long && fundingRate > 0)) marketRaw += 2;
  } else {
    marketRaw += 2;
  }
  if (Number.isFinite(basisPct) && Math.abs(basisPct) <= 0.15) marketRaw += 2;
  marketRaw = Math.min(marketRaw, 10);

  const components = {
    regime: regimeRaw / 25 * weights.regime,
    trend: trendRaw / 20 * weights.trend,
    setup: setupRaw / 25 * weights.setup,
    momentum: momentumRaw / 10 * weights.momentum,
    volume: volumeRaw / 10 * weights.volume,
    market: marketRaw / 10 * weights.market
  };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);

  return {
    side,
    score: Number(score.toFixed(2)),
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, Number(value.toFixed(2))])
    ),
    confirmation: reclaimed || breakout || confirmsPrevious,
    directionCandle,
    notExtended
  };
}

function analyzeSmartStrategy({
  entryCandles,
  trendCandles,
  regimeCandles,
  marketContext = {},
  account = {},
  activeSide = ""
}) {
  const config = normalizeSmartConfig(account);
  const entry = summarize(completedCandles(entryCandles, 80));
  const trend = summarize(completedCandles(trendCandles, 100));
  const regime = summarize(completedCandles(regimeCandles, 220));
  const volatilityPercentile = Math.max(
    entry.volatilityPercentile,
    trend.volatilityPercentile
  );
  const stale = !!marketContext.stale;
  const volatilityRiskOff =
    entry.rangeToAtr >= 3 ||
    (volatilityPercentile >= config.riskOffVolPercentile &&
      Math.max(entry.atrExpansion, trend.atrExpansion) >= 1.35);
  const riskOff = stale || volatilityRiskOff;
  const reduceRisk =
    !riskOff &&
    volatilityPercentile >= config.reduceVolPercentile &&
    Math.max(entry.atrExpansion, trend.atrExpansion) >= 1.15;

  const long = scoreDirection("long", entry, trend, regime, marketContext, config.weights);
  const short = scoreDirection("short", entry, trend, regime, marketContext, config.weights);
  let selected = long.score >= short.score ? long : short;
  if (config.directionMode === "long") selected = long;
  if (config.directionMode === "short") selected = short;
  const selectedEntryThreshold = selected.side === "short"
    ? config.shortEntryThreshold
    : config.entryThreshold;
  const oppositeSelected = selected.side === "short" ? long : short;
  const scoreEdge = Number((selected.score - oppositeSelected.score).toFixed(2));
  const edgeAllowed = config.directionMode !== "auto" || scoreEdge >= config.minScoreEdge;

  const regimeName = riskOff
    ? "RISK_OFF"
    : long.components.regime > short.components.regime && long.score >= 55
      ? "TREND_LONG"
      : short.components.regime > long.components.regime && short.score >= 55
        ? "TREND_SHORT"
        : "RANGE";
  const active = activeSide === "short" ? short : long;
  const opposite = activeSide === "short" ? long : short;
  const entryAllowed =
    !riskOff &&
    selected.score >= selectedEntryThreshold &&
    edgeAllowed &&
    selected.confirmation &&
    selected.notExtended;
  const addAllowed =
    !riskOff &&
    !!activeSide &&
    active.score >= config.addThreshold &&
    active.confirmation &&
    active.directionCandle;
  const exitSuggested =
    !!activeSide &&
    (volatilityRiskOff ||
      active.score < config.exitThreshold ||
      opposite.score >= (opposite.side === "short" ? config.shortEntryThreshold : config.entryThreshold));

  return {
    config,
    regime: regimeName,
    riskOff,
    volatilityRiskOff,
    marketDataStale: stale,
    reduceRisk,
    volatilityPercentile: Number(volatilityPercentile.toFixed(2)),
    atr: Number(entry.atr.toFixed(8)),
    atrPct: Number(entry.atrPct.toFixed(4)),
    selectedSide: selected.side,
    selectedScore: selected.score,
    selectedEntryThreshold,
    scoreEdge,
    signalTime: Number(entry.last.time || 0),
    longScore: long.score,
    shortScore: short.score,
    entryAllowed,
    addAllowed,
    exitSuggested,
    activeScore: activeSide ? active.score : 0,
    reasons: {
      long: long.components,
      short: short.components
    },
    diagnostics: {
      entryRsi: Number(entry.rsi.toFixed(2)),
      entryAdx: Number(entry.adx.toFixed(2)),
      trendAdx: Number(trend.adx.toFixed(2)),
      atrExpansion: Number(Math.max(entry.atrExpansion, trend.atrExpansion).toFixed(2)),
      volumeRatio: Number(entry.volumeRatio.toFixed(2)),
      fundingRate: Number.isFinite(Number(marketContext.fundingRate))
        ? Number(marketContext.fundingRate)
        : null,
      basisPct: Number.isFinite(Number(marketContext.basisPct))
        ? Number(marketContext.basisPct)
        : null
    }
  };
}

module.exports = {
  SMART_STRATEGY_DEFAULTS,
  normalizeSmartConfig,
  calculateSmartAddPlan,
  calculateSmartTrailingPrice,
  calculateSmartMinimumProfitDistance,
  tightenSmartTrailingPrice,
  isSmartDailyLossLocked,
  canEnterSmartSignal,
  advanceSmartExitConfirmation,
  analyzeSmartStrategy,
  emaSeries,
  atr,
  rsi,
  adx
};
