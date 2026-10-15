"use strict";
const {scopeFor}=require("./scope");
// Independent simulated ledgers. This module has no exchange client, submit,
// confirmation token, history writer, or live-order callback.
function tickShadowBooks(T,container,account,input,running=true,portfolioAllowed=()=>true){
 const scope=scopeFor(input.config);container.shadowBooks||={};
 const cohort=container.shadowBooks[scope.configHash]||={scope,books:{}};
 for(const name of ["V3_COST_TIGHT","weekend_filter_shadow"]){
  const config={...input.config,experimentId:name,...(name==="V3_COST_TIGHT"?{maxPreferredCostR:.1,maxAllowedCostR:.2}:{})};
  const b=cohort.books[name]||={state:T.initialState(),equity:Number(account.equity),startedAt:Date.now(),orderPermission:false,model:"observed quotes, estimated fees/slippage, no funding"};
  if(!(b.equity>0))continue;
  const a={...account,paper:true,confirmLive:false,equity:b.equity,available:b.equity,trendOnlyState:b.state,trendOnlyConfig:config};
  const i={...input,config};
  const signal=T.detectMarketRegime(i.candles,i);T.updateTrendContext(b.state,signal,i);
  const now=Number(input.decisionTime||Date.now());
  if(b.state.position){
   const p=b.state.position,price=Number(input.price),action=T.manageTrendOnlyPosition(a,{price},i);
   if(action.reason){
    let exit=price,meta={};
    if(["hard_sl","trend_tp"].includes(action.reason)){
      meta=require("../../trend_runtime").paperStopFill({side:p.side,stopPrice:p.currentStopLossPrice,currentPrice:price,previousPrice:b.previousPrice,slippageBps:config.paperStopSlippageBps});exit=meta.stopExecutionPrice;
    }else exit*=1+(p.side==="long"?-1:1)*Number(account.simulationSlippageBps||0)/10000;
    const v=T.recordClose(a,{qty:p.positionSize,price:exit,...meta},action.reason,now);b.equity+=v.netPnl;
   }
  }else if(running&&!container.riskLock&&!container.pendingOrder&&!container.conflictingAccount&&!(Array.isArray(container.exchangeOpenOrders)?container.exchangeOpenOrders.length:Boolean(container.exchangeOpenOrders))&&!(name==="weekend_filter_shadow"&&[0,6].includes(new Date(now).getUTCDay()))){
   const plan=T.tryOpenTrendOnlyPosition(a,signal,i,config);
   if(plan.allowed&&portfolioAllowed(name,plan)){const price=Number(input.price)*(1+(plan.side==="long"?1:-1)*Number(account.simulationSlippageBps||0)/10000);
    const position=T.positionFromFill(plan,{qty:plan.qty,price},now,config);
    if(!position.postFillRiskExceeded&&!position.postFillRiskInvalid){b.state.position=position;b.state.lastEntrySignalTime=signal.signalTime;b.state.trendEntryCounts[plan.trendId]=Number(b.state.trendEntryCounts[plan.trendId]||0)+1;if(plan.executionEvaluation?.trendWave)b.state.activeEntryWave=plan.executionEvaluation.trendWave;}
   }
  }
  b.previousPrice=Number(input.price);
  if(b.state.journal.length>2000)b.state.journal.splice(0,b.state.journal.length-2000);
 }
 return cohort;
}
function shadowSummary(cohort,actual,summarize){
 if(!cohort)return null;
 return Object.fromEntries(Object.entries(cohort.books).map(([name,b])=>{const rows=b.state.journal,keys=new Set(rows.map(v=>`${v.signalTime}:${v.side}`));if(b.state.position)keys.add(`${b.state.position.signalTime}:${b.state.position.side}`);const excluded=actual.filter(v=>Number(v.entryTime)>=b.startedAt&&!keys.has(`${v.signalTime}:${v.side}`));return[name,{...summarize(rows),startedAt:b.startedAt,hasOpenPosition:!!b.state.position,missedWinner:excluded.filter(v=>Number(v.netPnl)>0).length,avoidedLoser:excluded.filter(v=>Number(v.netPnl)<0).length,model:b.model,orderPermission:false,warning:"独立Paper模型，估算费用，无资金费；只匹配Shadow开始后的真实平仓",openUnmatchedNotCounted:true}];}));
}
module.exports={tickShadowBooks,shadowSummary};
