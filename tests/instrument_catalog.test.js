"use strict";

const assert = require("assert");
const {
  normalizeInstrumentSymbol,
  listInstruments,
  getInstrument,
  isInstrumentAllowed,
  getInstrumentGroups
} = require("../instrument_catalog");

assert.strictEqual(normalizeInstrumentSymbol(" tslausdt "), "TSLA");
assert.strictEqual(isInstrumentAllowed("binance", "TSLA"), true);
assert.strictEqual(isInstrumentAllowed("binance", "XRP"), true);
assert.strictEqual(isInstrumentAllowed("hyperliquid", "TSLA"), false);
assert.strictEqual(isInstrumentAllowed("extended", "NVDA"), false);
assert.strictEqual(getInstrument("binance", "TSLA").maxLeverage, 5);
assert(listInstruments("binance").length > listInstruments("hyperliquid").length);
assert.strictEqual(getInstrumentGroups("binance").length, 2);

console.log("instrument catalog tests passed");
