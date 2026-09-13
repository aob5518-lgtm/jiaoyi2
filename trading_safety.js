"use strict";

const MINUTE_MS = 60 * 1000;

function classifyTradingError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  if (message.includes("could not immediately match") || message.includes("ioc") && message.includes("not fill")) {
    return { code: "ioc_not_filled", retryable: true, backoffMs: 15 * 1000 };
  }
  if (message.includes("too many cumulative requests")) {
    return { code: "cumulative_request_limit", retryable: false, backoffMs: 60 * MINUTE_MS };
  }
  if (message.includes("minimum value") || message.includes("minimum order")) {
    return { code: "minimum_order_value", retryable: false, backoffMs: 6 * 60 * MINUTE_MS };
  }
  if (message.includes("reduce only order would increase position")) {
    return { code: "reduce_only_conflict", retryable: false, backoffMs: 30 * MINUTE_MS };
  }
  if (message.includes("insufficient margin") || message.includes("insufficient balance")) {
    return { code: "insufficient_funds", retryable: false, backoffMs: 30 * MINUTE_MS };
  }
  if (message.includes("invalid size") || message.includes("invalid price")) {
    return { code: "invalid_order", retryable: false, backoffMs: 30 * MINUTE_MS };
  }
  return { code: "transient", retryable: true, backoffMs: 0 };
}

function calculateMarketableLimitPrice({
  side,
  bestBid,
  bestAsk,
  slippageBps = 12
} = {}) {
  const normalizedSide = String(side || "").toLowerCase();
  const bps = Math.min(100, Math.max(0, Number(slippageBps || 0)));
  const reference = normalizedSide === "buy" ? Number(bestAsk) : Number(bestBid);

  if (!(reference > 0)) {
    throw new Error(`Missing executable ${normalizedSide === "buy" ? "ask" : "bid"} price`);
  }

  const multiplier = normalizedSide === "buy"
    ? 1 + bps / 10000
    : 1 - bps / 10000;
  return reference * multiplier;
}

function formatHyperliquidPrice(price, szDecimals = 4) {
  const value = Number(price);
  if (!(value > 0)) throw new Error("Invalid Hyperliquid limit price");

  const maxDecimals = Math.max(0, 6 - Math.max(0, Math.floor(Number(szDecimals || 0))));
  const significantRounded = Number(value.toPrecision(5));
  return significantRounded
    .toFixed(maxDecimals)
    .replace(/\.?0+$/, "");
}

function isBelowMinimumCloseNotional({
  liveHyperliquid,
  quantity,
  price,
  minimumNotional = 10
} = {}) {
  if (!liveHyperliquid) return false;
  const notional = Math.abs(Number(quantity || 0)) * Math.abs(Number(price || 0));
  const minimum = Math.max(0, Number(minimumNotional || 0));
  return notional > 0 && minimum > 0 && notional < minimum;
}

function decimalPlaces(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return 0;
  if (text.includes("e-")) {
    const [coefficient, exponentText] = text.split("e-");
    const exponent = Number(exponentText);
    const coefficientDecimals = (coefficient.split(".")[1] || "").length;
    return Number.isFinite(exponent) ? exponent + coefficientDecimals : 0;
  }
  return (text.split(".")[1] || "").replace(/0+$/, "").length;
}

function formatBinanceOrderQuantity(quantity, filter = {}) {
  const raw = Number(quantity);
  const step = Number(filter.stepSize);
  const minQty = Number(filter.minQty || 0);
  const maxQty = Number(filter.maxQty || 0);

  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("Binance order quantity must be greater than zero");
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error("Binance quantity step size is unavailable");
  }

  const precision = Math.min(decimalPlaces(filter.stepSize), 12);
  const steps = Math.floor((raw + step * 1e-9) / step);
  const normalized = Number((steps * step).toFixed(precision));
  if (!Number.isFinite(normalized) || normalized <= 0 || (minQty > 0 && normalized < minQty)) {
    throw new Error(`Binance order quantity is below the minimum (${minQty || step})`);
  }
  if (maxQty > 0 && normalized > maxQty) {
    throw new Error(`Binance order quantity exceeds the maximum (${maxQty})`);
  }
  return normalized.toFixed(precision);
}

module.exports = {
  classifyTradingError,
  calculateMarketableLimitPrice,
  formatHyperliquidPrice,
  isBelowMinimumCloseNotional,
  formatBinanceOrderQuantity
};
