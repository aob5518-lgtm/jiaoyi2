"use strict";
const C=require('./config'),{HOUR}=require('./signal'),Audit=require('./audit');
const clone=structuredClone,sign=side=>side==='long'?1:-1,round=v=>Number(v.toFixed(10));
function initial(account){C.assertAccount(account);const n=Number(account.simulationBalance);if(!Number.isFinite(n)||n<100)throw Error('H06 初始权益无效');return{schema:1,accountId:account.id,identity:[account.platform,account.symbol,account.quoteAsset,account.h06Mode,n].join(':'),initialEquity:n,equity:n,realizedNetPnl:0,cycle:null,pending:null,phase:'IDLE',orders:[],history:[],signals:[],consumed:[],riskLock:false,riskLockReason:'',cooldownUntil:0,lastSignalTime:0,sequence:0,day:null,lastQuote:null,lastEvaluatedAt:null};}
function netAt(p,price,exitSlippage=true){if(!p)return 0;const c=p.config,fill=price*(1-(exitSlippage?c.slippageBps/10000:0)*sign(p.side));return p.realizedGross+(fill-p.averagePrice)*p.qty*sign(p.side)-p.entryFees-p.exitFees+p.fundingPnl-fill*p.qty*c.exitFeeRate;}
function realized(p){return p.realizedGross-p.entryFees-p.exitFees+p.fundingPnl;}
function roiAt(p,price){return p?.marginUsed>0?100*netAt(p,price)/p.marginUsed:0;}
function lossStop(p){const c=p.config,s=sign(p.side),factor=1-s*c.maxSlippageBps/10000,constant=p.realizedGross-s*p.averagePrice*p.qty-p.entryFees-p.exitFees+p.fundingPnl;return(-p.riskBudget-constant)/(p.qty*factor*(s-c.exitFeeRate));}
function refreshStop(p){if(!p.qty)return;const tick=p.priceTick||1e-8,fixed=p.side==='long'?Math.max(tick,Math.ceil(lossStop(p)/tick)*tick):Math.max(tick,Math.floor(lossStop(p)/tick)*tick);let target=fixed;if(p.config.stopMode==='ATR'&&p.atr>0)target=p.side==='long'?Math.max(fixed,(p.structureLow??p.averagePrice)-p.atr*p.config.atrMultiplier):Math.min(fixed,(p.structureHigh??p.averagePrice)+p.atr*p.config.atrMultiplier);p.stopPrice=p.stopPrice==null?target:p.side==='long'?Math.max(p.stopPrice,target):Math.min(p.stopPrice,target);}
function used(b,signal){return b.consumed.includes(signal.id);}
function consume(b,signal){if(!used(b,signal))b.consumed.push(signal.id);b.lastSignalTime=Math.max(b.lastSignalTime,signal.closedTime);}
function decision(b,code,reason){b.decision={code,reason,at:b.lastEvaluatedAt};return b;}
function mark(b,e){if(!b.cycle)return;const p=b.cycle,n=netAt(p,e.price);p.maximumAdverseExcursion=Math.max(p.maximumAdverseExcursion,-n,0);p.maximumFavorableExcursion=Math.max(p.maximumFavorableExcursion,n,0);p.highestPrice=Math.max(p.highestPrice,e.price);p.lowestPrice=Math.min(p.lowestPrice,e.price);p.netPnl=n;p.roi=roiAt(p,e.price);Audit.observe(p,e.price,n);}
function funding(b,rows,time){const p=b.cycle;if(!p)return;for(const f of rows||[]){if(f.time<=p.openedAt||f.time>time||p.fundingEvents.some(v=>v.time===f.time))continue;if(!Number.isFinite(f.rate)||!(f.markPrice>0))throw Error('FUNDING_DATA_INVALID');const qty=p.entries.filter(v=>v.time<f.time).reduce((n,v)=>n+v.qty,0)-p.exits.filter(v=>v.time<f.time).reduce((n,v)=>n+v.qty,0);if(qty<=1e-10)continue;const amount=-sign(p.side)*qty*f.markPrice*f.rate;p.fundingPnl+=amount;p.fundingEvents.push({...f,qty,amount});}refreshStop(p);}
function beginDay(b,time){const day=new Date(time).toISOString().slice(0,10);if(b.day?.day!==day){const baseline=b.cycle&&b.lastQuote?.price?netAt(b.cycle,b.lastQuote.price):0;b.day={day,equity:Math.max(0,b.equity+baseline),cycleBaseline:baseline,realized:0,locked:false};}}
function nextLayer(p){return p.layers.find(l=>l.status==='WAIT_SIGNAL');}
function qtyFloor(v,step){return Math.floor((v+1e-12)/step)*step;}
function submit(b,kind,side,qty,signal,e,meta={}){
 const number=++b.sequence,id=[b.accountId,b.cycle?.cycleId||'new',signal?.id||e.time,kind,number].join('|');
 const locked=b.cycle?.config||meta.config;meta={...meta,config:clone(locked),scope:meta.scope||b.cycle?.scope};
 const o={id,kind,side,qty,fills:[],filledQty:0,status:'SUBMITTED',submittedAt:e.time,executeAfter:e.time+(b.cycle?.config.executionDelayMs||meta.config.executionDelayMs),signalId:signal?.id||null,triggerSignalId:signal?.id||(['opposite_profit','opposite_max_adds','reverse_after_partial'].includes(meta.reason)?e.signal?.id:null)||null,cycleId:b.cycle?.cycleId||null,referencePrice:e.price,meta};
 if(kind==='partial'&&!b.cycle.partialTpStarted){b.cycle.partialTpStarted=true;b.cycle.partialTargetQty=qty;b.cycle.partialFilledQty=0;}
 if(kind==='partial'&&b.cycle.audit&&!b.cycle.audit.partialOrderIds.includes(id))b.cycle.audit.partialOrderIds.push(id);
 b.pending=o;b.orders.push(o);b.phase=kind==='open'?'ENTRY_PENDING':kind==='add'?'ADD_PENDING':kind==='partial'?'PARTIAL_TP_PENDING':meta.risk?'RISK_STOP':'EXIT_PENDING';
 if(signal)consume(b,signal);return decision(b,'ORDER_SUBMITTED',kind==='add'?'新同向信号补仓订单已提交':kind==='open'?'首仓模拟订单已提交':'保护退出订单已提交');
}
function settle(b,time,reason){const p=b.cycle;if(!p||p.qty>1e-10||b.pending)return;if(p.costDataIncomplete){b.phase='RECONCILING';b.riskLock=true;b.riskLockReason='COST_REVIEW_REQUIRED：仓位已退出，成本证据未完整核对，不结算或重开';return;}const net=round(realized(p));b.equity=round(b.equity+net);b.realizedNetPnl=round(b.realizedNetPnl+net);b.day.realized+=net;
 Audit.finalize(p);b.history.push({...clone(p),...p.scope,accountingStatus:p.costDataIncomplete?'COST_REVIEW_REQUIRED':'RECONCILED',accountId:b.accountId,symbol:p.symbol,exitTime:time,holdingDurationMs:time-p.openedAt,closeReason:reason,netPnl:net,grossPnl:p.realizedGross,tradingFee:p.entryFees+p.exitFees,roi:p.marginUsed?100*net/p.marginUsed:0,netR:p.riskBudget?net/p.riskBudget:null,equityAfter:b.equity,actualRiskAmount:p.riskBudget,entryPrice:p.averagePrice,exitPrice:p.lastExitPrice,MAE_R:p.maximumAdverseExcursion/p.riskBudget,MFE_R:p.maximumFavorableExcursion/p.riskBudget});
 b.cooldownUntil=time+p.config.cooldownBars*HOUR;b.cycle=null;b.phase='SETTLED';if(b.equity<=0){b.riskLock=true;b.riskLockReason='模拟权益耗尽';}decision(b,'SETTLED','本轮已完整结算，等待冷却与新信号');}
