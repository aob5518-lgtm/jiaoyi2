"use strict";

const crypto = require("node:crypto");
const {BAR} = require("../turtle_4h/config");
const {valid:validLeverage}=require("../../market_leverage");
const ID = "reversal_4h_v1";
const REVISION = "REVERSAL_4H_V1";
const defaults = Object.freeze({riskPerTrade:.005, direction:"both", bandBars:20, bandWidth:2,
 maxAdx:25, minNetR:1.4, maxHoldBars:12,leverage:1});

function normalize(input = {}) {
 if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) {
  throw Error("反转参数含有不支持的字段");
 }
 const config = {...defaults, ...input};
 if (!validLeverage(config.leverage)) throw Error("杠杆须为大于或等于 1 的整数");
 for (const [key, min, max, integer] of [
  ["riskPerTrade", .001, .01], ["bandBars", 15, 50, true], ["bandWidth", 1.5, 3],
  ["maxAdx", 15, 30], ["minNetR", 1.2, 3], ["maxHoldBars", 4, 24, true]
 ]) {
  const value = config[key];
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
   throw Error("参数超出范围：" + key);
  }
 }
 if (!["both", "long", "short"].includes(config.direction)) throw Error("方向无效");
 return config;
}

function assertAccount(account) {
 if (account?.strategyType !== ID || account.tradeMode !== "simulation" ||
     account.simulationEnabled !== true || account.platform !== "binance" ||
     account.quoteAsset !== "USDT" || !["ETH", "BTC"].includes(account.symbol) ||
     !Number.isFinite(account.simulationBalance) || account.simulationBalance < 100 ||
     !validLeverage(account.leverage??1) || ["address","privateKey","apiKey","apiSecret","starkPrivateKey","publicKey","vault"].some(key => account[key])) {
  throw Error("PAPER_ONLY：仅支持无交易凭据的 Binance ETH/BTC USDT 永续独立模拟账户");
 }
}

function hash(config) {
 return crypto.createHash("sha256").update(JSON.stringify(normalize(config))).digest("hex");
}
function identity(account) {
 assertAccount(account);
 return JSON.stringify([account.id, account.platform, account.symbol, account.quoteAsset, account.simulationBalance, ID]);
}

module.exports = {ID, REVISION, BAR, defaults, normalize, assertAccount, hash, identity,
 configKey:"reversalConfig", ledgerName:"reversal_4h_paper.json", route:"reversal",
 label:"找底摸顶 4H", waitCode:"WAIT_REVERSAL", waitReason:"等待下一根已收盘 4H 反转确认"};
