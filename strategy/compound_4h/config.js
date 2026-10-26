"use strict";
const crypto=require("crypto");
const ID="compound_4h_v1",REVISION="COMPOUND_4H_V1_20261026_REVIEW",EXPERIMENT="COMPOUND_ETH_REVIEW_20261026_A";
const DEFAULTS=Object.freeze({initialEquity:10000,riskPerCycle:.005,layerNotionalPct:.01,maxAdds:3,leverage:1,gradeA:82,gradeB:74,atrPeriod:14,zoneAtr:.6,stopBufferAtr:.5,layerSpacingAtr:.25,minimumNetRR:1.5,orderTtlBars:3,cooldownBars:1,maxDailyLossRatio:.02,maxConsecutiveLosses:3,stopSlippageBps:5,fundingReserveRate:.0001,fillFraction:.5,takeProfitMode:"R_MULTIPLE",compoundMode:"FULL_EQUITY",partialProfitRatio:.5,exitVariant:"PARTIAL_TRAIL",weights:{daily:20,structure:25,momentum:15,confirmation:15,space:15,quality:10}});
function normalize(raw={}){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("4H 参数必须为对象");
 const c=Object.fromEntries(Object.keys(DEFAULTS).map(k=>[k,raw[k]??DEFAULTS[k]]));
 const bounds={initialEquity:[100,10000000],riskPerCycle:[.0001,.005],layerNotionalPct:[.0001,.01],maxAdds:[0,3],leverage:[1,1],gradeA:[82,100],gradeB:[74,99],atrPeriod:[7,50],zoneAtr:[.25,2],stopBufferAtr:[.25,2],layerSpacingAtr:[.1,1],minimumNetRR:[1,10],orderTtlBars:[1,12],cooldownBars:[1,12],maxDailyLossRatio:[.001,.02],maxConsecutiveLosses:[1,3],stopSlippageBps:[1,100],fundingReserveRate:[0,.01],fillFraction:[.1,.5],partialProfitRatio:[0,1]};
 for(const [key,[lo,hi]] of Object.entries(bounds)){c[key]=Number(c[key]);if(!Number.isFinite(c[key])||c[key]<lo||c[key]>hi)throw Error("4H 参数越界："+key);}
 for(const key of ["maxAdds","atrPeriod","orderTtlBars","cooldownBars","maxConsecutiveLosses"])if(!Number.isInteger(c[key]))throw Error("4H 参数须为整数："+key);
 if(c.gradeB>=c.gradeA)throw Error("4H 等级阈值冲突");
 if(c.takeProfitMode!=="R_MULTIPLE")throw Error("ROI_PERCENT 为预留接口，V1 不开放，避免杠杆ROI歧义");
 if(!["FULL_EQUITY","FIXED_BASE","PARTIAL_PROFIT"].includes(c.compoundMode))throw Error("复利模式无效");
 if(!["PARTIAL_TRAIL","FIXED_TARGET","TRAIL_ONLY"].includes(c.exitVariant))throw Error("退出对照模式无效");
 c.weights={...DEFAULTS.weights,...(raw.weights||{})};if(Object.keys(c.weights).some(k=>!Object.hasOwn(DEFAULTS.weights,k))||Object.values(c.weights).some(v=>!Number.isFinite(v)||v<=0)||Math.abs(Object.values(c.weights).reduce((a,b)=>a+b,0)-100)>1e-8)throw Error("评分权重必须为正且合计100");
 return{...c,strategyId:ID,strategyVersion:ID,revision:REVISION,strategyRevision:REVISION,experimentId:EXPERIMENT,allowLive:false,counterTrendEnabled:false,entryTimeframe:"4h",higherTimeframe:"1d",confirmationTimeframe:"1h"};
}
function scope(config,account={}){return{strategyId:ID,strategyVersion:ID,revision:REVISION,strategyRevision:REVISION,experimentId:EXPERIMENT,configHash:crypto.createHash("sha256").update(JSON.stringify({config:normalize(config),symbol:account.symbol||"ETH",platform:account.platform||null,executionPolicy:{allowReferenceSignals:account.compoundExecutionPolicy?.allowReferenceSignals===true,maxBasisBps:Number(account.compoundExecutionPolicy?.maxBasisBps??25)}})).digest("hex")};}
function baseEquity(book,c){return c.compoundMode==="FIXED_BASE"?Math.min(book.initialEquity,book.equity):c.compoundMode==="PARTIAL_PROFIT"?book.initialEquity+Math.min(0,book.equity-book.initialEquity)+Math.max(0,book.equity-book.initialEquity)*c.partialProfitRatio:book.equity;}
module.exports={ID,REVISION,EXPERIMENT,DEFAULTS,normalize,scope,baseEquity};
