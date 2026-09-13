"use strict";

const assert = require("assert");
const {
  extractOrderId,
  buildVoucherDedupeKey,
  dedupeVouchers,
  summarizeHyperliquidCycle
} = require("../trade_accounting");

assert.strictEqual(extractOrderId({ oid: 123 }), "123");
assert.strictEqual(extractOrderId({ result: { orderId: "abc" } }), "abc");

const key = buildVoucherDedupeKey({
  accountId: "acc-1",
  platform: "hyperliquid",
  platformOrderId: 123
});
assert.strictEqual(key, "acc-1:hyperliquid:close:123");
assert.strictEqual(dedupeVouchers([
  { dedupeKey: key, pnl: 1 },
  { dedupeKey: key, pnl: 1 },
  { dedupeKey: "other", pnl: 2 }
]).length, 2);

const actual = summarizeHyperliquidCycle({
  symbol: "ETH",
  orderIds: [10, 11],
  closeOrderId: 11,
  startTime: 1000,
  endTime: 5000,
  fallbackGrossPnl: 9,
  tradedNotionalU: 2100,
  fills: [
    { coin: "ETH", oid: 10, time: 1500, fee: "0.45", closedPnl: "0" },
    { coin: "ETH", oid: 11, time: 4000, fee: "0.50", closedPnl: "10" },
    { coin: "BTC", oid: 99, time: 3000, fee: "100", closedPnl: "100" }
  ],
  funding: [
    { time: 2500, delta: { coin: "ETH", usdc: "-0.20" } },
    { time: 2500, delta: { coin: "BTC", usdc: "-99" } }
  ]
});
assert.deepStrictEqual(actual, {
  grossPnl: 10,
  tradingFee: 0.95,
  fundingPnl: -0.2,
  netPnl: 8.85,
  costSource: "exchange",
  fundingIncluded: true,
  matchedFillCount: 2
});

const estimated = summarizeHyperliquidCycle({
  symbol: "ETH",
  fallbackGrossPnl: 2,
  tradedNotionalU: 2000,
  estimatedFeeRate: 0.00045,
  fundingAvailable: false
});
assert.strictEqual(estimated.tradingFee, 0.9);
assert.strictEqual(estimated.netPnl, 1.1);
assert.strictEqual(estimated.costSource, "estimated-fee");
assert.strictEqual(estimated.fundingIncluded, false);

const closeOnlyTracked = summarizeHyperliquidCycle({
  symbol: "ETH",
  orderIds: [],
  closeOrderId: 22,
  startTime: 1000,
  endTime: 5000,
  fallbackGrossPnl: 0.01,
  tradedNotionalU: 0.2,
  fills: [
    { coin: "ETH", oid: 21, time: 2000, fee: "0.25", closedPnl: "-1.5" },
    { coin: "ETH", oid: 22, time: 3000, fee: "0.0001", closedPnl: "0.001" }
  ],
  funding: [],
  cycleTrackingComplete: false
});
assert.strictEqual(closeOnlyTracked.grossPnl, 0.001);
assert.strictEqual(closeOnlyTracked.tradingFee, 0.0001);
assert.strictEqual(closeOnlyTracked.netPnl, 0.0009);
assert.strictEqual(closeOnlyTracked.matchedFillCount, 1);

console.log("trade accounting tests passed");
