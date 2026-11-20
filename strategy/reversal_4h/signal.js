"use strict";

const C = require("./config");
const Trend = require("../../trend_only");
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function bands(rows, config) {
 const closes = rows.slice(-config.bandBars).map(bar => bar.close);
 const middle = average(closes);
 const width = config.bandWidth * Math.sqrt(average(closes.map(close => (close - middle) ** 2)));
 return {middle, lower:middle - width, upper:middle + width};
}

function rsi(rows, period = 14) {
 const changes = rows.slice(1).map((bar, i) => bar.close - rows[i].close);
 let gain = average(changes.slice(0, period).map(delta => Math.max(0, delta)));
 let loss = average(changes.slice(0, period).map(delta => Math.max(0, -delta)));
 for (const delta of changes.slice(period)) {
  gain = (gain * (period - 1) + Math.max(0, delta)) / period;
  loss = (loss * (period - 1) + Math.max(0, -delta)) / period;
 }
 return gain + loss > 0 ? 100 * gain / (gain + loss) : 50;
}

function analyze(rows, input, now) {
 const config = C.normalize(input);
 const closed = rows.filter(bar => bar.time + C.BAR <= now).sort((a, b) => a.time - b.time);
 const wait = (code, reason, extra) => ({...extra, code, reason, side:null});
 if (closed.length < Math.max(43, config.bandBars + 2)) {
  return wait("WARMUP", "已收盘 4H K 线不足，等待原生数据");
 }
 if (closed.some((bar, i) => ![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ||
     bar.time % C.BAR !== 0 || (i > 0 && bar.time - closed[i-1].time !== C.BAR) ||
     !(bar.low > 0 && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close)))) {
  return wait("CANDLE_GAP", "4H K 线不连续或数值无效");
 }
 const bar = closed.at(-1), setup = closed.at(-2), closedAt = bar.time + C.BAR;
 if (closedAt + C.BAR <= now) return wait("CANDLE_STALE", "最新已收盘 4H K 线陈旧");
 // Establish the signal bands before either bar in the pattern. Future candles can only change the next watch range.
 const range = bands(closed.slice(0, -2), config);
 const next = {...bands(closed.slice(0, -1), config), closesAt:closedAt + C.BAR};
 const setupRsi = rsi(closed.slice(0, -1)), currentRsi = rsi(closed);
 const {adx, atr} = Trend.indicatorsFor(closed, {emaFast:10,emaMid:20,emaSlow:40}, "4h", now);
 const info = {next, closedAt, barTime:bar.time, close:bar.close, atr, adx, rsi:currentRsi, setupRsi};
 if (adx > config.maxAdx) {
  return wait("TREND_BLOCK", "4H ADX " + adx.toFixed(1) + " 高于上限 " + config.maxAdx + "，趋势过强，暂停反转入场", info);
 }
 const bottom = setup.close < range.lower && setupRsi <= 35;
 const top = setup.close > range.upper && setupRsi >= 65;
 if (!bottom && !top) return wait("WAIT_REVERSAL", "等待前一根收盘越过布林带且 RSI 到达极值", info);
 const midpoint = (setup.high + setup.low) / 2;
 const long = bottom && bar.close > Math.max(range.lower, midpoint, bar.open) && currentRsi > setupRsi;
 const short = top && bar.close < Math.min(range.upper, midpoint, bar.open) && currentRsi < setupRsi;
 const side = long ? "long" : short ? "short" : null;
 if (!side) return wait("WAIT_CONFIRMATION", "已出现极值，等待反向 K 线收回布林带并确认动量回转", info);
 if (config.direction !== "both" && config.direction !== side) return wait("DIRECTION_BLOCK", "已确认反转，当前设置限制该方向", info);
 const stop = long ? Math.min(bar.low, setup.low) - .25 * atr : Math.max(bar.high, setup.high) + .25 * atr;
 return {...info, side, code:"REVERSAL_CONFIRMED", entry:{stop,target:range.middle},
  reason:long?"底部反转已确认，核对止损与扣成本后的收益空间":"顶部反转已确认，核对止损与扣成本后的收益空间"};
}

module.exports = {analyze};
