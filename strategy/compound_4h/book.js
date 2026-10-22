"use strict";
const crypto=require("crypto"),C=require("./config"),{paperStopFill}=require("../../trend_runtime");
const TERMINAL=new Set(["FILLED","CANCELLED","EXPIRED"]),EPS=1e-10;
const round=(v,step,up=false)=>Number(((up?Math.ceil:Math.floor)(v/step+ (up?-1e-9:1e-9))*step).toPrecision(14));
function initial(config){const c=C.normalize(config);return{version:1,initialEquity:c.initialEquity,equity:c.initialEquity,realizedNetPnl:0,history:[],diagnostics:[],cycle:null,lastEventTime:0,lastSignalTime:0,pauseUntil:0,consecutiveLosses:0,dailyDate:"",dailyStartEquity:c.initialEquity,dailyLoss:0,riskLock:false,orderPermission:false};}
function riskOf(qty,price,stop,side,cost){return qty*(Math.max(0,(side==="long"?1:-1)*(price-stop))+price*cost.entryFeeRate+stop*(cost.exitFeeRate+cost.stopSlippageRate)+price*cost.fundingRate);}
function plan(signal,book,config,rules,account,now){
 const c=C.normalize(config);if(signal.decision!=="READY"||!["A","B"].includes(signal.scoreGrade))throw Error("反转候选尚未合格");
 if(![rules.qtyStep,rules.priceTick,rules.minQty,rules.minNotional].every(v=>Number.isFinite(v)&&v>0))throw Error("交易所价格/数量精度或最小下单量未知");
 const base=C.baseEquity(book,c),budget=Math.min(base,book.equity)*c.riskPerCycle,cap=Math.min(base,book.equity)*c.layerNotionalPct*(signal.scoreGrade==="B"?.5:1),s=signal.candidateDirection==="long"?1:-1;
 const stop=round(signal.plannedStopPrice,rules.priceTick,s<0),cost=signal.costs;
 if(!(base>0&&stop>0&&cost&&Object.values(cost).filter(v=>typeof v==="number").every(Number.isFinite)))throw Error("权益、止损或费用无效");
 const levels=Array.from({length:c.maxAdds+1},(_,n)=>round(signal.plannedEntryPrice-s*signal.atr*c.layerSpacingAtr*n,rules.priceTick,s<0));
 if(levels.some((p,n)=>p<signal.reversalZone.low-EPS||p>signal.reversalZone.high+EPS||s*(p-stop)<=0||(n&&s*(levels[n-1]-p)<rules.priceTick-EPS)))throw Error("四层结构区间或有效间距不足");
 let orders=levels.map((price,layer)=>({layer,price,qty:round(cap/price,rules.qtyStep),filledQty:0,status:layer?"DORMANT":"WAITING_ENTRY",fills:[]}));
 const worst=orders.reduce((a,o)=>a+riskOf(o.qty,o.price,stop,signal.candidateDirection,cost),0),scale=worst>budget?budget/worst:1;
 orders=orders.map(o=>({...o,qty:round(o.qty*scale,rules.qtyStep)}));
 if(orders.some(o=>o.qty<rules.minQty-EPS||o.qty*o.price<rules.minNotional-EPS||rules.maxQty&&o.qty>rules.maxQty))throw Error("风险缩量后低于最小订单或超过交易所上限，取消整轮");
 const plannedRisk=orders.reduce((a,o)=>a+riskOf(o.qty,o.price,stop,signal.candidateDirection,cost),0),notional=orders.reduce((a,o)=>a+o.qty*o.price,0);
 if(!(plannedRisk>0&&plannedRisk<=budget+EPS&&notional<=base*.04+EPS&&notional<=book.equity+EPS))throw Error("四层整体风险或4%名义仓位上限不合格");
 const id=crypto.createHash("sha256").update([account.id,signal.timestamp,C.scope(c,account).configHash].join(":")).digest("hex").slice(0,28);
 orders.forEach(o=>o.id=id+"-L"+o.layer);
 return{...C.scope(c,account),id,cycleId:id,accountId:account.id,symbol:account.symbol,platform:account.platform,side:signal.candidateDirection,entryMode:"compound_pullback",createdAt:now,expiresAt:now+c.orderTtlBars*14400000,phase:"WAITING_ENTRY",baseEquity:base,initialEquity:book.equity,riskBudget:budget,layerCap:cap,initialPlannedRisk:plannedRisk,currentPlannedRisk:plannedRisk,finalLockedRisk:plannedRisk,plannedNotional:notional,stopPrice:stop,initialStopLossPrice:stop,orders,rules:{...rules},config:c,costs:cost,prediction:signal,qty:0,filledQty:0,entryNotional:0,averagePrice:0,realizedNetPnl:0,grossPnl:0,tradingFee:0,fundingPnl:0,slippageLoss:0,partialExits:[],stopTransitions:[],riskTransitions:[],tpStage:0,adds:0,lastManagedBar:0,sampleType:account.compoundMode==="shadow"?"shadow":"paper",paper:true,allowLive:false,orderPermission:false,matchingQuality:"CONSERVATIVE_OHLC_OR_SAMPLED_PRICE_NOT_ORDERBOOK"};
}
function cancel(cycle,reason){for(const o of cycle.orders)if(["DORMANT","WAITING_ENTRY","PARTIALLY_FILLED"].includes(o.status)){o.status=reason.includes("过期")?"EXPIRED":"CANCELLED";o.cancelReason=reason;}}
function netAt(cycle,price){return cycle.realizedNetPnl+(cycle.side==="long"?1:-1)*(price-cycle.averagePrice)*cycle.qty-price*cycle.qty*(cycle.costs.exitFeeRate+cycle.costs.stopSlippageRate)-cycle.averagePrice*cycle.qty*cycle.costs.fundingRate;}
function exit(cycle,qty,price,reason,time,slippage={}){
 if(!(qty>0&&qty<=cycle.qty+EPS&&price>0))throw Error("平仓数量或价格无效");
 qty=Math.min(qty,cycle.qty);const gross=(cycle.side==="long"?1:-1)*(price-cycle.averagePrice)*qty,fee=price*qty*cycle.costs.exitFeeRate,funding=cycle.averagePrice*qty*cycle.costs.fundingRate,net=gross-fee-funding;
 cycle.realizedNetPnl+=net;cycle.grossPnl+=gross;cycle.tradingFee+=fee;cycle.fundingPnl-=funding;cycle.qty=Math.max(0,cycle.qty-qty);if(cycle.qty<EPS)cycle.qty=0;
 cycle.partialExits.push({id:cycle.id+"-X"+cycle.partialExits.length,time,qty,price,reason,grossPnl:gross,tradingFee:fee,fundingPnl:-funding,netPnl:net,...slippage});cycle.slippageLoss+=Number(slippage.stopSlippageAmount||0)*qty;
 if(!cycle.qty){cancel(cycle,"仓位已退出");cycle.phase="EXITING";cycle.exitTime=time;cycle.exitPrice=price;cycle.closeReason=reason;}
}
function settle(book,time){
 const p=book.cycle;if(!p||p.qty||!p.orders.every(o=>TERMINAL.has(o.status)))return false;
 if(book.history.some(v=>v.cycleId===p.id)){book.riskLock=true;book.riskLockReason="轮次已结算但仍有活动记录";p.phase="RECONCILING";return false;}
 p.phase=p.filledQty?"CYCLE_CLOSED":"ABORTED";p.exitTime||=time;
 if(p.filledQty){book.equity+=p.realizedNetPnl;book.realizedNetPnl+=p.realizedNetPnl;book.consecutiveLosses=p.realizedNetPnl<0?book.consecutiveLosses+1:0;book.dailyLoss=Math.max(0,book.dailyStartEquity-book.equity);}
 const row={...p,netPnl:p.realizedNetPnl,pnl:p.realizedNetPnl,netR:p.filledQty?p.realizedNetPnl/p.finalLockedRisk:null,rMultiple:p.filledQty?p.realizedNetPnl/p.finalLockedRisk:null,entryPrice:p.averagePrice,entryTime:p.entryTime,positionSize:p.filledQty,holdingDurationMs:p.entryTime?time-p.entryTime:null,equityAfter:book.equity,settledAt:time,currentPlannedRisk:0,remainingOrders:0};
 book.history.push(row);book.pauseUntil=time+p.config.cooldownBars*14400000;if(book.consecutiveLosses>=p.config.maxConsecutiveLosses)book.riskLock=true;book.cycle=null;return true;
}
function reconcile(book){
 const p=book.cycle;if(!p)return;
 const ids=p.orders.map(o=>o.id),bad=ids.length!==new Set(ids).size||p.orders.some(o=>!Number.isFinite(o.filledQty)||o.filledQty<0||o.filledQty>o.qty+EPS||!["DORMANT","WAITING_ENTRY","PARTIALLY_FILLED",...TERMINAL].includes(o.status));
 const filled=p.orders.reduce((a,o)=>a+o.filledQty,0),exited=p.partialExits.reduce((a,x)=>a+x.qty,0);
 if(bad||Math.abs(filled-exited-p.qty)>Math.max(EPS,p.rules.qtyStep/100)||book.history.some(v=>v.cycleId===p.id)){p.phase="RECONCILING";book.riskLock=true;book.riskLockReason="Paper订单与仓位无法核对，安全暂停";throw Error(book.riskLockReason);}
}
function exposure(book){const p=book.cycle;if(!p)return{position:null,pendingOrder:null};const pending=p.orders.filter(o=>!TERMINAL.has(o.status)).reduce((a,o)=>a+riskOf(o.qty-o.filledQty,o.price,p.stopPrice,p.side,p.costs),0);return{position:p.qty?{side:p.side,positionSize:p.qty,initialEffectiveRiskU:riskOf(p.qty,p.averagePrice,p.stopPrice,p.side,p.costs)}:null,pendingOrder:pending>EPS?{kind:"open",side:p.side,plan:{initialEffectiveRiskU:pending}}:null};}
function step(book,{event,signal,config,account,rules,running,permit=()=>({allowed:false,reason:"组合风控不可用"}),manualClose=false}){
 const c=C.normalize(config),time=Number(event.time),price=Number(event.price);
 if(!(time>0&&price>0&&Number.isFinite(time)&&Number.isFinite(price)))throw Error("行情价格或时间无效");
 if(time<=book.lastEventTime)return book;book.lastEventTime=time;book.orderPermission=false;
 if(account.tradeMode!=="simulation"||account.simulationEnabled!==true)throw Error("4H Compound 强制Paper，禁止Live");
 reconcile(book);const day=new Date(time).toISOString().slice(0,10);if(day!==book.dailyDate){book.dailyDate=day;book.dailyStartEquity=book.equity;book.dailyLoss=0;}
 let p=book.cycle;
 if(p){
  const s=p.side==="long"?1:-1,lo=Number(event.low??price),hi=Number(event.high??price);if(!(lo>0&&hi>=lo&&hi>=price&&lo<=price))throw Error("撮合区间无效");
  const stale=signal.dataFreshness!=="healthy",invalid=signal.dailyTrend&&signal.dailyTrend!==p.side||signal.fourHourStructure&&s*(price-p.initialStopLossPrice)<=0,stopHit=s>0?lo<=p.stopPrice:hi>=p.stopPrice;
  if(manualClose||stopHit||invalid||book.riskLock){
   if(!p.qty&&stopHit&&event.low!==undefined){p.pathUncertain=true;p.abortReason="path_uncertain_entry_and_stop";}
   cancel(p,"退出优先，取消所有未成交委托");
   if(p.qty){const stop=stopHit?paperStopFill({side:p.side,stopPrice:p.stopPrice,currentPrice:s>0?lo:hi,previousPrice:book.lastPrice,slippageBps:c.stopSlippageBps}):{stopExecutionPrice:price*(1-s*p.costs.stopSlippageRate)};exit(p,p.qty,stop.stopExecutionPrice,manualClose?"manual_close":stopHit?(p.tpStage?"trend_tp":"hard_sl"):"structure_invalid",time,stop);}
   settle(book,time);
  }else if(stale||time>=p.expiresAt&&p.qty===0||p.qty===0&&Math.abs(price-p.prediction.plannedEntryPrice)>p.prediction.atr*5){
   cancel(p,stale?"行情中断":!running?"停止新开与补仓":"预测过期或远离区域");if(!p.qty)settle(book,time);
  }else{
   if(!running||time>=p.expiresAt)cancel(p,!running?"停止新开与补仓":"预测过期");
   const permission=permit(p.initialPlannedRisk,p.side),active=p.orders.find(o=>["WAITING_ENTRY","PARTIALLY_FILLED"].includes(o.status));
   if(active&&permission.allowed&&!book.riskLock&&book.dailyLoss<book.dailyStartEquity*c.maxDailyLossRatio){
    const hit=s>0?lo<active.price-p.rules.priceTick*.1:hi>active.price+p.rules.priceTick*.1;
    // A touch alone does not guarantee a fill. Only one layer per observed event.
    if(hit&&s*(price-p.stopPrice)>0&&(!p.qty||s*(price-p.averagePrice)<0)){
     const remaining=active.qty-active.filledQty;let qty=round(remaining*c.fillFraction,p.rules.qtyStep);if(qty<p.rules.minQty||qty*active.price<p.rules.minNotional||remaining-qty<p.rules.minQty||(remaining-qty)*active.price<p.rules.minNotional)qty=remaining;
     const risk=p.orders.reduce((a,o)=>a+riskOf(o.qty,o.price,p.stopPrice,p.side,p.costs),0);
     if(risk<=p.riskBudget+EPS&&qty>=p.rules.minQty-EPS){const fee=qty*active.price*p.costs.entryFeeRate;p.entryNotional+=qty*active.price;p.filledQty+=qty;p.qty+=qty;p.averagePrice=(p.averagePrice*(p.qty-qty)+qty*active.price)/p.qty;p.tradingFee+=fee;p.realizedNetPnl-=fee;active.filledQty+=qty;active.fills.push({id:active.id+"-F"+active.fills.length,eventTime:time,qty,price:active.price,fee,liquidity:"unknown_taker_estimate"});active.status=active.qty-active.filledQty<EPS?"FILLED":"PARTIALLY_FILLED";p.entryTime||=time;p.phase=active.layer?"ADDING_POSITION":active.status==="FILLED"?"POSITION_OPEN":"PARTIALLY_FILLED";p.adds=p.orders.filter(o=>o.layer>0&&o.filledQty>0).length;
      if(active.status==="FILLED"){const next=p.orders.find(o=>o.status==="DORMANT");if(next)next.status="WAITING_ENTRY";}
      p.currentPlannedRisk=p.orders.reduce((a,o)=>a+riskOf(o.filledQty,o.price,p.stopPrice,p.side,p.costs),0);p.riskTransitions.push({time,used:p.currentPlannedRisk,reserved:p.initialPlannedRisk,average:p.averagePrice});
     }
    }
   }
   if(p.qty){
    const totalNet=netAt(p,price),r=totalNet/p.finalLockedRisk;p.unrealizedNetPnl=totalNet-p.realizedNetPnl;p.netR=r;
    if(c.exitVariant==="FIXED_TARGET"&&r>=2){cancel(p,"固定2R退出");exit(p,p.qty,price*(1-s*p.costs.stopSlippageRate),"fixed_tp",time);}
    else if(c.exitVariant!=="TRAIL_ONLY"&&r>=(p.tpStage?2:1)&&p.tpStage<2){cancel(p,"分段止盈后禁止补仓");let qty=round(p.qty*.5,p.rules.qtyStep);if(qty<p.rules.minQty||qty*price<p.rules.minNotional||(p.qty-qty)*price<p.rules.minNotional)qty=p.qty;exit(p,qty,price*(1-s*p.costs.stopSlippageRate),p.tpStage?"tp_2r":"tp_1r",time);p.tpStage++;}
    if(p.qty&&(p.tpStage||c.exitVariant==="TRAIL_ONLY"&&r>=1)&&signal.dataFreshness==="healthy"&&signal.timestamp>p.lastManagedBar){
     p.lastManagedBar=signal.timestamp;
     const fee=p.costs.exitFeeRate+p.costs.fundingRate+p.costs.stopSlippageRate,be=(p.averagePrice*p.qty-p.realizedNetPnl*s)/(p.qty*(1-s*fee)),trail=price-s*signal.atr*1.5,structure=signal.fourHourStructure?.price;
     const next=p.tpStage>=2||c.exitVariant==="TRAIL_ONLY"?(s>0?Math.max(be,trail,structure?structure-signal.atr*.5:-Infinity):Math.min(be,trail,structure?structure+signal.atr*.5:Infinity)):be;
     const bounded=s>0?Math.min(next,price-signal.atr*.25):Math.max(next,price+signal.atr*.25),tight=s>0?Math.max(p.stopPrice,bounded):Math.min(p.stopPrice,bounded);if(tight!==p.stopPrice){p.stopTransitions.push({time,from:p.stopPrice,to:tight});p.stopPrice=tight;}
    }
    if(!p.qty)settle(book,time);
   }
  }
 }
 if(book.cycle&&!book.cycle.qty&&book.cycle.orders.every(o=>TERMINAL.has(o.status)))settle(book,time);
 const signalKey=signal.timestamp+":"+(signal.dataTimes?.hour??signal.dataFreshness);
 if(!book.cycle&&running&&!manualClose&&!book.riskLock&&time>=book.pauseUntil&&signalKey!==book.lastSignalKey){
  book.lastSignalTime=signal.timestamp;book.lastSignalKey=signalKey;let diagnostic={...signal};
  try{if(book.dailyLoss>=book.dailyStartEquity*c.maxDailyLossRatio)throw Error("日净亏损限制");const candidate=plan(signal,book,c,rules,account,time),permission=permit(candidate.initialPlannedRisk,candidate.side);if(!permission.allowed)throw Error(permission.reason||"组合风险阻断");book.cycle=candidate;diagnostic={...diagnostic,decision:"ORDER_PENDING",cycleId:candidate.id,plannedEntryPrices:candidate.orders.map(o=>o.price),projectedRisk:candidate.initialPlannedRisk,riskBudget:candidate.riskBudget,estimatedFees:candidate.orders.reduce((a,o)=>a+o.price*o.qty*(candidate.costs.entryFeeRate+candidate.costs.exitFeeRate),0),estimatedSlippage:candidate.orders.reduce((a,o)=>a+o.price*o.qty*candidate.costs.stopSlippageRate,0)};}catch(error){diagnostic.primaryBlocker=error.message;diagnostic.decision=signal.decision==="READY"?"BLOCKED":signal.decision;}
  book.diagnostics.push(diagnostic);book.diagnostics=book.diagnostics.slice(-2500);
 }
 book.lastPrice=price;return book;
}
module.exports={initial,plan,riskOf,netAt,cancel,settle,reconcile,exposure,step,round};
