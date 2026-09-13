"use strict";

const assert = require("assert");
const {
  classifyTradingError,
  calculateMarketableLimitPrice,
  formatHyperliquidPrice,
  isBelowMinimumCloseNotional,
  formatBinanceOrderQuantity
} = require("../trading_safety");

const quota = classifyTradingError(new Error("Too many cumulative requests sent (49481 > 31171)"));
assert.strictEqual(quota.code, "cumulative_request_limit");
assert.strictEqual(quota.retryable, false);
assert.strictEqual(quota.backoffMs, 60 * 60 * 1000);

const dust = classifyTradingError(new Error("Order must have minimum value of $10"));
assert.strictEqual(dust.code, "minimum_order_value");
assert.strictEqual(dust.retryable, false);
assert.strictEqual(dust.backoffMs, 6 * 60 * 60 * 1000);

const transient = classifyTradingError(new Error("Order could not immediately match against any resting orders"));
assert.strictEqual(transient.code, "ioc_not_filled");
assert.strictEqual(transient.retryable, true);
assert.strictEqual(transient.backoffMs, 15 * 1000);

assert(Math.abs(calculateMarketableLimitPrice({
  side: "buy",
  bestBid: 1849.9,
  bestAsk: 1850,
  slippageBps: 12
}) - 1852.22) < 1e-9);
assert(Math.abs(calculateMarketableLimitPrice({
  side: "sell",
  bestBid: 1850,
  bestAsk: 1850.1,
  slippageBps: 18
}) - 1846.67) < 1e-9);
assert.strictEqual(formatHyperliquidPrice(1852.2199999999998, 4), "1852.2");
assert.strictEqual(formatHyperliquidPrice(0.00123456, 1), "0.00123");

assert.strictEqual(isBelowMinimumCloseNotional({
  liveHyperliquid: true,
  quantity: 0.0012,
  price: 1850,
  minimumNotional: 10
}), true);
assert.strictEqual(isBelowMinimumCloseNotional({
  liveHyperliquid: true,
  quantity: 0.01,
  price: 1850,
  minimumNotional: 10
}), false);

assert.strictEqual(formatBinanceOrderQuantity(0.123456, {
  stepSize: "0.001",
  minQty: "0.001",
  maxQty: "1000"
}), "0.123");
assert.strictEqual(formatBinanceOrderQuantity(1.239, {
  stepSize: "0.01",
  minQty: "0.01",
  maxQty: "1000"
}), "1.23");
assert.strictEqual(formatBinanceOrderQuantity(17, {
  stepSize: "1",
  minQty: "1",
  maxQty: "1000"
}), "17");
assert.throws(() => formatBinanceOrderQuantity(0.009, {
  stepSize: "0.01",
  minQty: "0.01",
  maxQty: "1000"
}), /below the minimum/);
assert.strictEqual(isBelowMinimumCloseNotional({
  liveHyperliquid: false,
  quantity: 0.0012,
  price: 1850,
  minimumNotional: 10
}), false);

console.log("trading safety tests passed");
