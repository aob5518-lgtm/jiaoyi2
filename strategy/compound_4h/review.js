"use strict";
const crypto=require("crypto");
const GATES=["dailyEma","dailySlope","swing","zone","atr","depth","confirmation","momentum","grade","netRR","rules","portfolio","paper"];
function decorate(r){
 const c=r.conditions||{},rows=GATES.map(code=>({code,passed:Object.hasOwn(c,code)?c[code]:null}));
 return{...r,signalDecision:r.decision,planDecision:"NOT_EVALUATED",executionDecision:"NOT_EVALUATED",failureStage:r.decision==="READY"?null:"SIGNAL",reasonCode:r.reasonCode||(r.decision==="READY"?"SIGNAL_READY":"SIGNAL_FILTER"),gates:rows,candidateId:r.candidateId||crypto.createHash("sha256").update([r.accountId,r.configHash,r.fourHourOpenTime??r.dataTimes?.fourHour,r.candidateDirection,r.fourHourStructure?.time??"none"].join(":")).digest("hex").slice(0,24)};
}
function summarize(diagnostics,cycles,from=0,to=Infinity){
 const unique=new Map();for(const r of diagnostics)if((r.evaluatedAt??r.timestamp)>=from&&(r.evaluatedAt??r.timestamp)<=to){const key=r.candidateId||r.timestamp+":"+r.candidateDirection,old=unique.get(key);unique.set(key,old?{...r,signalDecision:old.signalDecision==="READY"?"READY":r.signalDecision,planDecision:old.planDecision==="CREATED"?"CREATED":r.planDecision,executionDecision:old.executionDecision==="ORDER_PENDING"?"ORDER_PENDING":r.executionDecision,gates:GATES.map(code=>{const a=(old.gates||[]).find(g=>g.code===code)?.passed,b=(r.gates||[]).find(g=>g.code===code)?.passed;return{code,passed:a===true||b===true?true:a===false||b===false?false:null};})}:r);}
 const rows=[...unique.values()],trades=cycles.filter(r=>(r.createdAt??r.exitTime)>=from&&(r.createdAt??r.exitTime)<=to),blockers={};
 for(const r of rows){const reason=r.executionBlocker||r.planBlocker||r.primaryBlocker;if(reason&&r.executionDecision!=="ORDER_PENDING")blockers[reason]=(blockers[reason]||0)+1;}
 return{candidates:rows.length,gates:Object.fromEntries(GATES.map(code=>{const vs=rows.map(v=>(v.gates||[]).find(g=>g.code===code)?.passed);return[code,{candidates:rows.length,passed:vs.filter(v=>v===true).length,blocked:vs.filter(v=>v===false).length,unknown:vs.filter(v=>v!==true&&v!==false).length}];})),primaryBlockers:blockers,signalsReady:rows.filter(v=>v.signalDecision==="READY").length,plans:rows.filter(v=>v.planDecision==="CREATED").length,ordersSubmitted:rows.filter(v=>v.executionDecision==="ORDER_PENDING").length,filled:trades.filter(v=>v.filledQty>0).length,completed:trades.filter(v=>v.filledQty>0&&v.phase==="CYCLE_CLOSED").length};
}
// Requires every hourly slot, not just an endpoint. Never feeds the result into the signal function.
function postHoc(candidate,candles,now,hours=24){
 const start=candidate.evaluatedAt??candidate.timestamp,end=start+hours*3600000;
 if(now<end)return{mature:false,reason:"后验窗口尚未成熟"};
 const aligned=Math.ceil(start/3600000)*3600000;let lo=0,hi=candles.length;while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].time<aligned)lo=mid+1;else hi=mid;}const rows=candles.slice(lo,lo+hours);
 if(rows.length!==hours||rows.some((v,n)=>v.time!==aligned+n*3600000)||now<aligned+hours*3600000)return{mature:false,reason:"完整连续后验窗口不足"};
 const entry=candidate.plannedEntryPrice,stop=candidate.plannedStopPrice,s=candidate.candidateDirection==="long"?1:candidate.candidateDirection==="short"?-1:0;
 if(!(entry>0&&stop>0&&s&&s*(entry-stop)>0))return{mature:true,comparable:false,reason:"当时未形成合法计划，不能伪造潜在R"};
 const risk=Math.abs(entry-stop),mfe=Math.max(...rows.map(v=>s>0?v.high-entry:entry-v.low)),mae=Math.max(...rows.map(v=>s>0?entry-v.low:v.high-entry)),cost=entry*((candidate.costs?.entryFeeRate||0)+(candidate.costs?.exitFeeRate||0)+(candidate.costs?.fundingRate||0));let firstStop=null,firstTarget=null;
 for(const v of rows){if(firstStop===null&&(s>0?v.low<=stop:v.high>=stop))firstStop=v.time;if(firstTarget===null&&(s>0?v.high>=entry+risk*1.5:v.low<=entry-risk*1.5))firstTarget=v.time;}
 return{mature:true,postHocOnly:true,windowStart:aligned,windowEnd:aligned+hours*3600000,MFE:Math.max(0,mfe),MAE:Math.max(0,mae),potentialNetR:(mfe-cost)/(risk+cost),effectiveReversal:firstTarget!==null&&(firstStop===null||firstTarget<firstStop),stopFirst:firstStop!==null&&(firstTarget===null||firstStop<=firstTarget),missReason:candidate.executionBlocker||candidate.planBlocker||candidate.primaryBlocker||"UNFILLED"};
}
module.exports={GATES,decorate,summarize,postHoc};