function guard(b,e,c){
 if(b.riskLock)return['RISK_LOCK',b.riskLockReason||'风险锁定'];
 if(b.day.locked)return['DAILY_LOSS','单日净亏损上限已触发'];
 if(!e.running)return['MONITOR_STOPPED','已暂停新开与补仓，保留仓位保护'];
 if(!e.marketOK)return['MARKET_BLOCK',e.marketReason||'行情、报价、资金费或交易规格未通过核验'];
 if(e.externalRiskLock)return['ACCOUNT_RISK_LOCK','账户风险锁未解除'];
 if(e.unknownOrder)return['UNKNOWN_ORDER','存在未知订单，禁止新增风险'];
 if(e.time<b.cooldownUntil)return['COOLDOWN','本轮止损或结算冷却中'];
 if(!e.signal)return['WAIT_SIGNAL','等待新的已收盘 MACD 信号'];
 if(e.signal.availableAt>e.time||e.time-e.signal.closedTime>c.signalMaxAgeMs)return['SIGNAL_STALE','信号未收盘或已过执行有效期'];
 if(used(b,e.signal))return['SIGNAL_USED','当前信号已使用，不重复下单'];
 if(b.lastSignalTime&&e.signal.closedTime-b.lastSignalTime<c.minSignalIntervalBars*HOUR)return['SIGNAL_INTERVAL','未达到最小信号间隔'];
 const date=new Date(e.time),hour=date.getUTCHours();if(!c.allowWeekends&&[0,6].includes(date.getUTCDay())||hour<c.sessionStartUtc||hour>=c.sessionEndUtc)return['SESSION_BLOCK','不在配置的 UTC 交易时段'];
 if(c.higherTimeframeFilter&&e.higherDirection!==e.signal.side)return['HIGHER_FILTER','4H 实验过滤未确认同向'];
 return null;
}
function stageEntry(b,e,c,layer){const p=b.cycle,side=p?.side||e.signal.side,base=p?.baseEquity||b.equity,marginPct=layer?.marginPct??c.firstMarginPct,rules=e.rules||{};
 if(!(rules.qtyStep>0&&rules.minQty>0&&rules.minNotional>0))return decision(b,'SPEC_INVALID','缺少永续合约最小数量、步长或名义金额');
 const qty=qtyFloor(base*marginPct*c.leverage/e.price,rules.qtyStep),notional=qty*e.price;
 if(qty<rules.minQty||notional<rules.minNotional||rules.maxQty&&qty>rules.maxQty)return decision(b,'SPEC_BLOCK','层级预算不满足交易所数量与名义金额规格，不自动放大');
 const budget=base*c.maxCycleLossPct;
 if(p?.marginUsed+notional/c.leverage>base*c.maxMarginPct+1e-8)return decision(b,'MARGIN_LIMIT','累计保证金预算已达上限');
 const fees=notional*(c.entryFeeRate+c.exitFeeRate+2*c.maxSlippageBps/10000);
 const simulated=p?clone(p):{side,qty:0,averagePrice:0,realizedGross:0,entryFees:0,exitFees:0,fundingPnl:0,riskBudget:budget,config:c,atr:e.signal.atr||null,stopPrice:null};
 const fill=e.price*(1+sign(side)*c.slippageBps/10000),total=simulated.qty+qty;
 simulated.averagePrice=(simulated.averagePrice*simulated.qty+fill*qty)/total;simulated.qty=total;simulated.entryFees+=fill*qty*c.entryFeeRate;refreshStop(simulated);
 const stressed={...simulated,config:{...c,slippageBps:c.maxSlippageBps}};
 const stop=simulated.stopPrice;
 if(fees>=budget||!Number.isFinite(stop)||(stop-e.price)*sign(side)>=0||-netAt(stressed,stop)>budget+1e-6)return decision(b,'ADD_RISK_LIMIT','压力滑点与止损风险超过本轮上限，拒绝本层，不扩大杠杆或放宽止损');
 const available=b.equity+(p?netAt(p,e.price):0)-(p?.marginUsed||0);
 if(notional/c.leverage+notional*c.entryFeeRate>available)return decision(b,'INSUFFICIENT_MARGIN','可用模拟保证金不足');
 const permit=e.permit?e.permit(budget,side):{allowed:false,reason:'组合风险未核验'};
 if(!permit.allowed)return decision(b,'PORTFOLIO_BLOCK',permit.reason||'组合风险禁止新增仓位');
 return submit(b,p?'add':'open',side,qty,e.signal,e,{layer:layer?.index||0,config:c,scope:C.scope(c,e.account),baseEquity:base,riskBudget:budget,atr:e.signal.atr||null,structureLow:e.signal.structureLow??null,structureHigh:e.signal.structureHigh??null,symbol:e.account.symbol,step:rules.qtyStep,priceTick:rules.priceTick||1e-8});
}
function advance(input,event,config){const b=clone(input),e=event,c=b.cycle?.config||b.pending?.meta?.config||C.normalize(config);b.lastEvaluatedAt=e.time;beginDay(b,e.time);
 if(!(e.price>0&&Number.isFinite(e.time)))return decision(b,'QUOTE_INVALID','无法获取合法报价；不伪造成交');
 if(e.unknownOrder){b.riskLock=true;b.riskLockReason='UNKNOWN_ORDER：订单无法核验';b.phase='RECONCILING';}
 funding(b,e.funding,e.time);mark(b,e);b.lastQuote={price:e.price,time:e.time,quoteTime:e.quoteTime??e.time};
 const p=b.cycle;
 if(p){
  const dailyNet=b.day.realized+netAt(p,e.price)-(b.day.cycleBaseline||0);
  const risk=netAt(p,e.price)<=-p.riskBudget||p.stopPrice!=null&&(e.price-p.stopPrice)*sign(p.side)<=0||dailyNet<=-b.day.equity*c.maxDailyLossPct||b.riskLock||e.externalRiskLock;
  if(dailyNet<=-b.day.equity*c.maxDailyLossPct)b.day.locked=true;
  if(risk){
   // Unknown/partially filled requests must reconcile, never pretend an exit was filled.
   if(b.pending&&b.pending.status!=='UNKNOWN'&&['open','add','partial'].includes(b.pending.kind)){b.pending.status='CANCELLED';b.pending.terminalAt=e.time;b.pending=null;}
   if(!b.pending&&p.qty>0)return submit(b,'exit',p.side,p.qty,null,e,{risk:true,reason:b.riskLock?'risk_lock':b.day.locked?'daily_loss':'hard_stop'});
  }
 }
 if(e.manualClose&&b.pending&&['open','add','partial'].includes(b.pending.kind)&&b.pending.status!=='UNKNOWN'){b.pending.status='CANCELLED';b.pending.terminalAt=e.time;b.pending=null;}
 if(b.pending)return decision(b,'ORDER_PENDING','订单待处理或核对，禁止重复提交');
 if(p?.qty===0){settle(b,e.time,p.lastExitReason);return b;}
 if(p){
  const opposite=e.signal&&e.signal.side!==p.side&&!used(b,e.signal),eligibleSignal=e.signal&&e.signal.availableAt<=e.time&&e.time-e.signal.closedTime<=c.signalMaxAgeMs;
  if(e.manualClose)return submit(b,'exit',p.side,p.qty,null,e,{reason:'manual_close'});
  if(eligibleSignal&&opposite){
   consume(b,e.signal);p.oppositeSignals.push({...e.signal,netPnl:netAt(p,e.price)});
   if(p.partialTpStarted||p.partialTpDone||netAt(p,e.price)>0&&c.exitOnOppositeWhenProfitable||!nextLayer(p))return submit(b,'exit',p.side,p.qty,null,e,{reason:p.partialTpDone?'reverse_after_partial':netAt(p,e.price)>0?'opposite_profit':'opposite_max_adds'});
  }
  if(c.partialTakeProfitEnabled&&!p.partialTpDone&&(p.partialTpStarted||roiAt(p,e.price)>=c.takeProfitRoiPct)){
   const qty=qtyFloor(p.partialTpStarted?p.partialTargetQty-p.partialFilledQty:p.qty*c.partialClosePct/100,p.qtyStep);
   if(qty>=p.qtyStep&&p.qty-qty>=p.qtyStep)return submit(b,'partial',p.side,qty,null,e,{reason:'roi_partial'});
   return decision(b,'PARTIAL_QTY_BLOCK','半仓数量低于合约精度，保持原仓位与止损保护');
  }
  if(p.partialTpDone){b.phase='WAIT_REVERSE_EXIT';return decision(b,'WAIT_REVERSE_EXIT','已分批止盈，禁止补仓，等待新的反向 MACD 信号');}
  const error=guard(b,e,c);if(error)return decision(b,...error);
  if(e.signal.side!==p.side)return decision(b,'WAIT_ADD_SIGNAL','亏损反向信号已记录，等待新的同向信号；硬止损持续有效');
  if(netAt(p,e.price)>=-p.marginUsed*c.minAddLossPct)return decision(b,'NOT_LOSING','整体仓位未达到补仓亏损门槛');
  const layer=nextLayer(p);if(!layer){b.phase='MAX_ADDS_REACHED';return decision(b,'MAX_ADDS_REACHED','已完成全部允许补仓，等待反向信号或风险退出');}
  if(Math.abs(e.price-p.lastEntryPrice)/p.lastEntryPrice<c.minAddPriceDistancePct)return decision(b,'ADD_DISTANCE','未达到最小补仓价格距离');
  b.phase='WAIT_ADD_SIGNAL';return stageEntry(b,e,c,layer);
 }
 if(e.manualClose)return decision(b,'FLAT','当前空仓');
 if(b.day.realized-(b.day.cycleBaseline||0)<=-b.day.equity*c.maxDailyLossPct)b.day.locked=true;
 const error=guard(b,e,c);if(error){if(error[0]==='COOLDOWN')b.phase='COOLDOWN';else if(!b.riskLock)b.phase='WAIT_SIGNAL';return decision(b,...error);}
 if(c.tradeDirection==='LONG_ONLY'&&e.signal.side!=='long'||c.tradeDirection==='SHORT_ONLY'&&e.signal.side!=='short')return decision(b,'DIRECTION_FILTER','信号不在允许交易方向内');
 return stageEntry(b,e,c,null);
}
function execute(input,event,result={}){const b=clone(input),o=b.pending;if(!o)return b;
 if(event.time<o.executeAfter)return b;
 funding(b,event.funding,event.time);
 if(result.status==='UNKNOWN'){b.riskLock=true;b.riskLockReason='UNKNOWN_ORDER：模拟执行结果未知';o.status='UNKNOWN';b.phase='RECONCILING';return decision(b,'UNKNOWN_ORDER',b.riskLockReason);}
 if(o.status==='UNKNOWN')return decision(b,'RECONCILING','未知订单须审计核验，不自动清空');
 const c=b.cycle?.config||o.meta.config,entry=['open','add'].includes(o.kind);
 if(result.status==='REJECTED'||entry&&(!event.marketOK||!event.running||b.riskLock||event.time-o.submittedAt>c.signalMaxAgeMs)){
  o.status='REJECTED';o.terminalAt=event.time;o.reason=result.reason||'执行时行情、时效或运行许可已变化';b.pending=null;return decision(b,'ORDER_REJECTED',o.reason);
 }
 if(event.quoteId&&(o.consumedQuoteIds||[]).includes(event.quoteId))return decision(b,'QUOTE_EVIDENCE_USED','同一报价证据已使用，等待新的模拟成交证据');
 if(!(event.price>0))return decision(b,'QUOTE_INVALID','没有有效报价，不模拟成交');
 const actualSlippage=result.slippageBps??c.slippageBps;
 if(entry&&actualSlippage>c.maxSlippageBps){o.status='REJECTED';o.terminalAt=event.time;b.pending=null;return decision(b,'SLIPPAGE_BLOCK','执行滑点超过上限');}
 const executePrice=result.price||event.price;
 const allocation=o.meta.baseEquity*C.layers(c)[o.meta.layer]*c.leverage;
 const cap=entry?Math.min(o.qty-o.filledQty,allocation/(executePrice*(1+sign(o.side)*actualSlippage/10000))):o.qty-o.filledQty;
 const qty=qtyFloor(Math.min(cap,cap*(result.fillFraction??1)),o.meta.step||b.cycle?.qtyStep||1e-8);
 if(!(qty>0))return decision(b,'NO_FILL','没有可证明的模拟成交数量');
 const price=executePrice*(1+sign(o.side)*(entry?1:-1)*actualSlippage/10000),fee=price*qty*(entry?c.entryFeeRate:c.exitFeeRate);
 if(o.kind==='open'&&!b.cycle){b.cycle={cycleId:b.accountId+':'+o.id,config:clone(c),scope:o.meta.scope,symbol:o.meta.symbol,baseEquity:o.meta.baseEquity,riskBudget:o.meta.riskBudget,side:o.side,qty:0,qtyStep:o.meta.step,priceTick:o.meta.priceTick||1e-8,averagePrice:0,openedAt:event.time,marginUsed:0,entryFees:0,exitFees:0,realizedGross:0,fundingPnl:0,fundingEvents:[],partialTpDone:false,layers:C.layers(c).map((pct,index)=>({index,marginPct:pct,marginBudget:o.meta.baseEquity*pct,status:pct>0?'WAIT_SIGNAL':'DISABLED',filledQty:0})),entries:[],exits:[],oppositeSignals:[],atr:o.meta.atr,structureLow:o.meta.structureLow,structureHigh:o.meta.structureHigh,stopPrice:null,maximumAdverseExcursion:0,maximumFavorableExcursion:0,highestPrice:price,lowestPrice:price};}
 const p=b.cycle;
 if(entry){
  const prior=p.qty;p.averagePrice=(p.averagePrice*prior+price*qty)/(prior+qty);p.qty+=qty;p.entryFees+=fee;p.marginUsed+=price*qty/c.leverage;p.lastEntryPrice=price;
  const layer=p.layers[o.meta.layer];Object.assign(layer,{filledQty:layer.filledQty+qty,price,signalId:o.signalId,orderId:o.id,status:qty<o.qty?'PARTIALLY_FILLED_FINAL':'FILLED',executedAt:event.time});
  p.entries.push({layer:o.meta.layer,time:event.time,qty,price,notional:price*qty,margin:price*qty/c.leverage,fee,signalId:o.signalId,orderId:o.id,netPnlBeforeAdd:netAt(input.cycle,event.price),slippageBps:actualSlippage});refreshStop(p);Audit.entry(p,event.price,event.time,netAt(p,event.price),Math.max(0,-netAt({...p,config:{...c,slippageBps:c.maxSlippageBps}},p.stopPrice)));b.phase='POSITION_OPEN';
 }else{
  const close=Math.min(qty,p.qty);p.realizedGross+=(price-p.averagePrice)*close*sign(p.side);p.exitFees+=fee;p.qty=round(p.qty-close);p.lastExitPrice=price;p.lastExitReason=o.meta.reason;
  p.exits.push({time:event.time,qty:close,price,fee,reason:o.meta.reason,orderId:o.id,slippageBps:actualSlippage});
  if(o.kind==='partial'){p.partialTpStarted=true;p.partialFilledQty=(p.partialFilledQty||0)+close;b.phase='PARTIAL_TP_PENDING';}
 }
 if(event.quoteId){o.consumedQuoteIds||=[];o.consumedQuoteIds.push(event.quoteId);}
 o.filledQty+=qty;o.lastFillTime=event.time;o.fills||=[];o.fills.push({id:o.id+':fill:'+o.fills.length,time:event.time,qty,price,fee,cumulativeQty:o.filledQty,quoteId:event.quoteId||null});
 // Entries use one bounded fill and cancel the unfilled remainder. Polling never creates more entry evidence.
 const terminal=entry||o.filledQty>=o.qty-1e-10||p.qty<=1e-10;
 if(o.kind==='partial'&&terminal){p.partialTpDone=true;b.phase='WAIT_REVERSE_EXIT';}
 o.status=o.filledQty>=o.qty-1e-10?'FILLED':terminal?'PARTIALLY_FILLED_CANCELLED':'PARTIALLY_FILLED';
 if(terminal){o.terminalAt=event.time;b.pending=null;}
 mark(b,event);if(p.qty<=1e-10){b.pending=null;settle(b,event.time,p.lastExitReason);}else refreshStop(p);
 return decision(b,'ORDER_FILLED',entry?'模拟成交已记录；按真实模拟数量管理风险':'模拟退出成交已记录');
}
function exposure(b){const p=b?.cycle,o=b?.pending;if(!p&&!o)return{};return{position:p?{side:p.side,positionSize:p.qty,filledQty:p.qty,initialEffectiveRiskU:p.riskBudget}:null,pendingOrder:o&&['open','add'].includes(o.kind)?{kind:p?'add':'open',side:o.side,plan:{initialEffectiveRiskU:p?0:o.meta.riskBudget}}:null};}
module.exports={initial,netAt,roiAt,lossStop,refreshStop,advance,execute,exposure,settle,qtyFloor};
