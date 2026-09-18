"use strict";

const DEFAULTS = Object.freeze({
  enabled: true, leverage: 10, allowWeekendOpen: false, weekendMode: "no_new_position",
  weekendExitHourUTC: 20, riskPerTrade: 0.01, maxPositionRatio: 0.1,
  maxDailyLossRatio: 0.03, maxConsecutiveLosses: 2, cooldownHoursAfterLossLimit: 12,
  atrPeriod: 14, adxPeriod: 14, chopPeriod: 14, emaFast: 20, emaMid: 50, emaSlow: 200,
  minAdxToTrade: 25, maxChopToTrade: 45, stopLossAtrMultiplier: 1.5,
  trailingAtrMultiplier: 2, breakEvenAtR: 1, trailStartAtR: 3,
  timeStopBars: 8, minProfitForTimeStopR: 0.5, breakoutLookback: 20,
  requireMultiTimeframeConfirm: true, entryTimeframe: "15m", trendTimeframe: "1h",
  higherTimeframe: "4h"
});
const INTERVALS = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
function normalizeConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("趋势配置必须是对象");
  const c = { ...DEFAULTS };
  for (const k of Object.keys(c)) {
    if (input[k] === undefined) continue;
    if (typeof c[k] === "number") {
      const n = Number(input[k]);
      if (!Number.isFinite(n) || n < 0 || (n === 0 && k !== "weekendExitHourUTC")) throw Error(`趋势参数 ${k} 无效`);
      c[k] = n;
    } else if (typeof c[k] === "boolean") {
      if (typeof input[k] !== "boolean") throw Error(`趋势参数 ${k} 必须是布尔值`);
      c[k] = input[k];
    } else c[k] = input[k];
  }
  if (c.leverage > 10 || !Number.isInteger(c.leverage)) throw Error("趋势杠杆必须是 1–10 的整数");
  if (c.riskPerTrade > 0.01 || c.maxDailyLossRatio > 0.03 || c.maxPositionRatio > 1) throw Error("趋势风险参数超过安全上限");
  for (const k of ["atrPeriod", "adxPeriod", "chopPeriod", "emaFast", "emaMid", "emaSlow", "timeStopBars", "breakoutLookback", "maxConsecutiveLosses"]) {
    if (!Number.isInteger(c[k]) || c[k] > 240 || c[k] < (k === "maxConsecutiveLosses" || k === "timeStopBars" ? 1 : 2)) throw Error(`趋势周期 ${k} 无效`);
  }
  if (!(c.emaFast < c.emaMid && c.emaMid < c.emaSlow) || c.adxPeriod > 100) throw Error("EMA/ADX 周期无效");
  if (c.minAdxToTrade < 1 || c.minAdxToTrade > 100 || c.maxChopToTrade > 100) throw Error("趋势过滤阈值无效");
  if (c.breakEvenAtR > 2 || c.trailStartAtR < 2) throw Error("R 倍数参数无效");
  if (!Number.isInteger(c.weekendExitHourUTC) || c.weekendExitHourUTC > 23) throw Error("周五保护时间必须为 UTC 0–23 点");
  if (!["no_new_position", "force_flat_before_weekend"].includes(c.weekendMode)) throw Error("周末模式无效");
  for (const k of ["entryTimeframe", "trendTimeframe", "higherTimeframe"]) if (!INTERVALS[c[k]]) throw Error(`不支持的周期 ${k}`);
  if (!(INTERVALS[c.entryTimeframe] < INTERVALS[c.trendTimeframe] && INTERVALS[c.trendTimeframe] < INTERVALS[c.higherTimeframe])) throw Error("确认周期必须逐级增大");
  return c;
}
function isWeekendBlocked(now, config) {
  const d = new Date(now);
  return !config.allowWeekendOpen && [0, 6].includes(d.getUTCDay());
}
function weekendProtection(now, c) {
  const d = new Date(now);
  return c.weekendMode === "force_flat_before_weekend" &&
    ([0, 6].includes(d.getUTCDay()) || (d.getUTCDay() === 5 && d.getUTCHours() >= c.weekendExitHourUTC));
}
function smooth(values, n) {
  const out = Array(values.length).fill(NaN);
  if (values.length < n) return out;
  let v = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = v;
  for (let i = n; i < values.length; i++) out[i] = v = (v * (n - 1) + values[i]) / n;
  return out;
}
function ema(values, n) {
  let v = values[0];
  return values.map(x => v += (x - v) * 2 / (n + 1));
}
function indicatorsFor(raw, config, interval, now = Date.now()) {
  const c = normalizeConfig(config), ms = INTERVALS[interval];
  const candles = (raw || []).map(x => ({ time: Number(x.time), open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close) }))
    .filter(x => Object.values(x).every(Number.isFinite) && x.time + ms <= now)
    .sort((a, b) => a.time - b.time);
  if (candles.length < Math.max(c.emaSlow + 3, c.adxPeriod * 2 + 4, c.breakoutLookback + 1, c.chopPeriod + 1, c.atrPeriod + 1)) throw Error("趋势指标：已收盘 K 线不足");
  for (let i = 0; i < candles.length; i++) {
    const x = candles[i];
    if (!(x.low > 0 && x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close)) || (i && x.time - candles[i - 1].time !== ms)) throw Error("趋势指标：K 线无效或存在缺口");
  }
  const last = candles.at(-1);
  if (now - (last.time + ms) > ms) throw Error("趋势指标：行情过期，禁止新开仓");
  const tr = [], plus = [], minus = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i], b = candles[i - 1], up = a.high - b.high, down = b.low - a.low;
    tr.push(Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close)));
    plus.push(up > down && up > 0 ? up : 0); minus.push(down > up && down > 0 ? down : 0);
  }
  const atrs = smooth(tr, c.atrPeriod), trs = smooth(tr, c.adxPeriod), ps = smooth(plus, c.adxPeriod), ns = smooth(minus, c.adxPeriod);
  const diPlus = ps.map((x, i) => trs[i] > 0 ? 100 * x / trs[i] : 0), diMinus = ns.map((x, i) => trs[i] > 0 ? 100 * x / trs[i] : 0);
  const dx = diPlus.map((x, i) => x + diMinus[i] > 0 ? Math.abs(x - diMinus[i]) / (x + diMinus[i]) * 100 : 0).slice(c.adxPeriod - 1);
  const adxs = smooth(dx, c.adxPeriod), closes = candles.map(x => x.close);
  const fast = ema(closes, c.emaFast), mid = ema(closes, c.emaMid), slow = ema(closes, c.emaSlow);
  const range = candles.slice(-c.chopPeriod), width = Math.max(...range.map(x => x.high)) - Math.min(...range.map(x => x.low));
  const chop = width > 0 ? 100 * Math.log10(tr.slice(-c.chopPeriod).reduce((a, b) => a + b, 0) / width) / Math.log10(c.chopPeriod) : 100;
  const previous = candles.slice(-c.breakoutLookback - 1, -1);
  return { candles, close: last.close, signalTime: last.time, atr: atrs.at(-1), adx: adxs.at(-1), adxHistory: adxs.slice(-3), chop,
    emaFast: fast.at(-1), emaMid: mid.at(-1), emaSlow: slow.at(-1), emaSlope: fast.at(-1) - fast.at(-2),
    diPlus: diPlus.at(-1), diMinus: diMinus.at(-1), breakoutHigh: Math.max(...previous.map(x => x.high)), breakoutLow: Math.min(...previous.map(x => x.low)) };
}
function directionOf(i) {
  if (!i) return "none";
  if (i.close > i.emaFast && i.emaFast > i.emaMid && i.emaSlope > 0 && i.diPlus > i.diMinus) return "long";
  if (i.close < i.emaFast && i.emaFast < i.emaMid && i.emaSlope < 0 && i.diMinus > i.diPlus) return "short";
  return "none";
}
function detectMarketRegime(candles, i) {
  const c = normalizeConfig(i.config), reasons = [];
  let regime = "unclear", direction = directionOf(i), score = 0;
  const entryDirection = direction;
  const rising = i.adxHistory?.length === 3 && i.adxHistory[2] > i.adxHistory[1] && i.adxHistory[1] > i.adxHistory[0];
  const valid = [i.chop, i.adx, i.atr, i.close, i.emaFast, i.emaMid, i.emaSlope, i.diPlus, i.diMinus, i.breakoutHigh, i.breakoutLow].every(Number.isFinite) && i.atr > 0;
  const chopPassed = valid && i.chop < c.maxChopToTrade;
  const adxPassed = valid && i.adx >= c.minAdxToTrade && rising;
  const breakout = valid && (entryDirection === "long" ? i.close > i.breakoutHigh : entryDirection === "short" && i.close < i.breakoutLow);
  const mtf = valid && (!c.requireMultiTimeframeConfirm || (entryDirection !== "none" && i.trendDirection === entryDirection && i.higherDirection === entryDirection));
  const higherTimeframePassed = valid && (!c.requireMultiTimeframeConfirm || (["long", "short"].includes(i.trendDirection) && i.higherDirection === i.trendDirection));
  const entryConflict = entryDirection === "none" || (["long", "short"].includes(i.trendDirection) && entryDirection !== i.trendDirection);
  const diagnostics = {
    chop: { value: Number.isFinite(i.chop) ? i.chop : null, threshold: c.maxChopToTrade, state: chopPassed ? "PASS" : "BLOCK", passed: chopPassed, conditional: false, label: !Number.isFinite(i.chop) ? "数据不足" : i.chop >= 50 ? "强震荡禁止交易" : i.chop >= c.maxChopToTrade ? "震荡过滤阻断" : "趋势通过" },
    adx: { value: Number.isFinite(i.adx) ? i.adx : null, threshold: c.minAdxToTrade, rising: !!rising, passed: adxPassed, label: !Number.isFinite(i.adx) ? "数据不足" : adxPassed ? "趋势有效" : "趋势强度不足" },
    direction: { entryDirection, trendDirection: i.trendDirection || "none", higherDirection: i.higherDirection || "none", passed: entryDirection !== "none" && mtf, timeframePassed: !!higherTimeframePassed, entryConflict, conflict: !higherTimeframePassed || entryConflict },
    breakout: { passed: !!breakout, breakoutHigh: Number.isFinite(i.breakoutHigh) ? i.breakoutHigh : null, breakoutLow: Number.isFinite(i.breakoutLow) ? i.breakoutLow : null },
    entry: { breakout: !!breakout, pullback: false, continuation: false, extended: false },
    finalBlockers: reasons
  };
  if (!valid) { reasons.push("指标不足，禁止开仓"); return { regime, direction: "none", directionRaw: entryDirection, tradeDirection: "none", entryPermission: "blocked", score, reasons, blockers: reasons, diagnostics, signalTime: i.signalTime }; }
  if (!chopPassed) { regime = i.chop >= 50 ? "chop" : "unclear"; reasons.push(`市场状态：CHOP=${i.chop.toFixed(1)}，${regime === "chop" ? "震荡行情" : "趋势不明确"}，禁止开仓。`); }
  else score += 20;
  if (!adxPassed) reasons.push(`ADX=${i.adx.toFixed(1)}，未达到趋势强度或连续上升要求。`); else score += 20;
  if (direction === "none") reasons.push("EMA 与 DI 方向不明确或冲突，禁止开仓。"); else score += 20;
  if (!breakout) reasons.push("等待收盘突破确认。"); else score += 20;
  if (!mtf) reasons.push(`多周期确认失败：${c.trendTimeframe}=${i.trendDirection || "none"}，${c.higherTimeframe}=${i.higherDirection || "none"}，禁止开仓。`); else score += 20;
  if (reasons.length) direction = "none";
  else { regime = "trend"; reasons.push(`趋势过滤通过：ADX=${i.adx.toFixed(1)}，EMA、DI、突破及多周期方向一致（${direction === "long" ? "做多" : "做空"}）。`); }
  diagnostics.finalBlockers = direction === "none" ? [...reasons] : [];
  return { regime, direction, directionRaw: entryDirection, tradeDirection: direction, entryPermission: direction === "none" ? "blocked" : "allowed", score, reasons, blockers: diagnostics.finalBlockers, diagnostics, signalTime: i.signalTime, breakoutLevel: direction === "long" ? i.breakoutHigh : i.breakoutLow };
}
function initialState() { return { position: null, pendingOrder: null, submittedIds: [], dailyDate: "", dailyLoss: 0, dayStartEquity: 0, consecutiveLosses: 0, pauseUntil: 0, lastEntrySignalTime: 0, journal: [] }; }
function rollDay(s, equity, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (s.dailyDate !== today) { s.dailyDate = today; s.dailyLoss = 0; s.dayStartEquity = equity; }
}
function tryOpenTrendOnlyPosition(account, signal, i) {
  const c = normalizeConfig(account.trendOnlyConfig), s = account.trendOnlyState, now = i.now ?? Date.now();
  rollDay(s, Number(account.equity), now);
  let reason = "";
  if (!c.enabled) reason = "趋势策略未启用";
  else if (isWeekendBlocked(now, c)) reason = "周末过滤：当前为周六/周日，禁止新开仓";
  else if (weekendProtection(now, c)) reason = "周五平仓保护：禁止新开仓";
  else if (s.position || account.positionQty > 0) reason = "当前已有仓位，禁止加仓";
  else if (s.pendingOrder || account.pendingOrder || account.unknownOrderState) reason = "订单状态未确认，禁止重复下单";
  else if (now < s.pauseUntil) reason = "风控暂停：连续亏损冷却中";
  else if (!(s.dayStartEquity > 0) || s.dailyLoss >= s.dayStartEquity * c.maxDailyLossRatio) reason = "风控暂停：日亏损达到上限或权益无效";
  else if (signal.regime !== "trend" || !["long", "short"].includes(signal.direction)) reason = signal.reasons.join(" ");
  else if (!(signal.signalTime > s.lastEntrySignalTime)) reason = "等待新的已收盘信号，禁止同一根 K 线重复开仓";
  else if (!account.paper && account.confirmLive !== true) reason = "Live 开仓等待本次信号二次确认";
  if (reason) return { allowed: false, reason };
  const entryPrice = Number(i.price), equity = Number(account.equity), stopDistance = i.atr * c.stopLossAtrMultiplier;
  if (!(entryPrice > stopDistance && stopDistance > 0 && equity > 0)) return { allowed: false, reason: "ATR、价格或权益无效" };
  // Budget fees and adverse execution as well as the price stop. Gaps can still exceed the planned budget.
  const costRate = Number(i.costRate ?? 0.002);
  const riskAmount = equity * c.riskPerTrade, stopLossRatio = stopDistance / entryPrice;
  const positionValue = riskAmount / (stopLossRatio + costRate);
  const maxPositionValue = equity * c.leverage * c.maxPositionRatio;
  const finalPositionValue = Math.min(positionValue, maxPositionValue, Math.max(0, Number(account.available ?? equity)) * c.leverage * 0.98);
  const step = Number(i.qtyStep || 0.000001);
  const qty = Math.floor(finalPositionValue / entryPrice / step + 1e-9) * step;
  if (!(qty > 0) || qty * entryPrice < Number(i.minNotional || 10)) return { allowed: false, reason: "风险仓位小于交易所最小下单金额，禁止开仓" };
  return { allowed: true, side: signal.direction, qty, positionValue: qty * entryPrice, riskAmount, stopDistance, entryPrice, leverage: c.leverage, signal, atrAtEntry: i.atr };
}
function positionFromFill(plan, fill, now, config) {
  if (!(fill.qty > 0 && fill.price > 0) || fill.qty > plan.qty * 1.000001) throw Error("成交信息无效");
  const stop = fill.price + (plan.side === "long" ? -1 : 1) * plan.stopDistance;
  if (!(stop > 0)) throw Error("成交后止损价格无效");
  return { strategyMode: "Trend Only V1", entryTime: now, entryPrice: fill.price, side: plan.side,
    leverage: plan.leverage, positionSize: fill.qty, positionValue: fill.qty * fill.price,
    initialStopLossPrice: stop, currentStopLossPrice: stop, atrAtEntry: plan.atrAtEntry,
    riskAmount: plan.riskAmount, plannedR: plan.stopDistance, signalScore: plan.signal.score,
    signalReasons: plan.signal.reasons, signalTime: plan.signal.signalTime, breakoutLevel: plan.signal.breakoutLevel,
    clientOrderId: fill.clientOrderId, exchangeOrderId: fill.exchangeOrderId, filledQty: fill.qty,
    avgFillPrice: fill.price, highestPriceSinceEntry: fill.price, lowestPriceSinceEntry: fill.price,
    breakEvenActivated: false, locked1R: false, trailingActive: false, config: normalizeConfig(config), realizedPnl: 0 };
}
function manageTrendOnlyPosition(account, market, i = {}) {
  const p = account.trendOnlyState.position;
  if (!p) return { reason: "", logs: [] };
  const c = normalizeConfig(p.config), price = Number(market.price), now = market.now ?? Date.now(), sign = p.side === "long" ? 1 : -1;
  const weekendBlocked = isWeekendBlocked(now, c);
  const r = Math.abs(p.entryPrice - p.initialStopLossPrice), logs = [];
  if (!(price > 0 && r > 0)) return { reason: "", logs: ["价格无效，保持已有止损，等待行情恢复"] };
  const hit = () => sign * (price - p.currentStopLossPrice) <= 0;
  if (hit()) return { reason: p.breakEvenActivated || p.trailingActive || p.locked1R ? "trend_tp" : "hard_sl", logs };
  p.highestPriceSinceEntry = Math.max(p.highestPriceSinceEntry, price); p.lowestPriceSinceEntry = Math.min(p.lowestPriceSinceEntry, price);
  p.rMultiple = sign * (price - p.entryPrice) / r;
  const tighten = v => { p.currentStopLossPrice = sign > 0 ? Math.max(p.currentStopLossPrice, v) : Math.min(p.currentStopLossPrice, v); };
  if (p.rMultiple >= c.breakEvenAtR && !p.breakEvenActivated) { tighten(p.entryPrice); p.breakEvenActivated = true; logs.push(`已达到 ${c.breakEvenAtR}R，止损移动到保本`); }
  if (p.rMultiple >= 2 && !p.locked1R) { tighten(p.entryPrice + sign * r); p.locked1R = true; logs.push("已达到 2R，锁定 1R 利润"); }
  if (p.rMultiple >= c.trailStartAtR && !p.trailingActive) { p.trailingActive = true; logs.push(`已达到 ${c.trailStartAtR}R，启动 ATR 移动止盈`); }
  if (p.trailingActive && i.atr > 0) tighten((sign > 0 ? p.highestPriceSinceEntry : p.lowestPriceSinceEntry) - sign * i.atr * c.trailingAtrMultiplier);
  if (hit()) return { reason: "trend_tp", logs };
  const freshClose = Number(i.signalTime) > p.signalTime;
  if (!weekendBlocked && freshClose && sign * (i.close - p.breakoutLevel) < 0) return { reason: "structure_sl", logs };
  const reverse = sign > 0 ? (i.emaFast < i.emaMid || i.diMinus > i.diPlus || i.trendDirection === "short") : (i.emaFast > i.emaMid || i.diPlus > i.diMinus || i.trendDirection === "long");
  if (freshClose && reverse) return { reason: "trend_reversal", logs };
  const faded = freshClose && i.adxHistory?.length === 3 && i.adxHistory[2] < i.adxHistory[1] && i.adxHistory[1] < i.adxHistory[0] &&
    (sign * (i.close - i.emaFast) < 0 || i.chop >= 50 || (c.requireMultiTimeframeConfirm && (i.trendDirection !== p.side || i.higherDirection !== p.side)));
  if (weekendProtection(now, c) && (p.rMultiple > 0 || faded)) return { reason: "weekend_exit", logs };
  if (!weekendBlocked && faded && p.rMultiple > 0) return { reason: "trend_tp", logs };
  if (!weekendBlocked && freshClose && i.signalTime >= p.signalTime + c.timeStopBars * INTERVALS[c.entryTimeframe] && p.rMultiple < c.minProfitForTimeStopR) return { reason: "time_stop", logs };
  return { reason: "", logs };
}
function recordClose(account, fill, reason, now = Date.now()) {
  const s = account.trendOnlyState, p = s.position, c = normalizeConfig(p.config);
  if (!(fill.qty > 0 && fill.qty <= p.positionSize * 1.000001 && fill.price > 0)) throw Error("平仓成交数量或价格无效");
  const qty = Math.min(fill.qty, p.positionSize), gross = (fill.price - p.entryPrice) * qty * (p.side === "long" ? 1 : -1);
  const fee = Number(fill.fee ?? (p.entryPrice + fill.price) * qty * 0.0005), pnl = gross - fee;
  rollDay(s, Number(account.equity), now);
  s.dailyLoss += Math.max(0, -pnl); p.realizedPnl += pnl;
  const voucher = { accountId: account.id, accountName: account.name, platform: account.platform, symbol: account.symbol, quoteAsset: account.quoteAsset,
    ...p, exitTime: now, exitPrice: fill.price, positionSize: qty, positionValue: qty * p.entryPrice, pnl,
    roi: pnl / (qty * p.entryPrice / p.leverage) * 100, rMultiple: pnl / (qty * p.plannedR), closeReason: reason,
    finalStopLossPrice: p.currentStopLossPrice, entryClientOrderId: p.clientOrderId, entryExchangeOrderId: p.exchangeOrderId,
    clientOrderId: fill.clientOrderId, exchangeOrderId: fill.exchangeOrderId, platformTradeId: fill.platformTradeId || fill.exchangeOrderId,
    txHash: fill.txHash || "", explorerUrl: fill.explorerUrl || "", grossPnl: gross, tradingFee: fee, costSource: fill.fee === undefined ? "estimated" : "exchange",
    id: `${fill.clientOrderId}:${fill.exchangeOrderId}:${fill.qty}`, time: new Date(now).toISOString(), tradeMode: account.paper ? "simulation" : "live" };
  delete voucher.config;
  p.positionSize = Math.max(0, p.positionSize - qty);
  if (p.positionSize < 1e-10) {
    s.consecutiveLosses = p.realizedPnl < 0 ? s.consecutiveLosses + 1 : 0;
    if (s.consecutiveLosses >= c.maxConsecutiveLosses) { s.pauseUntil = now + c.cooldownHoursAfterLossLimit * 3600000; s.consecutiveLosses = 0; }
    s.position = null;
  }
  s.journal.push(voucher);
  return voucher;
}
module.exports = { DEFAULTS, INTERVALS, normalizeConfig, isWeekendBlocked, weekendProtection, indicatorsFor, directionOf, detectMarketRegime, initialState, tryOpenTrendOnlyPosition, positionFromFill, manageTrendOnlyPosition, recordClose };
