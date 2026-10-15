"use strict";
const {scopeFor}=require("./scope");
function describePullback(input,direction,config){
 const rows=input.candles||[], previous=rows.slice(-config.pullbackConfirmLookback-1,-1), band=Number(input.atr)*config.pullbackEmaBandAtr;
 const source=[];
 const touch=level=>Number.isFinite(Number(level))&&previous.some(c=>c.low<=Number(level)+band&&c.high>=Number(level)-band);
 // EMA histories are sampled at each candle, never inferred from future EMAs.
 if(input.pullbackTouchSources?.includes("EMA20"))source.push("EMA20");
 if(input.pullbackTouchSources?.includes("EMA50"))source.push("EMA50");
 const breakout=direction==="long"?input.trendContextBreakoutHigh:input.trendContextBreakoutLow;
 const structure=direction==="long"?input.structureLow:input.structureHigh;
 if(touch(breakout))source.push("BREAKOUT");
 if(touch(structure))source.push("STRUCTURE");
 const unique=[...new Set(source)], subtype=unique.length>1?"MIXED_RETEST":({EMA20:"EMA20_SHALLOW",EMA50:"EMA50_DEEP",BREAKOUT:"BREAKOUT_RETEST",STRUCTURE:"STRUCTURE_RETEST"})[unique[0]]||"UNKNOWN";
 return {pullbackSubtype:subtype,pullbackTouchSource:unique};
}
function auditModes(T,account,input){
 const cloned={...account,trendOnlyState:{...account.trendOnlyState,reentryState:{...account.trendOnlyState.reentryState},trendEntryCounts:{...account.trendOnlyState.trendEntryCounts}}};
 const result={};
 for(const mode of input.config.entryModes){
  const config={...input.config,entryModes:[mode]},i={...input,config};
  const signal=T.detectMarketRegime(i.candles,i),candidate=signal.entryCandidates?.find(c=>c.type===mode);
  if(!candidate)continue;
  const plan=candidate.triggered?T.tryOpenTrendOnlyPosition({...cloned,trendOnlyConfig:config},signal,i,config):null;
  const e=plan?.executionEvaluation||{};
  const stages={Candidate:true,Triggered:!!candidate.triggered,StopPassed:candidate.triggered&&candidate.stopAllowed===true,ScorePassed:!!signal.grade,CostPassed:["PASS","CONDITIONAL"].includes(e.cost),PotentialRPassed:e.rewardSpace==="PASS",RiskPassed:e.risk==="PASS",ExecutionReady:!!plan?.allowed};
  let previous=true;for(const key of Object.keys(stages)){stages[key]=previous&&!!stages[key];previous=stages[key];}
  const unmet=Object.entries(candidate.factors||{}).filter(([k,v])=>k==="extended"?v:!v).map(([k])=>k);
  result[mode]={...stages,blocker:plan?.reason||(signal.blockers||[]).join("；")||(!candidate.triggered?`WAIT_SETUP: ${unmet.join(",")}`:""),evaluation:e};
 }
 return result;
}
function buildShadows(T,account,signal,input){
 const config={...input.config,maxPreferredCostR:.1,maxAllowedCostR:.2};
 const shadowAccount={...account,trendOnlyConfig:config,trendOnlyState:{...account.trendOnlyState,reentryState:{...account.trendOnlyState.reentryState}}};
 const s=T.detectMarketRegime(input.candles,{...input,config});
 const p=T.tryOpenTrendOnlyPosition(shadowAccount,s,{...input,config},config);
 const decisionTime=input.decisionTime??input.now??Number(input.signalTime)+(require("../../trend_only").INTERVALS[input.config.entryTimeframe]||900000);
 const weekday=![0,6].includes(new Date(Number(decisionTime)).getUTCDay());
 return {V3_COST_TIGHT:{allowed:!!p.allowed,signalAllowed:s.entryPermission==="allowed",reason:p.reason||"",postHocOnly:true,orderPermission:false},weekend_filter_shadow:{allowed:weekday&&signal.entryPermission==="allowed",reason:weekday?"":"UTC_WEEKEND",postHocOnly:true,orderPermission:false}};
}
function metadata(input){return {...scopeFor(input.config),entryTimeframe:input.config.entryTimeframe,signalMarketDataSource:input.signalMarketDataSource||"unknown",executionVenue:input.executionVenue||"unknown",referenceSymbol:input.referenceSymbol||null,referencePrice:input.referencePrice??null,executionPrice:input.price??null,basisExecutionPrice:input.basisExecutionPrice??null,basisBps:input.basisBps??null,basisAtr:input.basisAtr??null,basisObservedAt:input.basisObservedAt??null,basisThresholdBps:input.config.maxCrossVenueBasisBps,basisThresholdAtr:input.config.maxCrossVenueBasisAtr,basisDiagnosticOnly:true};}
module.exports={describePullback,auditModes,buildShadows,metadata};
