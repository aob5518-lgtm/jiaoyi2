"use strict";
// Offline closed-candle replay; no exchange orders, no future data in decisions.
const fs = require("node:fs");
const V3 = require("../trend_only_v3");
function review(data, accountInput, engine = V3) {
  const config = engine.normalizeConfig(accountInput.trendOnlyConfig);
  const state = engine.initialState();
  const account = { ...accountInput, paper: true, equity: 100000, available: 100000, trendOnlyState: state };
  const counts = {}, candidates = {}, planBlocks = {}, rows = [], trades = [];
  const cache = new Map();
  const indicator = (tf, now) => {
    const interval = engine.INTERVALS[tf];
    const closed = data.candles[tf].filter(c => c.time + interval <= now).slice(-300);
    const key = `${tf}:${closed.at(-1)?.time}`;
    if (!cache.has(key)) cache.set(key, engine.indicatorsFor(closed, config, tf, now));
    return cache.get(key);
  };
  const bars = data.candles[config.entryTimeframe], interval = engine.INTERVALS[config.entryTimeframe];
  const closePosition = (price, reason, now) => {
    const voucher = engine.recordClose(account, { price, qty: state.position.positionSize }, reason, now);
    account.equity += voucher.netPnl; account.available = account.equity;
    trades.push({ time: new Date(now).toISOString(), side: voucher.side, mode: voucher.entryMode, reason, netPnl: voucher.netPnl, r: voucher.netR });
  };
  for (let index = 0; index < bars.length - 1; index++) {
    const bar = bars[index], now = bar.time + interval;
    if (now < data.start || now >= data.end) continue;
    const values = [config.entryTimeframe, config.trendTimeframe, config.higherTimeframe].map(tf => indicator(tf, now));
    const input = { ...values[0], config, trendDirection: engine.directionOf(values[1], "trend"), higherDirection: engine.directionOf(values[2], "higher"), entryDirection: engine.directionOf(values[0], "entry"), trendIndicators: values[1], higherIndicators: values[2], roundTripCostRate: engine.buildTradeCostModel(account, "candidate").roundTripCostRate, price: bars[index + 1].open };
    const signal = engine.detectMarketRegime(values[0].candles, input);
    engine.updateTrendContext(state, signal, input);
    const flatPlan = engine.tryOpenTrendOnlyPosition({ ...account, trendOnlyState: { ...state, position: null, trendEntryCounts: {}, reentryState: {}, lastEntrySignalTime: 0, lastExitSignalTime: 0 } }, signal, input, config);
    const key = signal.entryPermission === "allowed" ? flatPlan.allowed ? `executable:${signal.entryMode}` : `execution:${flatPlan.reason}` : signal.blockers.join(";");
    counts[key] = (counts[key] || 0) + 1;
    for (const c of signal.entryCandidates || []) {
      const key = `${c.type}:${c.triggered ? "triggered" : "waiting"}`;
      candidates[key] = (candidates[key] || 0) + 1;
      for (const [factor, passed] of Object.entries(c.factors || {})) if (passed) {
        const key = `${c.type}:${factor}`;
        candidates[key] = (candidates[key] || 0) + 1;
      }
    }
    if (state.position) {
      const p = state.position, stop = p.currentStopLossPrice;
      // Conservative OHLC convention: old stop first; new trailing stop applies next bar.
      if (p.side === "long" ? bar.low <= stop : bar.high >= stop) {
        const gap = p.side === "long" ? bar.open < stop : bar.open > stop;
        closePosition((gap ? bar.open : stop) * (1 + (p.side === "long" ? -1 : 1) * Number(config.paperStopSlippageBps || 5) / 10000), p.trailingActive || p.netBreakEvenActivated ? "trend_tp" : "hard_sl", now);
      } else {
        const action = engine.manageTrendOnlyPosition(account, { price: bar.close }, input);
        if (action.reason) closePosition(bar.close, action.reason, now);
      }
    } else if (signal.entryPermission === "allowed") {
      let blocker = engine.isWeekendBlocked(now, config) ? "weekend" : state.pauseUntil > now ? "loss_cooldown" : "";
      const plan = blocker ? { allowed: false, reason: blocker } : engine.tryOpenTrendOnlyPosition(account, signal, input, config);
      if (plan.allowed) {
        state.position = engine.positionFromFill(plan, { price: input.price, qty: plan.qty }, now, config);
        state.lastEntrySignalTime = signal.signalTime;
        state.trendEntryCounts ||= {};
        state.trendEntryCounts[plan.trendId] = Number(state.trendEntryCounts[plan.trendId] || 0) + 1;
        if (plan.executionEvaluation?.trendWave) state.activeEntryWave = plan.executionEvaluation.trendWave;
      } else planBlocks[plan.reason] = (planBlocks[plan.reason] || 0) + 1;
    }
    rows.push({ time: now, price: bar.close, direction: signal.directionRaw, permission: signal.entryPermission, entryMode: signal.entryMode, reason: key, candidates: signal.entryCandidates, score: signal.trendScore });
  }
  const wins = trades.filter(t => t.netPnl > 0), losses = trades.filter(t => t.netPnl < 0);
  return { assumptions: "Closed candles; next-bar open; conservative OHLC stop first; fees included; no funding/intrabar tick reproduction; not live results", from: new Date(data.start).toISOString(), to: new Date(data.end).toISOString(), counts, candidates, planBlocks, trades, summary: { closedTrades: trades.length, netPnl: trades.reduce((s,t)=>s+t.netPnl,0), winRate: trades.length ? wins.length/trades.length : null, profitFactor: losses.length ? wins.reduce((s,t)=>s+t.netPnl,0)/-losses.reduce((s,t)=>s+t.netPnl,0) : null }, rows };
}
if (require.main === module) {
  const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const account = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).account;
  const engine = process.argv[4] ? require(require("node:path").resolve(process.argv[4])) : V3;
  console.log(JSON.stringify(review(data, account, engine), null, 2));
}
module.exports = { review };
