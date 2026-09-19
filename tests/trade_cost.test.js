const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getEstimatedTradeCost } = require("../trade_cost");

test("交易成本统一为入场费、出场费和双边预估滑点", () => {
  const cost = getEstimatedTradeCost({ platform: "hyperliquid", paper: true, simulationSlippageBps: 5 }, "breakout_entry");
  assert.equal(cost.entryFeeRate, 0.0005);
  assert.equal(cost.exitFeeRate, 0.0005);
  assert.equal(cost.expectedSlippageRate, 0.001);
  assert.equal(cost.roundTripCostRate, 0.002);
});

test("Paper 使用账户滑点配置，entryMode 可配置额外滑点倍数", () => {
  const cost = getEstimatedTradeCost({ platform: "binance", paper: true, simulationSlippageBps: 10, tradeCostConfig: { entryModeSlippageMultiplier: { breakout_entry: 1.5 } } }, "breakout_entry");
  assert.equal(cost.expectedSlippageRate, 0.003);
  assert.equal(cost.roundTripCostRate, 0.004);
});
