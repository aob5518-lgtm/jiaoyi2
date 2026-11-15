(function (root, factory) {
 "use strict";
 const preview = factory();
 if (typeof module === "object" && module.exports) module.exports = preview;
 else root.JustSettingsPreview = preview;
})(typeof window === "object" ? window : globalThis, function () {
 "use strict";
 // Display-only examples. Never imported by the runtime or sent as execution plans.
 function build(settings, referencePrice) {
  const c = settings || {};
  const finite = n => typeof n === "number" && Number.isFinite(n);
  const valid = ["long", "short"].includes(c.side) &&
   finite(c.leverage) && Number.isInteger(c.leverage) && c.leverage >= 1 && c.leverage <= 10 &&
   [c.baseAmount, c.addAmount].every(n => finite(n) && n >= 1 && n <= 1e8) &&
   finite(c.maxAdds) && Number.isInteger(c.maxAdds) && c.maxAdds >= 0 && c.maxAdds <= 10 &&
   [c.addTrigger, c.takeProfit].every(n => finite(n) && n >= .0001 && n <= .99);
  if (!valid) return {valid: false, rows: []};
  const notional = c.baseAmount + c.addAmount * c.maxAdds;
  const result = {valid: true, notional, margin: notional / c.leverage,
   firstMargin: c.baseAmount / c.leverage, addMargin: c.maxAdds ? c.addAmount / c.leverage : 0,
   orderCount: 1 + c.maxAdds, rows: [], reference: null};
  if (!finite(referencePrice) || referencePrice <= 0) return result;
  result.reference = referencePrice;
  const sign = c.side === "long" ? 1 : -1;
  let price = referencePrice;
  for (let index = 0; index <= c.maxAdds; index++) {
   result.rows.push({index, price, amount: index ? c.addAmount : c.baseAmount});
   price *= 1 - sign * c.addTrigger;
  }
  result.referenceTarget = referencePrice / (1 - sign * c.takeProfit / c.leverage);
  return result;
 }
 return {build};
});
