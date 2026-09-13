"use strict";

const MAJOR_CRYPTO = [
  ["BTC", "Bitcoin"],
  ["ETH", "Ethereum"],
  ["SOL", "Solana"],
  ["BNB", "BNB"],
  ["XRP", "XRP"],
  ["DOGE", "Dogecoin"],
  ["ADA", "Cardano"],
  ["AVAX", "Avalanche"],
  ["LINK", "Chainlink"],
  ["SUI", "Sui"],
  ["LTC", "Litecoin"],
  ["BCH", "Bitcoin Cash"],
  ["DOT", "Polkadot"],
  ["NEAR", "NEAR"],
  ["UNI", "Uniswap"],
  ["AAVE", "Aave"]
].map(([symbol, name]) => ({ symbol, name, group: "crypto", maxLeverage: 125 }));

// Binance USD-M TradFi perpetuals. Availability is checked again against
// exchangeInfo before any live order, because Binance can add or delist contracts.
const BINANCE_TRADFI = [
  ["TSLA", "Tesla", 5],
  ["NVDA", "NVIDIA", 10],
  ["AAPL", "Apple", 10],
  ["MSFT", "Microsoft", 10],
  ["AMZN", "Amazon", 10],
  ["META", "Meta", 10],
  ["GOOGL", "Alphabet", 10],
  ["AMD", "AMD", 10],
  ["AVGO", "Broadcom", 10],
  ["INTC", "Intel", 10],
  ["TSM", "TSMC", 10],
  ["MU", "Micron", 10],
  ["SNDK", "SanDisk", 10],
  ["MSTR", "Strategy", 10],
  ["COIN", "Coinbase", 10],
  ["HOOD", "Robinhood", 10],
  ["CRCL", "Circle", 10],
  ["PLTR", "Palantir", 10],
  ["BABA", "Alibaba", 10],
  ["PAYP", "PayPay", 10],
  ["SPCX", "SpaceX", 5],
  ["NBIS", "Nebius", 10]
].map(([symbol, name, maxLeverage]) => ({
  symbol,
  name,
  group: "tradfi",
  maxLeverage
}));

const PLATFORM_CATALOGS = {
  hyperliquid: MAJOR_CRYPTO,
  binance: [...MAJOR_CRYPTO, ...BINANCE_TRADFI],
  extended: MAJOR_CRYPTO.filter(item => ["BTC", "ETH", "SOL", "BNB"].includes(item.symbol))
};

function normalizePlatform(platform) {
  return String(platform || "").trim().toLowerCase();
}

function normalizeInstrumentSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/(USDT|USDC|USD)$/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function listInstruments(platform) {
  const normalized = normalizePlatform(platform);
  return (PLATFORM_CATALOGS[normalized] || []).map(item => ({ ...item }));
}

function getInstrument(platform, symbol) {
  const normalizedSymbol = normalizeInstrumentSymbol(symbol);
  return listInstruments(platform).find(item => item.symbol === normalizedSymbol) || null;
}

function isInstrumentAllowed(platform, symbol) {
  return !!getInstrument(platform, symbol);
}

function getInstrumentGroups(platform) {
  const instruments = listInstruments(platform);
  const crypto = instruments.filter(item => item.group === "crypto");
  const tradfi = instruments.filter(item => item.group === "tradfi");
  const groups = [];
  if (crypto.length) groups.push({ id: "crypto", label: "主流币", items: crypto });
  if (tradfi.length) groups.push({ id: "tradfi", label: "传统金融 · 股票永续", items: tradfi });
  return groups;
}

module.exports = {
  MAJOR_CRYPTO,
  BINANCE_TRADFI,
  normalizeInstrumentSymbol,
  listInstruments,
  getInstrument,
  isInstrumentAllowed,
  getInstrumentGroups
};
