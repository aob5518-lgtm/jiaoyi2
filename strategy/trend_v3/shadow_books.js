"use strict";
const {scopeFor}=require("./scope");
const {snapshot,portfolioRiskKey}=require("./portfolio");
const NAMES=["V3_COST_TIGHT","weekend_filter_shadow"];
// Independent simulated ledgers. This module has no exchange client, submit,
// confirmation token, history writer, or live-order callback.
function tickShadowBooks(T,container,account,input,running=true,portfolioAllowed=()=>true){
 const scope=scopeFor(input.config);
 container.shadowBooks ||= {};
 const cohort = container.shadowBooks[scope.configHash] ||= { scope, books: {} };
 for(const name of NAMES){
  const config={...input.config,experimentId:name,...(name==="V3_COST_TIGHT"?{maxPreferredCostR:.1,maxAllowedCostR:.2}:{})};
  const now=Number(input.decisionTime||Date.now());
  const b=cohort.books[name]||={state:T.initialState(),equity:Number(account.equity),startedAt:now,orderPermission:false,model:"observed quotes, estimated fees/slippage, no funding"};
  b.orderPermission=false;
  if(!(b.equity>0))continue;
  const a={...account,paper:true,confirmLive:false,equity:b.equity,available:b.equity,trendOnlyState:b.state,trendOnlyConfig:config};
  const i={...input,config};
  const signal=T.detectMarketRegime(i.candles,i);T.updateTrendContext(b.state,signal,i);
  const day=new Date(now).toISOString().slice(0,10);
  if(b.state.dailyDate!==day){b.state.dailyDate=day;b.state.dailyLoss=0;b.state.dayStartEquity=b.equity;}
  if(b.state.position){
   const p=b.state.position,price=Number(input.price),action=T.manageTrendOnlyPosition(a,{price},i);
   if(action.reason){
    let exit=price,meta={};
    if(["hard_sl","trend_tp"].includes(action.reason)){
      meta=require("../../trend_runtime").paperStopFill({side:p.side,stopPrice:p.currentStopLossPrice,currentPrice:price,previousPrice:b.previousPrice,slippageBps:config.paperStopSlippageBps});exit=meta.stopExecutionPrice;
    }else exit*=1+(p.side==="long"?-1:1)*Number(account.simulationSlippageBps||0)/10000;
    const v=T.recordClose(a,{qty:p.positionSize,price:exit,...meta},action.reason,now);b.equity+=v.netPnl;
   }
  }else if(running&&!b.state.riskLock&&!b.state.pendingOrder&&!(Number(b.state.pauseUntil)>now)&&Number(b.state.dailyLoss||0)<Number(b.state.dayStartEquity)*config.maxDailyLossRatio&&!(name==="weekend_filter_shadow"&&[0,6].includes(new Date(now).getUTCDay()))){
   const plan=T.tryOpenTrendOnlyPosition(a,signal,i,config);
   const decision=plan.allowed?portfolioAllowed(name,plan):false;
   if(plan.allowed){b.portfolioShadowCoverage=typeof decision==="object"?decision.portfolioShadowCoverage:{status:"NOT_PROVIDED"};b.portfolioRisk=typeof decision==="object"?decision:null;}
   if(plan.allowed&&(typeof decision==="object"?decision.allowed:decision)){const price=Number(input.price)*(1+(plan.side==="long"?1:-1)*Number(account.simulationSlippageBps||0)/10000);
    const position=T.positionFromFill(plan,{qty:plan.qty,price},now,config);
    if(!position.postFillRiskExceeded&&!position.postFillRiskInvalid){b.state.position=position;b.state.lastEntrySignalTime=signal.signalTime;b.state.trendEntryCounts[plan.trendId]=Number(b.state.trendEntryCounts[plan.trendId]||0)+1;if(plan.executionEvaluation?.trendWave)b.state.activeEntryWave=plan.executionEvaluation.trendWave;}
   }
  }
  b.previousPrice=Number(input.price);
  b.lastTickAt=now;
  if(b.lastObservedSignalTime!==input.signalTime){b.barsObserved=Number(b.barsObserved||0)+1;b.lastObservedSignalTime=input.signalTime;}
  if(b.state.journal.length>2000)b.state.journal.splice(0,b.state.journal.length-2000);
 }
 return cohort;
}
// Select only the same named virtual ledger. Missing books never fall back to real equity.
function shadowPortfolioSnapshot(T,target,entries,name,side,newRisk){
 const group=entries.filter(e=>portfolioRiskKey(e.account)===portfolioRiskKey(target)),missing=[],ledgers=[];
 for(const e of group){const hash=scopeFor(T.normalizeConfig(e.account.trendOnlyConfig)).configHash,book=e.state.shadowBooks?.[hash]?.books[name];
  if(!book){missing.push(e.account.id);continue;}ledgers.push({account:e.account,equity:book.equity,state:book.state});
 }
 return{...snapshot(target,ledgers,side,newRisk),portfolioShadowCoverage:{status:missing.length?"PARTIAL":"COMPLETE",shadowName:name,totalAccounts:group.length,initializedAccounts:ledgers.length,missingAccountIds:missing}};
}
function shadowSummary(cohort,actual,summarize){
 return Object.fromEntries(NAMES.map(name=>{
  const b=cohort?.books?.[name];
  if(!b)return[name,{initialized:false,startedAt:null,lastTickAt:null,barsObserved:0,trades:null,hasOpenPosition:false,persistenceHealthy:false,orderPermission:false,message:"Shadow 尚未形成有效样本"}];
  const rows=b.state.journal,keys=new Set(rows.map(v=>`${v.signalTime}:${v.side}`));
  if(b.state.position)keys.add(`${b.state.position.signalTime}:${b.state.position.side}`);
  const excluded=actual.filter(v=>Number(v.entryTime)>=b.startedAt&&!keys.has(`${v.signalTime}:${v.side}`));
  return[name,{...summarize(rows),initialized:true,startedAt:b.startedAt,lastTickAt:b.lastTickAt||null,barsObserved:Number(b.barsObserved||0),hasOpenPosition:!!b.state.position,persistenceHealthy:Number(b.persistedAt)>=b.startedAt,portfolioShadowCoverage:b.portfolioShadowCoverage||{status:"NOT_EVALUATED"},missedWinner:excluded.filter(v=>Number(v.netPnl)>0).length,avoidedLoser:excluded.filter(v=>Number(v.netPnl)<0).length,model:b.model,orderPermission:false,warning:"独立Paper模型，估算费用，无资金费；只匹配Shadow开始后的真实平仓",openUnmatchedNotCounted:true}];
 }));
}
module.exports={tickShadowBooks,shadowSummary,shadowPortfolioSnapshot};
