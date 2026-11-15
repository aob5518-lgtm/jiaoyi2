"use strict";
const {createHash}=require("node:crypto"), {valid}=require("../../market_leverage");
const ID="chart_swing_1h_v1",REVISION="CHART_SWING_1H_RESEARCH_V1",BAR=3600000;
const label="图示波段 1H";
// Frozen before replay. The screenshot period is a seen research sample, never an OOS claim.
const defaults=Object.freeze({riskPerTrade:.005,leverage:1,direction:"both",channelBars:20,
 confirmBars:2,stopAtr:1.5,trailAtr:2.5,maxHoldBars:96});
function normalize(input={}){
 if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)))throw Error("波段参数含不支持的字段");
 const c={...defaults,...input};
 if(!valid(c.leverage))throw Error("杠杆须为大于或等于 1 的整数");
 for(const [k,min,max,int] of [["riskPerTrade",.001,.01],["channelBars",12,60,true],["confirmBars",1,4,true],
  ["stopAtr",1.2,2.5],["trailAtr",1.5,4],["maxHoldBars",12,168,true]]){
  if(!Number.isFinite(c[k])||c[k]<min||c[k]>max||int&&!Number.isInteger(c[k]))throw Error("参数超出范围："+k);
 }
 if(!["long","short","both"].includes(c.direction))throw Error("方向无效");
 return c;
}
function assertAccount(a){
 if(a?.strategyType!==ID||a.tradeMode!=="simulation"||a.simulationEnabled!==true||a.platform!=="binance"||
  a.quoteAsset!=="USDT"||!["ETH","BTC"].includes(a.symbol)||!Number.isFinite(a.simulationBalance)||a.simulationBalance<100||
  !valid(a.leverage??1)||["address","privateKey","apiKey","apiSecret","starkPrivateKey","publicKey","vault"].some(k=>a[k])){
  throw Error("PAPER_ONLY：图示波段仅支持无交易凭据的 Binance BTC/ETH USDT 永续模拟账户");
 }
}
const hash=c=>createHash("sha256").update(JSON.stringify(normalize(c))).digest("hex");
function identity(a){assertAccount(a);return JSON.stringify([a.id,a.platform,a.symbol,a.quoteAsset,a.simulationBalance,ID]);}
module.exports={ID,REVISION,BAR,label,defaults,normalize,assertAccount,hash,identity,interval:"1h",
 route:"swing",configKey:"chartSwingConfig",ledgerName:"chart_swing_1h_paper.json",stopOnly:true,
 ...require("./position"),waitCode:"WAIT_SWING",waitReason:"等待新的 1 小时收盘与波段确认",maxSignalDelay:90000,
 startMessage:"波段模拟监控已启动，等待下一根 1 小时收盘；不追溯补开历史信号"};
