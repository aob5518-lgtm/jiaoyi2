"use strict";
const crypto = require("crypto");
const ID = "turtle_4h_v1", REVISION = "TURTLE_4H_PAPER_V1_20261115", BAR = 4 * 3600000;
// Frozen before research. This is a closed-4H-bar adaptation, not the original daily Turtle system.
const defaults = Object.freeze({entryBars:55,exitBars:20,atrPeriod:20,stopAtr:2,riskPerTrade:0.005,leverage:1,direction:"both"});
function normalize(input = {}) {
 if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k=>!Object.hasOwn(defaults,k))) throw Error("参数字段不支持；交易模式、身份和资金不能从参数接口修改");
 const c={...defaults,...input};
 for (const [k,min,max,int] of [["entryBars",20,200,true],["exitBars",5,100,true],["atrPeriod",10,100,true],["stopAtr",1,5,false],["riskPerTrade",.001,.01,false],["leverage",1,3,true]]) {
  if (typeof c[k]!=="number" || !Number.isFinite(c[k]) || c[k]<min || c[k]>max || int&&!Number.isInteger(c[k])) throw Error("参数超出范围："+k);
 }
 if(c.exitBars>=c.entryBars||!["both","long","short"].includes(c.direction))throw Error("退出通道必须短于入场通道，方向须为双向、做多或做空");
 return c;
}
function hash(c){return crypto.createHash("sha256").update(JSON.stringify(normalize(c))).digest("hex");}
function assertAccount(a) {
 if(a?.strategyType!==ID||a.tradeMode!=="simulation"||a.simulationEnabled!==true||a.platform!=="binance"||a.quoteAsset!=="USDT"||!["ETH","BTC"].includes(a.symbol)||!Number.isFinite(a.simulationBalance)||!(a.simulationBalance>=100))throw Error("PAPER_ONLY：仅支持独立 Binance ETH/BTC USDT 永续模拟账户");
 if(["privateKey","apiKey","apiSecret","starkPrivateKey"].some(k=>a[k]))throw Error("新策略研究账户不得配置交易密钥");
}
function identity(a){assertAccount(a);return JSON.stringify([a.id,a.platform,a.symbol,a.quoteAsset,a.simulationBalance,ID]);}
module.exports={ID,REVISION,BAR,defaults,normalize,hash,assertAccount,identity};
