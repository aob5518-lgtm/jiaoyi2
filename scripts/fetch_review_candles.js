"use strict";
// Read-only primary-source data collection. Output contains market data only.
(async () => {
  const end = process.argv[3] ? Date.parse(process.argv[3]) : Date.now();
  const start = process.argv[2] ? Date.parse(process.argv[2]) : end - 10 * 24 * 3600000;
  const symbol = process.argv[4] || "ETHUSDT";
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw Error("Invalid USD-M symbol");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Error("Usage: node scripts/fetch_review_candles.js [from ISO] [to ISO]");
  const result = { source: `Binance USD-M ${symbol}`, symbol, start, end, fetchedAt: Date.now(), candles: {} };
  for (const [interval, ms] of [["15m", 900000], ["1h", 3600000], ["4h", 14400000]]) {
    let cursor = start - ms * 260;
    const rows = [];
    while (cursor < end) {
      const url = new URL("https://fapi.binance.com/fapi/v1/klines");
      for (const [key, value] of Object.entries({ symbol, interval, startTime: cursor, endTime: end - 1, limit: 1500 })) url.searchParams.set(key, value);
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const page = await response.json();
      if (!response.ok || !Array.isArray(page)) throw Error(JSON.stringify(page));
      if (!page.length) break;
      rows.push(...page.map(x => ({ time: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] })));
      cursor = page.at(-1)[0] + ms;
    }
    result.candles[interval] = rows.filter(x => x.time + ms <= end);
  }
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
