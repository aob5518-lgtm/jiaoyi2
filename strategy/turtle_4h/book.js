"use strict";
const crypto=require("crypto"),C=require("./config");
const round=n=>Math.round(n*1e10)/1e10;
const floorQty=(qty,step)=>round(Math.floor(qty/step+1e-9)*step);
function initial(a,profile=C){return {schema:1,identity:profile.identity(a),initialEquity:a.simulationBalance,balance:a.simulationBalance,realized:0,running:false,riskLock:false,position:null,pending:null,orders:[],trades:[],lastSignalAt:0,lastQuoteTime:0,day:null};}
function decide(b,code,reason,time){b.decision={code,reason,time};}
function net(p,price){return (p.side==="long"?1:-1)*(price-p.entry)*p.qty-p.entryFee-price*p.qty*p.cost.exitFeeRate+p.funding;}
function protection(price, quote, side, atr, entry, config, cost) {
 const sign=side==="long"?1:-1;
 const distance=Math.max(1.2*atr,sign*(price-entry.stop));
 const stop=price-sign*distance;
 const exitQuote=side==="long"?quote.bid:quote.ask;
 const target=entry.target;
 const stopFill=stop*(1-sign*cost.estimatedExitSlippage);
 const targetFill=target*(1-sign*cost.estimatedExitSlippage);
 const unitRisk=sign*(price-stopFill)+price*cost.entryFeeRate+stopFill*cost.exitFeeRate;
 const netReward=sign*(targetFill-price)-price*cost.entryFeeRate-targetFill*cost.exitFeeRate;
 if(!(stop>0&&target>0&&distance>0&&distance<=3*atr&&sign*(exitQuote-entry.stop)>0&&sign*(exitQuote-stop)>0)) {
  throw Error("STRUCTURE_RISK：反转结构已失效或结构止损超出 3 ATR");
 }
 if(!(unitRisk>0&&netReward/unitRisk>=config.minNetR)) {
  throw Error("COST_BLOCK：扣除预计交易成本后的收益风险比低于 "+config.minNetR+"R");
 }
 return {distance,stop,target,unitRisk,netR:netReward/unitRisk};
}
function plan(b,a,c,data,analysis,profile=C){
 const side=analysis.side,q=data.quote,entry=analysis.entry;
 const cost=require("../../trade_cost").getEstimatedTradeCost({...a,paper:true},entry?"range_reversal":"turtle_breakout");
 const price=(side==="long"?q.ask:q.bid)*(1+(side==="long"?1:-1)*cost.estimatedEntrySlippage),budget=b.balance*c.riskPerTrade;
 const levels=entry?protection(price,q,side,analysis.atr,entry,c,cost):null;
 const distance=levels?.distance??analysis.atr*c.stopAtr,leverage=c.leverage??1;
 const unitRisk=levels?.unitRisk??distance+price*cost.entryFeeRate+(price+distance)*(cost.exitFeeRate+cost.estimatedExitSlippage);
 const raw=Math.min(budget/unitRisk,b.balance*leverage/(price*(1+cost.entryFeeRate*leverage))),qty=floorQty(raw,data.rules.step);
 if(!(distance>0&&Number.isFinite(distance)&&qty>=data.rules.minQty&&qty<=data.rules.maxQty&&qty*price>=data.rules.minNotional))throw Error("SIZE_BLOCK：风险预算不足或数量不符合原生规格");
 return {qty,side,budget,atr:analysis.atr,distance,cost,config:{...c},configHash:profile.hash(c),signalAt:analysis.closedAt,revision:profile.REVISION,
  ...(entry?{entry:{...entry},netR:levels.netR}:{})};
}
function submit(b,kind,meta,time){
 const order={id:crypto.randomUUID(),kind,status:"SUBMITTED",submittedAt:time,meta};b.pending=order;b.orders.push(order);decide(b,"ORDER_SUBMITTED",kind==="open"?"模拟开仓已提交，等待下一笔新鲜盘口成交":"模拟退出已提交，等待成交",time);
}
function funding(b,data,time){
 const p=b.position;if(!p)return;
 if(data.fundingFrom>p.fundingThrough)throw Error("FUNDING_GAP：缺少持仓期间资金费历史");
 for(const f of data.funding.filter(v=>v.time>p.openedAt&&v.time>p.fundingThrough&&v.time<=time))p.funding+=-(p.side==="long"?1:-1)*p.qty*f.price*f.rate;
 p.fundingThrough=time;
}
function finish(b,price,time,reason,profile){
 const p=b.position,gross=(p.side==="long"?1:-1)*(price-p.entry)*p.qty,fees=p.entryFee+price*p.qty*p.cost.exitFeeRate,netPnl=gross-fees+p.funding;
 b.trades.push({id:p.id,entryTime:p.openedAt,time,side:p.side,entryPrice:p.entry,exitPrice:price,qty:p.qty,reason,grossPnl:gross,tradingFee:fees,fundingPnl:p.funding,netPnl,rMultiple:netPnl/p.actualRisk,initialStop:p.initialStop,finalStop:p.stop,atrAtEntry:p.atr,plannedRisk:p.budget,actualRisk:p.actualRisk,config:p.config,configHash:p.configHash,strategyRevision:profile.REVISION,sampleType:"paper_forward",maxFavorable:p.mfe,maxAdverse:p.mae,
  ...(p.target?{target:p.target,plannedNetR:p.plannedNetR}:{})});
 b.balance=round(b.balance+netPnl);b.realized=round(b.realized+netPnl);b.day.net+=netPnl;b.position=null;
 if(!(b.balance>0)){b.riskLock=true;b.running=false;}decide(b,"ORDER_FILLED",reason==="hard_sl"?"已按模拟保护止损退出":"模拟仓位已结算",time);
}
function advance(before,e,c,profile=C){
 const b=structuredClone(before),time=e.time,q=e.data.quote,mid=(q.bid+q.ask)/2,analysis=e.analysis;
 if(b.pending){const recorded=b.orders.find(o=>o.id===b.pending.id);if(!recorded||recorded.status!=="SUBMITTED")throw Error("UNKNOWN_ORDER_STATE：委托状态无法核对");b.pending=recorded;}
 const day=new Date(time).toISOString().slice(0,10);if(b.day?.date!==day)b.day={date:day,startingEquity:b.balance,net:0};
 funding(b,e.data,time);
 if(b.position){const p=b.position,movement=(p.side==="long"?1:-1)*(mid-p.entry);p.mfe=Math.max(p.mfe,movement);p.mae=Math.min(p.mae,movement);}
 if(b.pending){
  const o=b.pending,isOpen=o.kind==="open";
  if(isOpen&&(!b.running||b.riskLock||e.blocker||!e.marketOK||time-o.submittedAt>60000)){
   o.status="CANCELLED";o.finishedAt=time;b.pending=null;decide(b,"ENTRY_CANCELLED",e.blocker||"开仓条件已变化或委托过期，未伪造成交",time);return b;
  }
  if(q.time<=Math.max(b.lastQuoteTime,o.submittedAt)){decide(b,"WAIT_NEW_QUOTE","委托等待新的原生盘口证据",time);return b;}
  if(isOpen){
   const m=o.meta,cost=m.cost,price=(m.side==="long"?q.ask:q.bid)*(1+(m.side==="long"?1:-1)*cost.estimatedEntrySlippage);
   let levels;
   if(m.entry){
    try {levels=protection(price,q,m.side,m.atr,m.entry,m.config,cost);}
    catch(error){
     o.status="CANCELLED";o.finishedAt=time;b.pending=null;
     decide(b,"ENTRY_CANCELLED",error.message+"，未模拟成交",time);return b;
    }
   }
   const stop=levels?.stop??price+(m.side==="long"?-1:1)*m.distance,leverage=m.config.leverage??1;
   const unit=levels?.unitRisk??m.distance+price*cost.entryFeeRate+(price+m.distance)*(cost.exitFeeRate+cost.estimatedExitSlippage);
   const raw=Math.min(m.qty,m.budget/unit,b.balance*leverage/(price*(1+cost.entryFeeRate*leverage)),(m.side==="long"?q.askQty:q.bidQty)*.1),qty=floorQty(raw,e.data.rules.step);
   if(!(stop>0&&qty>=e.data.rules.minQty&&qty*price>=e.data.rules.minNotional&&qty<=e.data.rules.maxQty)){
    o.status="CANCELLED";o.finishedAt=time;b.pending=null;decide(b,"SIZE_BLOCK","实际盘口可成交数量不足或止损无效，取消余量",time);return b;
   }
   const permission=e.permit(m.budget,m.side);if(!permission.allowed){o.status="CANCELLED";o.finishedAt=time;b.pending=null;decide(b,"PORTFOLIO_BLOCK",permission.reason||"组合风险阻断",time);return b;}
   b.position={id:o.id,side:m.side,qty,entry:price,openedAt:time,stop,initialStop:stop,atr:m.atr,budget:m.budget,actualRisk:qty*unit,entryFee:price*qty*cost.entryFeeRate,cost,config:m.config,configHash:m.configHash,funding:0,fundingThrough:time,signalAt:m.signalAt,mae:0,mfe:0};
   if(levels){b.position.target=levels.target;b.position.plannedNetR=levels.netR;decide(b,"ORDER_FILLED","模拟"+(m.side==="long"?"多仓":"空仓")+"已成交，止损与目标已锁定",time);}
   o.filledQty=qty;o.remainderCancelled=qty<m.qty;o.price=price;o.status=qty<m.qty?"PARTIAL_FILLED_CANCELLED":"FILLED";
  }else{
   const p=b.position;if(!p)throw Error("UNKNOWN_ORDER_STATE：退出订单没有对应仓位");
   let reference=p.side==="long"?q.bid:q.ask,mode="market_quote";
   const hard=p.target&&(p.side==="long"?q.bid<=p.stop:q.ask>=p.stop);
   const reason=hard?"hard_sl":o.meta.reason;
   if(reason==="hard_sl"){
    // Without tick-by-tick evidence, quote-triggered stops use the adverse quote, not an invented stop fill.
    reference=p.side==="long"?Math.min(reference,p.stop):Math.max(reference,p.stop);mode="quote_trigger_conservative";
   }
   const price=reference*(1+(p.side==="long"?-1:1)*p.cost.estimatedExitSlippage);o.price=price;o.filledQty=p.qty;o.status="FILLED";o.executionMode=mode;o.meta.reason=reason;finish(b,price,time,reason,profile);
  }
  o.finishedAt=time;b.pending=null;b.lastQuoteTime=q.time;return b;
 }
 b.lastQuoteTime=Math.max(b.lastQuoteTime,q.time);
 if(b.position){
  const p=b.position,hard=p.side==="long"?q.bid<=p.stop:q.ask>=p.stop;
  if(hard||e.manual){submit(b,"close",{reason:hard?"hard_sl":"manual_close"},time);return b;}
  if(p.target){
   const targetReached=p.side==="long"?q.bid>=p.target:q.ask<=p.target;
   if(targetReached||time-p.openedAt>=p.config.maxHoldBars*profile.BAR){
    submit(b,"close",{reason:targetReached?"mean_target":"time_stop"},time);return b;
   }
   decide(b,"POSITION_MANAGED","持仓中，按本轮锁定的止损、回归目标和最长持仓时间管理",time);return b;
  }
  // A stopped monitor still maintains the protective stop and channel exit.
  if(e.marketOK&&analysis.closedAt>p.signalAt){
   const target=p.side==="long"?analysis.exitLow:analysis.exitHigh,close=p.side==="long"?analysis.close<target:analysis.close>target;
   if(close){submit(b,"close",{reason:"channel_exit"},time);return b;}
   const tightened=p.side==="long"?Math.max(p.stop,target):Math.min(p.stop,target);
   if(p.side==="long"?tightened<q.bid:tightened>q.ask)p.stop=tightened;
  }
  decide(b,"POSITION_MANAGED",b.running?"持仓中，按已锁定通道和止损保护":"已暂停新开仓，现有持仓保护继续",time);return b;
 }
 if(e.manual||!b.running){decide(b,"MONITOR_STOPPED","尚未启动；保存参数后检查并启动",time);return b;}
 if(b.riskLock||e.blocker){decide(b,"RISK_BLOCK",e.blocker||"模拟账本风险锁定",time);return b;}
 if(b.day.net<=-.02*b.day.startingEquity){decide(b,"DAILY_LOSS_BLOCK","本日已结算亏损达到 2%，暂停新增风险",time);return b;}
 if(!e.marketOK){decide(b,analysis.code,analysis.reason,time);return b;}
 if(analysis.closedAt<=b.lastSignalAt){
  if(!profile.waitCode)decide(b,"WAIT_BREAKOUT","等待下一根已收盘 4H 信号，同根 K 线不重复开仓",time);
  return b;
 }
 b.lastSignalAt=analysis.closedAt;
 if(!analysis.side){decide(b,analysis.code,analysis.reason,time);return b;}
 let m;
 try {m=plan(b,e.account,c,e.data,analysis,profile);}
 catch(error){
  if(!analysis.entry)throw error;
  const code=error.message.startsWith("COST_BLOCK")?"COST_BLOCK":error.message.startsWith("STRUCTURE_RISK")?"STRUCTURE_RISK":"SIZE_BLOCK";
  decide(b,code,error.message,time);return b;
 }
 const permission=e.permit(m.budget,m.side);
 if(!permission.allowed){decide(b,"PORTFOLIO_BLOCK",permission.reason||"组合风险未通过",time);return b;}
 submit(b,"open",m,time);return b;
}
module.exports={initial,advance,plan,net};
