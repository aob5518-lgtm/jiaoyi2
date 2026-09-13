"use strict";

const assert = require("assert");
const {
  SMART_STRATEGY_DEFAULTS,
  normalizeSmartConfig,
  calculateSmartAddPlan,
  calculateSmartTrailingPrice,
  analyzeSmartStrategy
} = require("../smart_strategy");

function candles({
  count = 260,
  start = 1000,
  drift = 0.18,
  volatility = 0.45,
  direction = 1,
  shock = 0
} = {}) {
  const rows = [];
  let close = start;
  const interval = 15 * 60 * 1000;
  const firstTime = Date.now() - count * interval;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    const wave = Math.sin(index / 5) * volatility * 0.35;
    close = Math.max(1, open + direction * drift + wave);
    const wick = volatility * (0.7 + Math.abs(Math.sin(index * 1.7)));
    rows.push({
      time: firstTime + index * interval,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 1000 + index * 4 + Math.abs(Math.sin(index)) * 300
    });
  }
  if (shock > 0) {
    const target = rows[rows.length - 2];
    target.high += shock;
    target.low -= shock;
    target.close = direction > 0 ? target.high - shock * 0.1 : target.low + shock * 0.1;
  }
  return rows;
}

function analyze(direction, options = {}) {
  const directionValue = direction === "long" ? 1 : -1;
  return analyzeSmartStrategy({
    entryCandles: candles({ direction: directionValue, drift: 0.28, ...options }),
    trendCandles: candles({ direction: directionValue, drift: 0.34, volatility: 0.6 }),
    regimeCandles: candles({ direction: directionValue, drift: 0.42, volatility: 0.8 }),
    marketContext: { fundingRate: 0.0001, basisPct: 0.03 },
    account: {
      smartStrategy: {
        directionMode: "auto",
        entryThreshold: 65
      }
    }
  });
}

const defaults = normalizeSmartConfig({});
assert.strictEqual(defaults.entryThreshold, SMART_STRATEGY_DEFAULTS.entryThreshold);
assert.strictEqual(defaults.maxAdds, 3);
assert.deepStrictEqual(defaults.addMultipliers, [1.3, 1.6, 2]);

const normalized = normalizeSmartConfig({
  smartStrategy: {
    entryThreshold: 999,
    riskPerTradePct: 0,
    maxAdds: 8,
    addMultipliers: "1.2,1.5,1.9",
    weights: { regime: 1, trend: 1, setup: 1, momentum: 1, volume: 1, market: 1 }
  }
});
assert.strictEqual(normalized.entryThreshold, 90);
assert.strictEqual(normalized.riskPerTradePct, 0.1);
assert.strictEqual(normalized.maxAdds, 5);
assert.deepStrictEqual(normalized.addMultipliers, [1.2, 1.5, 1.9]);
assert.strictEqual(
  Number(Object.values(normalized.weights).reduce((sum, value) => sum + value, 0).toFixed(2)),
  100
);

const firstAddPlan = calculateSmartAddPlan({
  equity: 100000,
  leverage: 50,
  maxMarginPct: 15,
  positionValueU: 10000,
  initialNotional: 10000,
  addCount: 0,
  maxAdds: 3,
  addMultipliers: [1.3, 1.6, 2]
});
assert.deepStrictEqual(firstAddPlan, {
  addNotionalU: 13000,
  addMarginU: 260,
  multiplier: 1.3,
  maxNotionalU: 750000
});

const secondAddPlan = calculateSmartAddPlan({
  equity: 100000,
  leverage: 50,
  maxMarginPct: 15,
  positionValueU: 23000,
  initialNotional: 10000,
  addCount: 1,
  maxAdds: 3,
  addMultipliers: [1.3, 1.6, 2]
});
assert.strictEqual(secondAddPlan.addNotionalU, 16000);
assert.strictEqual(secondAddPlan.addMarginU, 320);

const exhaustedAddPlan = calculateSmartAddPlan({
  equity: 100000,
  leverage: 50,
  maxMarginPct: 15,
  positionValueU: 59000,
  initialNotional: 10000,
  addCount: 3,
  maxAdds: 3,
  addMultipliers: [1.3, 1.6, 2]
});
assert.strictEqual(exhaustedAddPlan.addNotionalU, 0);
assert.strictEqual(exhaustedAddPlan.addMarginU, 0);

const longTrailing = calculateSmartTrailingPrice({
  side: "long",
  entryPrice: 100,
  peakPrice: 103,
  atrValue: 2,
  trailingAtr: 2.5,
  takeProfitAtr: 1.5
});
const shortTrailing = calculateSmartTrailingPrice({
  side: "short",
  entryPrice: 100,
  peakPrice: 97,
  atrValue: 2,
  trailingAtr: 2.5,
  takeProfitAtr: 1.5
});
assert.strictEqual(longTrailing, 100.75);
assert.strictEqual(shortTrailing, 99.25);

const longSignal = analyze("long");
assert.strictEqual(longSignal.selectedSide, "long");
assert(longSignal.longScore > longSignal.shortScore);
assert(longSignal.longScore >= 65);
assert.strictEqual(longSignal.riskOff, false);

const shortSignal = analyze("short");
assert.strictEqual(shortSignal.selectedSide, "short");
assert(shortSignal.shortScore > shortSignal.longScore);
assert(shortSignal.shortScore >= 65);
assert.strictEqual(shortSignal.riskOff, false);

const riskOffSignal = analyze("long", { shock: 35 });
assert.strictEqual(riskOffSignal.riskOff, true);
assert.strictEqual(riskOffSignal.entryAllowed, false);

console.log(JSON.stringify({
  ok: true,
  longScore: longSignal.longScore,
  shortScore: shortSignal.shortScore,
  riskOffRegime: riskOffSignal.regime
}, null, 2));
