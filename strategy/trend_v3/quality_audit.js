"use strict";
const INTERVALS = require("../../trend_only").INTERVALS;
function riskUnit(v) { const qty = Number(v.positionSize); return qty > 0 && Number(v.initialEffectiveRiskU) > 0 ? Number(v.initialEffectiveRiskU) / qty : null; }
function excursion(rows, price, side) { return { mfe: Math.max(0, ...rows.map(c => side === "short" ? price - c.low : c.high - price)), mae: Math.max(0, ...rows.map(c => side === "short" ? c.high - price : price - c.low)) }; }
function classify(mfe, mae) { return mfe >= 1.5 && mae <= 0.5 ? "STOP_TOO_TIGHT" : mae >= 1.5 && mfe < 0.5 ? "ENTRY_WRONG" : mae >= 1 && mfe < 1.5 ? "STOP_CORRECT" : "AMBIGUOUS"; }
function fullWindow(candles, time, n, interval, exclusive = false, now = Date.now()) {
  if (!(Number.isFinite(time) && interval > 0)) return null;
  const start = exclusive ? (Math.floor(time / interval) + 1) * interval : Math.ceil(time / interval) * interval;
  const rows = [...candles].filter(c => c.time >= start && c.time + interval <= now).sort((a,b)=>a.time-b.time).slice(0,n);
  return rows.length === n && rows.every((c,i) => c.time === start + i * interval && Number.isFinite(Number(c.high)) && Number.isFinite(Number(c.low))) ? rows : null;
}
function updateQualityAudit(vouchers, closedCandles) {
  const candles = [...(closedCandles || [])].sort((a,b)=>a.time-b.time); let changed = false;
  for (const v of vouchers || []) {
    if (v.strategyVersion !== "trend_only_v3") continue;
    const risk = riskUnit(v), interval = INTERVALS[v.entryTimeframe] || 900000;
    if (!(risk > 0 && interval > 0)) continue;
    for (const n of [8,16,32]) {
      if (v.closeReason !== "hard_sl" || v[`PostStopMFE_${n}`] !== undefined || !(Number(v.exitPrice)>0)) continue;
      const rows=fullWindow(candles,Number(v.exitTime),n,interval); if(!rows)continue;
      const {mfe,mae}=excursion(rows,Number(v.exitPrice),v.side);
      Object.assign(v,{[`PostStopMFE_${n}`]:mfe,[`PostStopMAE_${n}`]:mae,[`PostStopMFE_R_${n}`]:mfe/risk,[`PostStopMAE_R_${n}`]:mae/risk,[`PostStopClassification_${n}`]:classify(mfe/risk,mae/risk),hardStopAuditPostHocOnly:true}); changed=true;
    }
    for (const n of [4,8,16]) {
      if (v[`EntryMFE_R_${n}`] !== undefined || !(Number(v.entryPrice)>0)) continue;
      const rows=fullWindow(candles,Number(v.entryTime),n,interval); if(!rows)continue;
      const {mfe,mae}=excursion(rows,Number(v.entryPrice),v.side);
      Object.assign(v,{[`EntryMFE_${n}`]:mfe,[`EntryMAE_${n}`]:mae,[`EntryMFE_R_${n}`]:mfe/risk,[`EntryMAE_R_${n}`]:mae/risk,entryWindowsPostHocOnly:true}); changed=true;
    }
  }
  return changed;
}
module.exports = { updateQualityAudit, riskUnit, classify, fullWindow };
