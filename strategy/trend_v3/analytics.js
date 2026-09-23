"use strict";

function netPnl(item) { return Number(item.netPnl ?? item.pnl ?? 0); }
function netR(item) { return Number(item.netR ?? item.rMultiple); }

function summarizeRows(rows) {
  const items = Array.isArray(rows) ? rows : [], wins = items.filter(item => netPnl(item) > 0), losses = items.filter(item => netPnl(item) < 0);
  const rRows = items.filter(item => Number.isFinite(netR(item))), winR = wins.filter(item => Number.isFinite(netR(item))), lossR = losses.filter(item => Number.isFinite(netR(item)));
  const grossProfit = wins.reduce((sum, item) => sum + netPnl(item), 0), grossLoss = Math.abs(losses.reduce((sum, item) => sum + netPnl(item), 0));
  const winRate = items.length ? wins.length / items.length : null, avgWinR = winR.length ? winR.reduce((sum, item) => sum + netR(item), 0) / winR.length : null, avgLossR = lossR.length ? Math.abs(lossR.reduce((sum, item) => sum + netR(item), 0) / lossR.length) : null;
  let equity = 0, peak = 0, maxDrawdown = 0, lossStreak = 0, maxConsecutiveLoss = 0;
  for (const item of [...items].sort((a, b) => Number(a.exitTime || 0) - Number(b.exitTime || 0))) { equity += netPnl(item); peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); lossStreak = netPnl(item) < 0 ? lossStreak + 1 : 0; maxConsecutiveLoss = Math.max(maxConsecutiveLoss, lossStreak); }
  const totalTradingFee = items.reduce((sum, item) => sum + Number(item.tradingFee || 0), 0), totalGrossProfit = items.filter(item => Number(item.grossPnl) > 0).reduce((sum, item) => sum + Number(item.grossPnl), 0);
  const falseEntries = items.filter(item => netPnl(item) < 0 && (Number(item.MAE_R) >= 0.75 || ["hard_sl", "structure_sl", "post_fill_risk_invalid"].includes(item.closeReason)));
  return {
    trades: items.length,
    netPnl: items.reduce((sum, item) => sum + netPnl(item), 0),
    winRate,
    avgNetR: rRows.length ? rRows.reduce((sum, item) => sum + netR(item), 0) / rRows.length : null,
    expectancyR: winRate !== null && avgWinR !== null && avgLossR !== null ? winRate * avgWinR - (1 - winRate) * avgLossR : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalTradingFee,
    feeDrag: totalGrossProfit > 0 ? totalTradingFee / Math.abs(totalGrossProfit) : null,
    falseEntryCount: falseEntries.length,
    falseEntryRate: items.length ? falseEntries.length / items.length : null,
    maxDrawdown,
    maxConsecutiveLoss
  };
}

function buildStrategyAnalytics(history, { strategyVersion = "trend_only_v3", experimentId = "", configHash = "" } = {}) {
  const rows = (Array.isArray(history) ? history : []).filter(item => item.strategyVersion === strategyVersion && (!experimentId || item.experimentId === experimentId) && (!configHash || item.configHash === configHash));
  const modes = {};
  for (const mode of ["breakout_entry", "pullback_entry", "continuation_entry"]) modes[mode] = summarizeRows(rows.filter(item => item.entryMode === mode));
  return { strategyVersion, experimentId: experimentId || null, configHash: configHash || null, summary: summarizeRows(rows), modes };
}

module.exports = { summarizeRows, buildStrategyAnalytics };
