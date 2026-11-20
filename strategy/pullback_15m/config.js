"use strict";

const {createHash}=require("node:crypto");
const {valid:validLeverage}=require("../../market_leverage");
const ID="pullback_15m_v1", REVISION="PULLBACK_15M_V1", BAR=15*60000;
const label="短线顺势回踩";
const defaults=Object.freeze({riskPerTrade:.003,direction:"both",breakoutBars:20,setupBars:12,maxHoldBars:16,minNetR:1.5,leverage:1});

function normalize(input={}) {
 if (!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!Object.hasOwn(defaults,key))) {
  throw Error("顺势回踩参数含不支持的字段");
 }
 const c={...defaults,...input};
 if(!validLeverage(c.leverage))throw Error("杠杆须为大于或等于 1 的整数");
 const ranges=[["riskPerTrade",.001,.005],["breakoutBars",12,40,true],
  ["setupBars",6,20,true],["maxHoldBars",4,32,true],["minNetR",1.5,3]];
 for (const [key,min,max,integer] of ranges) {
  if (!Number.isFinite(c[key])||c[key]<min||c[key]>max||integer&&!Number.isInteger(c[key])) throw Error("参数超出范围："+key);
 }
 if (!["both","long","short"].includes(c.direction)) throw Error("方向无效");
 return c;
}
function assertAccount(a) {
 if (a?.strategyType!==ID||a.tradeMode!=="simulation"||a.simulationEnabled!==true||
     a.platform!=="binance"||a.quoteAsset!=="USDT"||!["ETH","BTC"].includes(a.symbol)||
     !Number.isFinite(a.simulationBalance)||a.simulationBalance<100||!validLeverage(a.leverage??1)||
     ["address","privateKey","apiKey","apiSecret","starkPrivateKey","publicKey","vault"].some(key=>a[key])) {
  throw Error("PAPER_ONLY：短线回踩仅支持无交易凭据的 Binance BTC/ETH USDT 永续模拟账户");
 }
}
function hash(c) {
 return createHash("sha256").update(JSON.stringify(normalize(c))).digest("hex");
}
function identity(a) {
 assertAccount(a);
 return JSON.stringify([a.id,a.platform,a.symbol,a.quoteAsset,a.simulationBalance,ID]);
}

module.exports={ID,REVISION,BAR,interval:"15m",label,defaults,normalize,assertAccount,hash,identity,
 route:"pullback",configKey:"pullbackConfig",ledgerName:"pullback_15m_paper.json",
 waitCode:"WAIT_TREND",waitReason:"等待新的 15 分钟收盘信号",targetReason:"swing_target",maxSignalDelay:90000,
 startMessage:"短线模拟监控已启动，等待下一根 15 分钟收盘"};
