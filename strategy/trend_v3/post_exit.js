"use strict";

function updatePostExitAnalytics(vouchers, closedCandles) {
  const rows = Array.isArray(vouchers) ? vouchers : [], candles = Array.isArray(closedCandles) ? closedCandles : [];
  let changed = false;
  for (const voucher of rows) {
    if (voucher.strategyVersion !== "trend_only_v3" || !Number.isFinite(Number(voucher.exitTime)) || !Number.isFinite(Number(voucher.exitPrice))) continue;
    const future = candles.filter(candle => Number(candle.time) > Number(voucher.exitTime));
    const sign = voucher.side === "short" ? -1 : 1;
    const denominator = Number(voucher.initialEffectiveRiskU) > 0 ? Number(voucher.initialEffectiveRiskU) : Number(voucher.plannedRiskAmount || 0);
    const riskPerUnit = denominator > 0 && Number(voucher.positionSize) > 0 ? denominator / Number(voucher.positionSize) : Number(voucher.plannedR || 0);
    for (const horizon of [8, 16, 32]) {
      const key = `PostExitMFE_${horizon}`;
      if (voucher[key] !== undefined || future.length < horizon) continue;
      const sample = future.slice(0, horizon);
      const favorable = Math.max(0, ...sample.map(candle => sign > 0 ? Number(candle.high) - Number(voucher.exitPrice) : Number(voucher.exitPrice) - Number(candle.low)));
      const adverse = Math.max(0, ...sample.map(candle => sign > 0 ? Number(voucher.exitPrice) - Number(candle.low) : Number(candle.high) - Number(voucher.exitPrice)));
      voucher[key] = favorable;
      voucher[`PostExitMAE_${horizon}`] = adverse;
      voucher[`PostExitMFE_R_${horizon}`] = riskPerUnit > 0 ? favorable / riskPerUnit : null;
      voucher[`PostExitMAE_R_${horizon}`] = riskPerUnit > 0 ? adverse / riskPerUnit : null;
      voucher.postExitAnalyticsPostHocOnly = true;
      changed = true;
    }
  }
  return changed;
}

module.exports = { updatePostExitAnalytics };
