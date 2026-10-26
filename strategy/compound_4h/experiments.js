"use strict";
// Research only. This registry is never selected by the production runtime or shared Paper book.
const C=require("./config"),E=require("./execution"),S=require("./signal"),R=require("./review");
const ENTRIES=["BASELINE","EARLY_ZONE","CONFIRMED_RETEST"],EXITS=["FULL_PLAN_R","ACTUAL_STAGE_R","STRUCTURE_TRAIL"];
const REGISTRY=Object.freeze(ENTRIES.flatMap(entry=>EXITS.flatMap(exit=>E.MATCHING.map(matching=>Object.freeze({entry,exit,matching})))));
function evaluate(input,experiment){
 if(!REGISTRY.some(v=>Object.keys(v).every(k=>v[k]===experiment[k])))throw Error("未冻结的研究实验");
 let r=input.baseSignal||S.analyze(input),blockers=[r.primaryBlocker,...(r.secondaryBlockers||[])].filter(Boolean);
 if(experiment.entry==="EARLY_ZONE"&&r.reversalZone){blockers=blockers.filter(v=>!v.includes("等待1H已收盘拒绝确认"));}
 if(experiment.entry==="CONFIRMED_RETEST"&&r.reversalZone){const s=r.candidateDirection==="long"?1:-1;if(s*(r.confirmationClosePrice-(s>0?r.reversalZone.high:r.reversalZone.low))<=0)blockers.push("1H确认后尚未离开区域，等待离开后再回踩");}
 if(r.reversalZone)r={...r,decision:blockers.length?"WAIT":"READY",primaryBlocker:blockers[0]||null,secondaryBlockers:blockers.slice(1)};
 if(experiment.matching==="DELAYED_STRESS"&&r.costs)r={...r,costs:{...r.costs,entryFeeRate:r.costs.entryFeeRate*2,exitFeeRate:r.costs.exitFeeRate*2,stopSlippageRate:r.costs.stopSlippageRate*2,fundingRate:r.costs.fundingRate*2}};
 const scope=E.researchScope(C.normalize(input.config),input.account,experiment);return{...R.decorate({...r,...scope,candidateId:null}),sampleType:"historical_backtest",research:experiment};
}
module.exports={ENTRIES,EXITS,REGISTRY,evaluate};
