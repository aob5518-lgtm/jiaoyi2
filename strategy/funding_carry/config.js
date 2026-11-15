"use strict";

const {createHash} = require("node:crypto");
const ID = "funding_carry_v1";
const route = "carry";
const REVISION = "CARRY_V1";
const configKey = "carryConfig";
const label = "资金费率对冲";
const startMessage = "资金费率对冲模拟已启动，等待双边盘口与净收益条件";
const defaults = Object.freeze({allocationPct:.20, maxHoldHours:72, minEdgeBps:10});
const bounds = {allocationPct:[.05,.30], maxHoldHours:[24,168], minEdgeBps:[5,100]};

function normalize(input = {}) {
 if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key=>!Object.hasOwn(defaults,key))) {
  throw Error("对冲参数含不支持的字段");
 }
 const config = {...defaults,...input};
 for (const [key,[min,max]] of Object.entries(bounds)) {
  if (!Number.isFinite(config[key]) || config[key]<min || config[key]>max || key==="maxHoldHours"&&!Number.isInteger(config[key])) {
   throw Error("参数超出范围："+key);
  }
 }
 return config;
}
function assertAccount(a) {
 if (a?.strategyType!==ID || a.tradeMode!=="simulation" || a.simulationEnabled!==true ||
     a.platform!=="binance" || a.quoteAsset!=="USDT" || !["BTC","ETH"].includes(a.symbol) ||
     !Number.isFinite(a.simulationBalance) || a.simulationBalance<100 || a.leverage!==1 ||
     ["address","privateKey","apiKey","apiSecret","starkPrivateKey","publicKey","vault"].some(key=>a[key])) {
  throw Error("PAPER_ONLY：仅支持无交易凭据的 Binance BTC/ETH USDT 独立模拟账户");
 }
}
function hash(config) {
 return createHash("sha256").update(JSON.stringify(normalize(config))).digest("hex");
}
function identity(a) {
 assertAccount(a);
 return JSON.stringify([a.id,a.symbol,a.platform,a.quoteAsset,a.simulationBalance,ID]);
}
module.exports = {ID,route,REVISION,configKey,label,startMessage,defaults,normalize,hash,assertAccount,identity};
