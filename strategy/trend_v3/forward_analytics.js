"use strict";
const { matches } = require("./scope"), { riskUnit } = require("./quality_audit");
const MODES=["breakout_entry","pullback_entry","continuation_entry"];
const SUBTYPES=["EMA20_SHALLOW","EMA50_DEEP","BREAKOUT_RETEST","STRUCTURE_RETEST","MIXED_RETEST","UNKNOWN"];
const finite = x => x !== null && x !== undefined && Number.isFinite(Number(x));
const mean = values => { const a=values.filter(finite).map(Number); return a.length?a.reduce((s,v)=>s+v,0)/a.length:null; };
function distribution(values) { const a=values.filter(finite).map(Number).sort((a,b)=>a-b); return {samples:a.length,average:mean(a),median:a.length?a[Math.floor((a.length-1)*.5)]:null,p90:a.length?a[Math.ceil((a.length-1)*.9)]:null}; }
function enrich(v) {
  const unit=riskUnit(v), mfe=unit && finite(v.maximumFavorableExcursion)?Number(v.maximumFavorableExcursion)/unit:null, mae=unit && finite(v.maximumAdverseExcursion)?Number(v.maximumAdverseExcursion)/unit:null;
  const fee=finite(v.tradingFee)?Number(v.tradingFee):finite(v.entryFee)&&finite(v.exitFee)?Number(v.entryFee)+Number(v.exitFee):null;
  const funding=finite(v.fundingPnl)?Number(v.fundingPnl):0, slip=finite(v.slippageCost)?Number(v.slippageCost):0;
  const totalCostU=fee===null?null:fee+slip-funding, risk=Number(v.initialEffectiveRiskU);
  const netR=finite(v.netR??v.rMultiple)?Number(v.netR??v.rMultiple):null;
  const priceRisk=Math.abs(Number(v.entryPrice)-Number(v.initialStopLossPrice));
  const reportedMFE=finite(v.MFE_R)?Number(v.MFE_R):priceRisk>0&&finite(v.maximumFavorableExcursion)?Number(v.maximumFavorableExcursion)/priceRisk:null;
  const reportedMAE=finite(v.MAE_R)?Number(v.MAE_R):priceRisk>0&&finite(v.maximumAdverseExcursion)?Number(v.maximumAdverseExcursion)/priceRisk:null;
  return {...v, funding:funding, totalCostU, costR:totalCostU!==null&&risk>0?totalCostU/risk:null,
    feeToGrossMoveRatio:fee!==null&&Math.abs(Number(v.grossPnl))>0?fee/Math.abs(Number(v.grossPnl)):null,
    MFE_R:reportedMFE,MAE_R:reportedMAE,effectiveMFE_R:mfe,effectiveMAE_R:mae,exitCaptureRatio:Number(v.netPnl??v.pnl)>0&&reportedMFE>0&&netR!==null?netR/Math.max(reportedMFE,Number.EPSILON):null,effectiveExitCaptureRatio:Number(v.netPnl??v.pnl)>0&&mfe>0&&netR!==null?netR/mfe:null,
    entryLocalTime:finite(v.entryTime)?new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(Number(v.entryTime))):null,
    entryLocalTimezone:"Asia/Shanghai",
    weekendUTC:finite(v.entryTime)?[0,6].includes(new Date(Number(v.entryTime)).getUTCDay()):null};
}
function quality(rows,summarize) {
  const hard=rows.filter(v=>v.closeReason==="hard_sl"), knownHard=hard.filter(v=>finite(v.MFE_R)), known=rows.filter(v=>finite(v.MFE_R));
  const winners=rows.filter(v=>Number(v.netPnl??v.pnl)>0&&v.MFE_R>0);
  const stopRebound={},entryWindows={};
  for(const n of [8,16,32]) {const mature=hard.filter(v=>finite(v[`PostStopMFE_R_${n}`]));stopRebound[n]={mature:mature.length,count:mature.filter(v=>v[`PostStopMFE_R_${n}`]>=1.5).length,rate:mature.length?mature.filter(v=>v[`PostStopMFE_R_${n}`]>=1.5).length/mature.length:null,classifications:Object.fromEntries(["STOP_CORRECT","STOP_TOO_TIGHT","ENTRY_WRONG","AMBIGUOUS"].map(k=>[k,mature.filter(v=>v[`PostStopClassification_${n}`]===k).length]))};}
  for(const n of [4,8,16])entryWindows[n]={mfe:distribution(rows.map(v=>v[`EntryMFE_R_${n}`])),mae:distribution(rows.map(v=>v[`EntryMAE_R_${n}`]))};
  return {hardStopCount:hard.length,hardStopRate:rows.length?hard.length/rows.length:null,avgHardStopR:mean(hard.map(v=>v.netR??v.rMultiple)),
    neverWorkedSamples:knownHard.length,neverWorkedRate:knownHard.length?knownHard.filter(v=>v.MFE_R<.5).length/knownHard.length:null,
    workedThenFailedSamples:known.length,workedThenFailedRate:known.length?known.filter(v=>v.MFE_R>=1&&(Number(v.netR??v.rMultiple)<=0||v.closeReason==="hard_sl")).length/known.length:null,
    stopRebound,entryWindows,avgMFE_R:mean(rows.map(v=>v.MFE_R)),avgMAE_R:mean(rows.map(v=>v.MAE_R)),
    avgWinnerMFE:mean(winners.map(v=>v.MFE_R)),avgRealizedWinnerR:mean(winners.map(v=>v.netR??v.rMultiple)),avgCaptureRatio:mean(winners.map(v=>v.exitCaptureRatio)),avgEffectiveCaptureRatio:mean(winners.map(v=>v.effectiveExitCaptureRatio)),
    captureByExit:Object.fromEntries(["trend_tp","trend_reversal","manual_close","hard_sl"].map(k=>{const a=winners.filter(v=>v.closeReason===k);return[k,{samples:a.length,mfe:mean(a.map(v=>v.MFE_R)),realized:mean(a.map(v=>v.netR??v.rMultiple)),capture:mean(a.map(v=>v.exitCaptureRatio)),effectiveCapture:mean(a.map(v=>v.effectiveExitCaptureRatio))}];})),
    cost:distribution(rows.map(v=>v.costR)),costBands:Object.fromEntries([.1,.15,.2].map(k=>[k,summarize(rows.filter(v=>v.costR!==null&&v.costR>k))]))};
}
function funnel(signals,rows) {
 const result={};
 for(const mode of MODES){const stages=["Candidate","Triggered","StopPassed","ScorePassed","CostPassed","PotentialRPassed","RiskPassed","ExecutionReady","Submitted","Filled"],a=signals.map(s=>({s,m:s.modeAudit?.[mode]})).filter(x=>x.m);const blockers={};
 for(const {s,m} of a){const reason=m.blocker||s.executionBlocker;if(reason)blockers[reason]=(blockers[reason]||0)+1;}
 const counts=Object.fromEntries(stages.map(k=>[k,a.filter(({s,m})=>k==="Filled"?s.orderFilled&&s.entryMode===mode:k==="Submitted"?(s.orderSubmitted||s.orderFilled)&&s.entryMode===mode:m[k]===true).length]));
 result[mode]={...counts,Won:rows.filter(v=>v.entryMode===mode&&Number(v.netPnl??v.pnl)>0).length,Lost:rows.filter(v=>v.entryMode===mode&&Number(v.netPnl??v.pnl)<0).length,blockerRanking:Object.entries(blockers).sort((a,b)=>b[1]-a[1]).slice(0,10),coverage:{evaluated:a.length,from:a[0]?.s.time??null,to:a.at(-1)?.s.time??null},missingTelemetry:signals.filter(s=>!s.modeAudit).length};
 }return result;
}
function buildForwardAnalytics(history,signals,scope,summarize){
 const rows=history.filter(v=>matches(v,scope)).map(enrich),journal=signals.filter(s=>matches(s,scope));
 const subtypes=Object.fromEntries(SUBTYPES.map(k=>{const a=rows.filter(v=>(v.pullbackSubtype||"UNKNOWN")===k&&v.entryMode==="pullback_entry"),c=journal.flatMap(s=>(s.entryCandidates||[]).filter(c=>c.type==="pullback_entry"&&(c.pullbackSubtype||"UNKNOWN")===k));return[k,{...summarize(a),...quality(a,summarize),Candidates:c.length,Triggered:c.filter(c=>c.triggered).length,Filled:journal.filter(s=>s.orderFilled&&s.entryMode==="pullback_entry"&&(s.pullbackSubtype||"UNKNOWN")===k).length}];}));
 const shadow=(name)=>{const a=journal.filter(s=>s.shadows?.[name]),declined=rows.filter(v=>journal.some(s=>s.time===v.signalTime&&s.shadows?.[name]?.allowed===false));return{postHocOnly:true,samples:a.length,allowed:a.filter(s=>s.shadows[name].allowed).length,realizedMatched:declined.length,avoidedLoser:declined.filter(v=>Number(v.netPnl??v.pnl)<0).length,missedWinner:declined.filter(v=>Number(v.netPnl??v.pnl)>0).length,excludedTradeStats:summarize(declined),retainedRealizedStats:summarize(rows.filter(v=>!declined.includes(v))),counterfactualPortfolioPnl:null,warning:"仅已成交配对；不是独立Shadow组合回测，未成交机会没有虚构收益"};};
 return {scope,quality:quality(rows,summarize),subtypes,modeFunnel:funnel(journal,rows),weekday:{...summarize(rows.filter(v=>v.weekendUTC===false)),...quality(rows.filter(v=>v.weekendUTC===false),summarize)},weekend:{...summarize(rows.filter(v=>v.weekendUTC===true)),...quality(rows.filter(v=>v.weekendUTC===true),summarize)},shadows:{V3_COST_TIGHT:shadow("V3_COST_TIGHT"),weekend_filter_shadow:shadow("weekend_filter_shadow")},basis:{samples:journal.filter(s=>finite(s.basisBps)).length,bps:distribution(journal.map(s=>s.basisBps)),atr:distribution(journal.map(s=>s.basisAtr)),diagnosticOnly:true},missingFields:rows.filter(v=>!v.pullbackSubtype||!v.signalMarketDataSource).length};
}
module.exports={buildForwardAnalytics,enrich,distribution};
