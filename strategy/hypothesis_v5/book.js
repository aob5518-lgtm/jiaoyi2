"use strict";
const C=require("./config"),M=require("./market"),Portfolio=require("../trend_v3/portfolio"),Cost=require("../../trade_cost");
const terminal=new Set(["FILLED","CANCELLED","EXPIRED","REJECTED"]);
function create({id,symbol,mode="Shadow",equity=10000,config={},experimentId}){
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!(equity>=100&&equity<=10000000))throw Error("研究账户/权益无效");
 const cfg=C.normalize(config);return{schema:1,id,...C.scope(cfg,symbol,mode,experimentId),config:cfg,initialEquity:equity,equity,running:false,position:null,pending:null,riskLock:false,riskReason:null,day:null,dayStartEquity:equity,cooldownUntil:0,lastEventTime:0,seenSignals:[],orders:[],history:[],decisions:[],equityCurve:[],fundingIds:[],sequence:0,lastSnapshot:null};
}
function mark(b,price){const p=b.position;return b.equity+(p?(p.side==="long"?1:-1)*(price-p.entryPrice)*p.qty:0);}
function risk(b){return(b.position?.initialRiskAmount||0)+(b.pending?.remainingRisk||0);}
function portfolio(books,target,proposed=0){
 const active=books.filter(b=>b.mode===target.mode),equity=active.reduce((n,b)=>n+b.equity,0),total=active.reduce((n,b)=>n+risk(b),0),count=active.filter(b=>b.position||b.pending).length;
 const shared=Portfolio.snapshot({id:"v5-portfolio",platform:"binance",paper:true,trendOnlyConfig:{portfolioRiskKey:"H01_SHARED",maxPortfolioRiskPct:target.config.portfolioRiskLimit}},active.map(b=>({account:{id:b.id,platform:"binance",paper:true,trendOnlyConfig:{portfolioRiskKey:"H01_SHARED"}},equity,state:{position:b.position?{side:b.position.side,positionSize:b.position.qty,initialEffectiveRiskU:b.position.initialRiskAmount}:null,pendingOrder:b.pending?{kind:"open",side:b.pending.side,plan:{initialEffectiveRiskU:b.pending.remainingRisk}}:null}})),target.pending?.side||"none",proposed);
 return{equity,totalRisk:total,proposedRisk:proposed,count,limit:target.config.portfolioRiskLimit,correlationPolicy:"BTC/ETH full-risk sum, no diversification discount",allowed:equity>0&&!shared.unknownRisk&&(total+proposed)/equity<=target.config.portfolioRiskLimit&&count<target.config.maxPositions};
}
function cancel(b,status,time,reason){if(!b.pending)return;const o=b.orders.find(o=>o.id===b.pending.id);o.status=status;o.closedAt=time;o.reason=reason;b.pending=null;}
function validRules(r){return r&&[r.qtyStep,r.priceTick,r.minQty,r.minNotional,r.maxQty].every(v=>Number.isFinite(v)&&v>0);}
function plan(b,s,event,books){
 const c=b.config,q=event.quote,review=M.quoteReview(q,b.symbol,event.time,c,event.variant?.omitLiquidity);if(!review.allowed)throw Error(review.reasons.join(","));
 if(!validRules(event.rules))throw Error("TRADE_RULES_UNKNOWN");
 const direction=s.direction,sign=direction==="long"?1:-1,raw=direction==="long"?q.ask:q.bid,cost=Cost.getEstimatedTradeCost({platform:"binance",paper:true,simulationSlippageBps:c.slippageBps},"H01");
 const price=raw*(1+sign*c.slippageBps/10000),distance=c.stopAtr*s.atr;
 if(!(distance>0&&distance<price&&s.atr>0))throw Error("STOP_INVALID");
 if(Math.abs(price-s.referencePrice)>s.atr*c.maxEntryExtensionAtr)throw Error("NO_CHASE");
 const perUnit=distance+price*(2*c.feeRate+c.stressSlippageBps/10000+c.fundingReserveRate),budget=b.equity*c.riskPerTrade;
 const qty=Math.floor(Math.min(budget/perUnit,b.equity*c.marginFraction*c.maxLeverage/price,event.rules.maxQty)/event.rules.qtyStep)*event.rules.qtyStep;
 if(!(qty>=event.rules.minQty&&qty*price>=event.rules.minNotional))throw Error("MIN_TRADE_RULE");
 const riskAmount=qty*perUnit,entryFee=qty*price*c.feeRate,leverage=Math.max(1,Math.min(c.maxLeverage,Math.ceil(qty*price/(b.equity*c.marginFraction))));
 const liqDistance=price*(1/leverage-.01);if(distance+price*c.stressSlippageBps/10000>=liqDistance*.8)throw Error("LIQUIDATION_BUFFER_INSUFFICIENT");
 if(price*(2*c.feeRate+2*c.slippageBps/10000+c.fundingReserveRate)/distance>c.maxCostR)throw Error("COST_EDGE_INSUFFICIENT");
 const allowance=portfolio(books,b,riskAmount);if(!allowance.allowed)throw Error("PORTFOLIO_RISK_OR_POSITION_LIMIT");
 if(q.depthNotional<qty*price*10&&!event.variant?.omitLiquidity)throw Error("DEPTH_INSUFFICIENT");
 if(entryFee+qty*price/leverage>b.equity)throw Error("MARGIN_INSUFFICIENT");
 return{side:direction,qty,price,stop:price-sign*distance,atr:s.atr,distance,riskAmount,remainingRisk:riskAmount,leverage,budget,costSource:"estimated_taker_stress_reserve",liquidationEstimate:price-sign*liqDistance,liquidationModel:"conservative isolated research estimate; not exchange liquidation quote",portfolio:allowance};
}
function close(b,price,reason,time){
 const p=b.position;if(!p)return;const c=p.config,sign=p.side==="long"?1:-1,exitFee=price*p.qty*c.feeRate,gross=(price-p.entryPrice)*p.qty*sign,net=gross-p.entryFee-exitFee+p.fundingPnl;
 p.mae=Math.max(p.mae,sign*(p.entryPrice-price));p.mfe=Math.max(p.mfe,sign*(price-p.entryPrice));
 b.equity+=gross-exitFee;b.history.push({id:b.id+"-trade-"+(++b.sequence),...C.scope(c,b.symbol,b.mode,b.experimentId),sampleType:b.mode==="Shadow"?"shadow":"historical_backtest",side:p.side,regime:p.regime,signalId:p.signalId,entryTime:p.entryTime,exitTime:time,entryPrice:p.entryPrice,exitPrice:price,qty:p.qty,initialStop:p.initialStop,finalStop:p.stop,riskAmount:p.initialRiskAmount,netR:net/p.initialRiskAmount,grossPnl:gross,tradingFee:p.entryFee+exitFee,fundingPnl:p.fundingPnl,netPnl:net,closeReason:reason,holdingDurationMs:time-p.entryTime,MAE:p.mae,MFE:p.mfe,MAE_R:p.mae/p.distance,MFE_R:p.mfe/p.distance,protectiveStop:p.protection,executionQuality:p.executionQuality,equityAfter:b.equity});
 if(reason==="hard_sl")b.cooldownUntil=time+c.cooldownHours*3600000;
 b.position=null;
}
function lock(b,reason){b.riskLock=true;b.riskReason=reason;}
function reconcile(b){
 const orders=b.orders,filled=orders.reduce((n,o)=>n+Number(o.filledQty||0),0),closed=b.history.reduce((n,t)=>n+Number(t.qty||0),0),qty=Number(b.position?.qty||0);
 const statuses=new Set(["SUBMITTED","FILLED","PARTIAL_CANCELLED","CANCELLED","EXPIRED","REJECTED","UNKNOWN"]);
 if(new Set(orders.map(o=>o.id)).size!==orders.length||orders.some(o=>!statuses.has(o.status)||!Number.isFinite(Number(o.filledQty))||o.filledQty<0)||!Number.isFinite(filled-closed-qty)||Math.abs(filled-closed-qty)>1e-8||b.pending&&!orders.some(o=>o.id===b.pending.id))lock(b,"LEDGER_POSITION_MISMATCH");
}
function accrueFunding(b,event){
 const p=b.position,c=p.config,time=event.time,sign=p.side==="long"?1:-1;
 if(event.funding)for(const f of event.funding){if(!(f.time<=time&&Number.isFinite(f.rate)&&f.markPrice>0)){lock(b,"FUNDING_INVALID");continue;}if(f.time<p.entryTime)continue;const id=String(f.time)+":"+b.symbol;if(!b.fundingIds.includes(id)){const amount=-sign*p.qty*f.markPrice*f.rate;b.equity+=amount;p.fundingPnl+=amount;b.fundingIds.push(id);p.costTime=Math.max(p.costTime,f.time);}}
 if(event.funding===undefined){const amount=-p.qty*p.entryPrice*c.fundingEstimatePer8h*Math.max(0,time-p.costTime)/28800000;b.equity+=amount;p.fundingPnl+=amount;p.costTime=time;}
}
function step(b,event,books=[b]){
 const time=Number(event.time);if(!Number.isFinite(time)||time<=0)throw Error("EVENT_TIME_INVALID");
 if(time<=b.lastEventTime)return{duplicate:true};b.lastEventTime=time;
 reconcile(b);
 const decision={time,signalPermission:event.signal?.signalPermission||"blocked",planDecision:"NOT_EVALUATED",executionPermission:"blocked",finalDecision:"NO_SIGNAL",blockers:[...(event.signal?.blockers||[])]};
 const q=event.quote,price=M.quoteReview(q,b.symbol,time,b.config,true).allowed?(q.bid+q.ask)/2:null;
 const day=new Date(time).toISOString().slice(0,10);if(day!==b.day){b.day=day;b.dayStartEquity=price?mark(b,price):b.equity;}
 if(event.reconcileMismatch)lock(b,"LOCAL_POSITION_MISMATCH");
 if(b.position){
  const p=b.position,sign=p.side==="long"?1:-1,c=p.config;
  accrueFunding(b,event);
  if(event.stopRejected||p.protection!=="SIMULATED_ACTIVE"){lock(b,"PROTECTION_FAILED");if(price)close(b,price*(1-sign*c.stressSlippageBps/10000),"safety_exit",time);}
  if(b.position){
   const bar=event.bar;
   if(bar&&(bar.time+900000>time||![bar.open,bar.low,bar.high,bar.close].every(Number.isFinite)||bar.low<=0||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))){lock(b,"INVALID_MANAGEMENT_BAR");}
   const useBar=bar&&bar.time+900000>p.entryTime&&bar.time+900000<=time&&!b.riskLock;
   const low=useBar?bar.low:price,high=useBar?bar.high:price,open=useBar?bar.open:price;
   // Protective stop always precedes optional soft exits and new stop calculation.
   if(low>0&&high>0&&(sign>0?low<=p.stop:high>=p.stop)){
    const trigger=sign>0?Math.min(open,p.stop):Math.max(open,p.stop);close(b,trigger*(1-sign*c.slippageBps/10000),"hard_sl",time);
   }else if(price){
    p.mae=Math.max(p.mae,sign>0?p.entryPrice-low:high-p.entryPrice);p.mfe=Math.max(p.mfe,sign>0?high-p.entryPrice:p.entryPrice-low);
    p.high=Math.max(p.high,high);p.low=Math.min(p.low,low);
    const r=sign*(price-p.entryPrice)/p.distance;
    if(c.timeStopHours&&time-p.entryTime>=c.timeStopHours*3600000)close(b,price*(1-sign*c.slippageBps/10000),"time_stop",time);
    else if(c.reversalExit&&event.signal?.dataHealth==="healthy"&&event.signal.regime.direction!=="none"&&event.signal.regime.direction!==p.side)close(b,price*(1-sign*c.slippageBps/10000),"trend_reversal",time);
    else if(r>=c.trailActivationR&&event.signal?.atr>0&&event.signal.dataHealth==="healthy"){p.trailing=true;const next=sign>0?p.high-c.trailAtr*event.signal.atr:p.low+c.trailAtr*event.signal.atr;p.stop=sign>0?Math.max(p.stop,next):Math.min(p.stop,next);}
   }
  }
  decision.finalDecision="POSITION_MANAGED";
 }
 if(b.pending){
  const o=b.pending,record=b.orders.find(v=>v.id===o.id),review=M.quoteReview(q,b.symbol,time,b.config,event.variant?.omitLiquidity);
  if(record.status==="UNKNOWN"){lock(b,b.riskReason||"UNKNOWN_ORDER");decision.finalDecision="UNKNOWN_ORDER";}
  else if(event.cancelFailed){record.status="UNKNOWN";lock(b,"CANCEL_UNKNOWN");}
  else if(time>=o.expiresAt||!b.running||b.riskLock||b.position)cancel(b,time>=o.expiresAt?"EXPIRED":"CANCELLED",time,"窗口结束/策略暂停/风控");
  else if(event.submitTimeout){record.status="UNKNOWN";lock(b,"SUBMIT_UNKNOWN");}
  else if(review.allowed&&time>o.submittedAt&&!event.noFill){
   try{
    const s=o.signal;if(!M.weekend(time,b.config,review.allowed).allowed)throw Error("WEEKEND_BLOCK");
    if((b.dayStartEquity-mark(b,price))/b.dayStartEquity>=b.config.dailyLossLimit)throw Error("DAILY_LOSS");
    const saved=b.pending;b.pending=null;let planned;try{planned=plan(b,s,event,books);}finally{b.pending=saved;}
    const fraction=event.fillFraction??1;if(!(fraction>0&&fraction<=1))throw Error("FILL_FRACTION_INVALID");
    const qty=Math.floor(planned.qty*fraction/event.rules.qtyStep)*event.rules.qtyStep;if(qty<event.rules.minQty||qty*planned.price<event.rules.minNotional)throw Error("PARTIAL_BELOW_MINIMUM");
    if(event.stopRejected)throw Error("PROTECTIVE_STOP_REJECTED");
    const fee=qty*planned.price*b.config.feeRate;b.equity-=fee;
    b.position={...planned,qty,initialRiskAmount:planned.riskAmount*qty/planned.qty,entryPrice:planned.price,initialStop:planned.stop,entryTime:time,signalId:s.signalId,regime:s.regime?.state||"UNKNOWN",config:{...b.config},high:planned.price,low:planned.price,mae:0,mfe:0,fundingPnl:0,costTime:time,entryFee:fee,protection:"SIMULATED_ACTIVE",executionQuality:q.quality||"TOP_OF_BOOK_ASSUMPTION"};
    record.status=qty<planned.qty?"PARTIAL_CANCELLED":"FILLED";record.filledQty=qty;record.remainingQty=planned.qty-qty;record.fillTime=time;record.fillPrice=planned.price;
    b.pending=null;decision.finalDecision="ORDER_FILLED";decision.executionPermission="allowed";
   }catch(e){cancel(b,"REJECTED",time,e.message);decision.blockers.push(e.message);if(e.message==="PROTECTIVE_STOP_REJECTED")lock(b,e.message);}
  }else decision.finalDecision=record.status==="UNKNOWN"?"UNKNOWN_ORDER":"ORDER_WAITING";
 }
 const s=event.signal;
 if(!b.position&&!b.pending&&s?.signalPermission==="allowed"&&!b.seenSignals.includes(s.signalId)){
  b.seenSignals.push(s.signalId);
  try{
   if(!b.running)throw Error("MONITOR_STOPPED");if(b.riskLock)throw Error("RISK_LOCK");if(time<b.cooldownUntil)throw Error("COOLDOWN");
   if(time<s.signalTime||time>=s.signalTime+b.config.maxEntryAgeMs)throw Error("ENTRY_WINDOW_EXPIRED");
   if((b.dayStartEquity-mark(b,price))/b.dayStartEquity>=b.config.dailyLossLimit)throw Error("DAILY_LOSS");
   const planned=plan(b,s,event,books),id=b.id+"-order-"+(++b.sequence);
   b.pending={...planned,id,signal:s,side:s.direction,submittedAt:time,expiresAt:s.signalTime+b.config.maxEntryAgeMs};
   b.orders.push({id,status:"SUBMITTED",hypothesisId:"H01",signalId:s.signalId,submittedAt:time,expiresAt:b.pending.expiresAt,side:s.direction,plannedQty:planned.qty,filledQty:0,plannedRisk:planned.riskAmount,source:"VIRTUAL_ONLY"});
   decision.planDecision="CREATED";decision.executionPermission="allowed";decision.finalDecision="ORDER_SUBMITTED";
  }catch(e){decision.planDecision="BLOCKED";decision.blockers.push(e.message);decision.finalDecision=e.message;}
 }
 if(b.riskLock){decision.finalDecision="RISK_LOCK";decision.blockers.push(b.riskReason);}
 else if(!b.running&&!b.position){decision.finalDecision="MONITOR_STOPPED";}
 b.lastSnapshot={signal:s||null,decision,quoteTime:q?.time||null,markPrice:price,nextRiskEvaluation:time+15000};
 b.decisions.push(decision);if(b.decisions.length>(b.diagnosticLimit||12000))b.decisions=b.decisions.slice(-(b.diagnosticLimit||12000));
 b.equityCurve.push({time,equity:price?mark(b,price):b.equity});if(b.equityCurve.length>(b.curveLimit||50000))b.equityCurve=b.equityCurve.slice(-(b.curveLimit||50000));
 return decision;
}
module.exports={create,step,plan,close,mark,risk,portfolio,lock,validRules,terminal};
