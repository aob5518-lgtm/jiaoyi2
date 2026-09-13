"use strict";

const DEFAULT_TAKER_FEE_RATE = 0.00045;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round((finite(value) + Number.EPSILON) * factor) / factor;
}

function normalizeOrderId(value) {
  if (value === null || value === undefined || value === "") return "";
  return String(value).trim();
}

function extractOrderId(order) {
  const raw = order?.result || order || {};
  return normalizeOrderId(
    order?.oid ?? order?.orderId ?? raw?.oid ?? raw?.orderId ?? raw?.order_id
  );
}

function buildVoucherDedupeKey({
  accountId,
  platform,
  platformOrderId,
  platformTradeId,
  txHash,
  openedAt,
  entryPrice,
  closeQty
} = {}) {
  const prefix = `${String(accountId || "unknown")}:${String(platform || "unknown")}`;
  const strongId = normalizeOrderId(platformOrderId) ||
    normalizeOrderId(platformTradeId) ||
    normalizeOrderId(txHash);
  if (strongId) return `${prefix}:close:${strongId}`;

  return [
    prefix,
    "cycle",
    Math.max(0, Math.floor(finite(openedAt))),
    round(entryPrice, 8),
    round(closeQty, 8)
  ].join(":");
}

function dedupeVouchers(items, limit = 200) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item?.dedupeKey || item?.voucherId || "").trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function summarizeHyperliquidCycle({
  fills,
  funding,
  symbol,
  orderIds,
  closeOrderId,
  startTime,
  endTime,
  fallbackGrossPnl,
  tradedNotionalU,
  estimatedFeeRate = DEFAULT_TAKER_FEE_RATE,
  fundingAvailable = true,
  cycleTrackingComplete = true
} = {}) {
  const coin = String(symbol || "").toUpperCase();
  const from = Math.max(0, finite(startTime));
  const to = Math.max(from, finite(endTime, Date.now()));
  const wantedIds = new Set((Array.isArray(orderIds) ? orderIds : [])
    .map(normalizeOrderId)
    .filter(Boolean));
  const normalizedCloseId = normalizeOrderId(closeOrderId);
  if (normalizedCloseId) wantedIds.add(normalizedCloseId);
  const restrictToOrderIds = wantedIds.size > 0;

  const relevantFills = (Array.isArray(fills) ? fills : []).filter(fill => {
    const fillTime = finite(fill?.time);
    if (coin && String(fill?.coin || "").toUpperCase() !== coin) return false;
    if (fillTime && (fillTime < from || fillTime > to)) return false;
    return !restrictToOrderIds || wantedIds.has(normalizeOrderId(fill?.oid));
  });
  const closeFills = normalizedCloseId
    ? relevantFills.filter(fill => normalizeOrderId(fill?.oid) === normalizedCloseId)
    : relevantFills.filter(fill => Math.abs(finite(fill?.closedPnl)) > 0 || /close/i.test(String(fill?.dir || "")));

  const hasExchangeClose = closeFills.length > 0;
  const grossPnl = hasExchangeClose
    ? closeFills.reduce((sum, fill) => sum + finite(fill?.closedPnl), 0)
    : finite(fallbackGrossPnl);
  const actualTradingFee = relevantFills.reduce(
    (sum, fill) => sum + finite(fill?.fee) + finite(fill?.builderFee),
    0
  );
  const tradingFee = relevantFills.length
    ? actualTradingFee
    : Math.max(0, finite(tradedNotionalU)) * Math.max(0, finite(estimatedFeeRate, DEFAULT_TAKER_FEE_RATE));

  const fundingPnl = fundingAvailable
    ? (Array.isArray(funding) ? funding : []).reduce((sum, item) => {
        const itemTime = finite(item?.time);
        const delta = item?.delta || {};
        if (coin && String(delta.coin || "").toUpperCase() !== coin) return sum;
        if (itemTime && (itemTime < from || itemTime > to)) return sum;
        return sum + finite(delta.usdc);
      }, 0)
    : 0;

  return {
    grossPnl: round(grossPnl),
    tradingFee: round(tradingFee),
    fundingPnl: round(fundingPnl),
    netPnl: round(grossPnl - tradingFee + fundingPnl),
    costSource: relevantFills.length
      ? (!cycleTrackingComplete
        ? "exchange-partial-cycle"
        : (fundingAvailable ? "exchange" : "exchange-fee-only"))
      : "estimated-fee",
    fundingIncluded: !!fundingAvailable,
    matchedFillCount: relevantFills.length
  };
}

module.exports = {
  DEFAULT_TAKER_FEE_RATE,
  extractOrderId,
  buildVoucherDedupeKey,
  dedupeVouchers,
  summarizeHyperliquidCycle
};
