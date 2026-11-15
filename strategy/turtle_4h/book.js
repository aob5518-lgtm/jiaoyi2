"use strict";
const crypto=require("crypto"),C=require("./config");
const round=n=>Math.round(n*1e10)/1e10;
const floorQty=(qty,step)=>round(Math.floor(qty/step+1e-9)*step);
function initial(a){return {schema:1,identity:C.identity(a),initialEquity:a.simulationBalance,balance:a.simulationBalance,realized:0,running:false,riskLock:false,position:null,pending:null,orders:[],trades:[],lastSignalAt:0,lastQuoteTime:0,day:null};}
function decide(b,code,reason,time){b.decision={code,reason,time};}
function net(p,price){return (p.side==="long"?1:-1)*(price-p.entry)*p.qty-p.entryFee-price*p.qty*p.cost.exitFeeRate+p.funding;}
function plan(b,a,c,data,analysis){
 const side=analysis.side,q=data.quote,cost=require("../../trade_cost").getEstimatedTradeCost({...a,paper:true},"turtle_breakout");
 const price=(side==="long"?q.ask:q.bid)*(1+(side==="long"?1:-1)*cost.estimatedEntrySlippage),distance=analysis.atr*c.stopAtr,budget=b.balance*c.riskPerTrade;
 const unitRisk=distance+price*cost.entryFeeRate+(price+distance)*(cost.exitFeeRate+cost.estimatedExitSlippage);
 const raw=Math.min(budget/unitRisk,b.balance*c.leverage/(price*(1+cost.entryFeeRate*c.leverage))),qty=floorQty(raw,data.rules.step);
 if(!(distance>0&&Number.isFinite(distance)&&qty>=data.rules.minQty&&qty<=data.rules.maxQty&&qty*price>=data.rules.minNotional))throw Error("SIZE_BLOCK：风险预算不足或数量不符合原生规格");
 return {qty,side,budget,atr:analysis.atr,distance,cost,config:{...c},configHash:C.hash(c),signalAt:analysis.closedAt,revision:C.REVISION};
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
function finish(b,price,time,reason){
 const p=b.position,gross=(p.side==="long"?1:-1)*(price-p.entry)*p.qty,fees=p.entryFee+price*p.qty*p.cost.exitFeeRate,netPnl=gross-fees+p.funding;
 b.trades.push({id:p.id,entryTime:p.openedAt,time,side:p.side,entryPrice:p.entry,exitPrice:price,qty:p.qty,reason,grossPnl:gross,tradingFee:fees,fundingPnl:p.funding,netPnl,rMultiple:netPnl/p.actualRisk,initialStop:p.initialStop,finalStop:p.stop,atrAtEntry:p.atr,plannedRisk:p.budget,actualRisk:p.actualRisk,config:p.config,configHash:p.configHash,strategyRevision:C.REVISION,sampleType:"paper_forward",maxFavorable:p.mfe,maxAdverse:p.mae});
 b.balance=round(b.balance+netPnl);b.realized=round(b.realized+netPnl);b.day.net+=netPnl;b.position=null;
 if(!(b.balance>0)){b.riskLock=true;b.running=false;}decide(b,"ORDER_FILLED",reason==="hard_sl"?"已按模拟保护止损退出":"模拟仓位已结算",time);
}
function advance(before,e,c){
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
   const stop=price+(m.side==="long"?-1:1)*m.distance;
   const unit=m.distance+price*cost.entryFeeRate+(price+m.distance)*(cost.exitFeeRate+cost.estimatedExitSlippage);
   const raw=Math.min(m.qty,m.budget/unit,b.balance*m.config.leverage/(price*(1+cost.entryFeeRate*m.config.leverage)),(m.side==="long"?q.askQty:q.bidQty)*.1),qty=floorQty(raw,e.data.rules.step);
   if(!(stop>0&&qty>=e.data.rules.minQty&&qty*price>=e.data.rules.minNotional&&qty<=e.data.rules.maxQty)){
    o.status="CANCELLED";o.finishedAt=time;b.pending=null;decide(b,"SIZE_BLOCK","实际盘口可成交数量不足或止损无效，取消余量",time);return b;
   }
   const permission=e.permit(m.budget,m.side);if(!permission.allowed){o.status="CANCELLED";o.finishedAt=time;b.pending=null;decide(b,"PORTFOLIO_BLOCK",permission.reason||"组合风险阻断",time);return b;}
   b.position={id:o.id,side:m.side,qty,entry:price,openedAt:time,stop,initialStop:stop,atr:m.atr,budget:m.budget,actualRisk:qty*unit,entryFee:price*qty*cost.entryFeeRate,cost,config:m.config,configHash:m.configHash,funding:0,fundingThrough:time,signalAt:m.signalAt,mae:0,mfe:0};
   o.filledQty=qty;o.remainderCancelled=qty<m.qty;o.price=price;o.status=qty<m.qty?"PARTIAL_FILLED_CANCELLED":"FILLED";
  }else{
   const p=b.position;if(!p)throw Error("UNKNOWN_ORDER_STATE：退出订单没有对应仓位");
   let reference=p.side==="long"?q.bid:q.ask,mode="market_quote";
   if(o.meta.reason==="hard_sl"){
    // Without tick-by-tick evidence, quote-triggered stops use the adverse quote, not an invented stop fill.
    reference=p.side==="long"?Math.min(reference,p.stop):Math.max(reference,p.stop);mode="quote_trigger_conservative";
   }
   const price=reference*(1+(p.side==="long"?-1:1)*p.cost.estimatedExitSlippage);o.price=price;o.filledQty=p.qty;o.status="FILLED";o.executionMode=mode;finish(b,price,time,o.meta.reason);
  }
  o.finishedAt=time;b.pending=null;b.lastQuoteTime=q.time;return b;
 }
 b.lastQuoteTime=Math.max(b.lastQuoteTime,q.time);
 if(b.position){
  const p=b.position,hard=p.side==="long"?q.bid<=p.stop:q.ask>=p.stop;
  if(hard||e.manual){submit(b,"close",{reason:hard?"hard_sl":"manual_close"},time);return b;}
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
 if(analysis.closedAt<=b.lastSignalAt){decide(b,"WAIT_BREAKOUT","等待下一根已收盘 4H 信号，同根 K 线不重复开仓",time);return b;}
 b.lastSignalAt=analysis.closedAt;
 if(!analysis.side){decide(b,analysis.code,analysis.reason,time);return b;}
 const m=plan(b,e.account,c,e.data,analysis),permission=e.permit(m.budget,m.side);
 if(!permission.allowed){decide(b,"PORTFOLIO_BLOCK",permission.reason||"组合风险未通过",time);return b;}
 submit(b,"open",m,time);return b;
}
module.exports={initial,advance,plan,net};
