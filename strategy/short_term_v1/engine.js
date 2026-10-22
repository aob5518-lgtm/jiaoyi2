"use strict";
// Independent, non-executable Shadow experiment. No exchange client or order API.
const crypto=require("crypto"),V1=require("../../trend_only");
const {getEstimatedTradeCost,PLATFORM_DEFAULTS}=require("../../trade_cost");
const {calculatePositionSize}=require("../trend_v3/position_sizing");
const VERSION="short_term_v1",REVISION="SHORT_TERM_20261023_SHADOW_A",EXPERIMENT="SHORT_TERM_STD_20261018_A";
const SETUPS=["momentum_breakout","pullback_continuation","range_reversal"];
const DEFAULTS=Object.freeze({enabled:true,entryTimeframe:"5m",backgroundTimeframe:"15m",allowLive:false,sampleType:"shadow",riskPerTrade:.0025,gradeA:82,gradeB:74,leverage:5,maxPositionRatio:.25,maxNotional:100000,maxDailyLossRatio:.02,maxConsecutiveLosses:3,cooldownBars:6,maxHoldingBars:24,minimumPotentialNetR:1.5,maxCostR:.25,stopBufferAtr:.3,minStopAtr:1,maxStopAtr:2.5,maxExtensionAtr:1.5,paperStopSlippageBps:5,fundingRateEstimate:.0001,entryModes:SETUPS});
function normalizeConfig(raw={}){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("Short-Term config must be an object");
 const c=Object.fromEntries(Object.keys(DEFAULTS).map(k=>[k,raw[k]??DEFAULTS[k]]));
 for(const [k,v]of Object.entries(DEFAULTS))if(typeof v==="number"&&(!Number.isFinite(Number(c[k]))||Number(c[k])<=0))throw Error("Short-Term invalid parameter: "+k);else if(typeof v==="number")c[k]=Number(c[k]);
 if(c.riskPerTrade>.005||c.leverage>10||c.maxPositionRatio>1||c.maxDailyLossRatio>1||c.gradeA>100||c.gradeB>=c.gradeA)throw Error("Short-Term risk/grade bounds");
 if(!Array.isArray(c.entryModes)||c.entryModes.some(x=>!SETUPS.includes(x)))throw Error("Short-Term setup configuration");
 c.entryModes=[...c.entryModes];c.entryTimeframe="5m";c.backgroundTimeframe="15m";c.allowLive=false;c.sampleType="shadow";c.enabled=raw.enabled!==false;
 c.strategyVersion=VERSION;c.strategyRevision=REVISION;c.experimentId=EXPERIMENT;
 return c;
}
function scopeFor(c,market={}){return{strategyVersion:VERSION,strategyRevision:REVISION,experimentId:EXPERIMENT,configHash:crypto.createHash("sha256").update(JSON.stringify({config:normalizeConfig(c),symbol:market.symbol||null,platform:market.platform||null})).digest("hex")};}
function initialState(equity,now=Date.now()){return{equity:Number(equity),startedAt:now,position:null,pendingOrder:null,journal:[],signals:[],lastSignalTime:0,dailyDate:"",dailyLoss:0,consecutiveLosses:0,pauseUntil:0,orderPermission:false};}
function mean(rows){return rows.length?rows.reduce((a,b)=>a+b,0)/rows.length:0;}
function indicators(raw,tf,now){
 const ms=V1.INTERVALS[tf],rows=(raw||[]).filter(c=>Number(c.time)+ms<=now).map(c=>({...c,time:Number(c.time),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)})).sort((a,b)=>a.time-b.time);
 if(rows.length<80)throw Error("已收盘行情不足");
 for(let n=0;n<rows.length;n++){const x=rows[n];if(![x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)||x.time%ms!==0||x.low<=0||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close)||(n&&x.time-rows[n-1].time!==ms))throw Error("K线缺口或无效");}
 if(rows.at(-1).time!==Math.floor(now/ms)*ms-ms)throw Error("行情过期或周期错位");
 const ema=p=>{let v=rows[0].close;return rows.map(x=>v+=(x.close-v)*2/(p+1));},fast=ema(20),mid=ema(50);
 const tr=rows.slice(1).map((x,n)=>Math.max(x.high-x.low,Math.abs(x.high-rows[n].close),Math.abs(x.low-rows[n].close))),atr=mean(tr.slice(-14));
 if(!(atr>0))throw Error("ATR无效");
 const last=rows.at(-1),slope=fast.at(-1)-fast.at(-4),dir=fast.at(-1)>mid.at(-1)&&slope>atr*.05?"long":fast.at(-1)<mid.at(-1)&&slope<-atr*.05?"short":"none";
 const prior=rows.slice(-21,-1),high=Math.max(...prior.map(x=>x.high)),low=Math.min(...prior.map(x=>x.low));
 return{rows,last,atr,fast:fast.at(-1),mid:mid.at(-1),emaHistory:fast,slope,dir,high,low,width:high-low,efficiency:Math.abs(last.close-rows.at(-21).close)/Math.max(1e-12,tr.slice(-20).reduce((a,b)=>a+b,0))};
}
function costs(account,config,notional=1){
 if(!PLATFORM_DEFAULTS[account.platform])return{status:"incomplete",reason:"未知平台成本模型"};
 const model=getEstimatedTradeCost({...account,paper:true},"short_term_v1"),funding=Number(config.fundingRateEstimate);
 if(![model.entryFeeRate,model.exitFeeRate,model.expectedSlippageRate,funding].every(x=>Number.isFinite(x)&&x>=0))return{status:"incomplete",reason:"成本估算不完整"};
 const exitSlip=Math.max(model.estimatedExitSlippage,config.paperStopSlippageBps/10000);
 const rate=model.entryFeeRate+model.exitFeeRate+model.estimatedEntrySlippage+exitSlip+funding;
 return{...model,status:"estimated",fundingStatus:"estimated_reserve_not_actual_funding",estimatedEntryFee:notional*model.entryFeeRate,estimatedExitFee:notional*model.exitFeeRate,estimatedSlippage:notional*(model.estimatedEntrySlippage+exitSlip),estimatedFunding:notional*funding,fundingEstimate:notional*funding,expectedSlippageRate:model.estimatedEntrySlippage+exitSlip,roundTripCostU:notional*rate,roundTripCostRate:rate,roundTripCostPct:rate,estimatedExitSlippage:exitSlip};
}
function analyze({entryCandles,backgroundCandles,now=Date.now(),account,config=normalizeConfig(),price,source="unknown"}){
 const scope=scopeFor(config,account),base={...scope,timestamp:now,time:null,dataStatus:"invalid",candidates:[],sampleType:"shadow",orderPermission:false};
 let e,b;try{e=indicators(entryCandles,"5m",now);b=indicators(backgroundCandles,"15m",now);}catch(error){return{...base,time:Math.floor(now/300000)*300000-300000,timestamp:Math.floor(now/300000)*300000-300000,finalDecision:"BLOCKED",primaryBlocker:error.message};}
 const x=e.last,prev=e.rows.at(-2),atr=e.atr,sign=e.dir==="short"?-1:1,body=Math.abs(x.close-x.open),compression=mean(e.rows.slice(-7,-1).map(c=>c.high-c.low))<mean(e.rows.slice(-21,-7).map(c=>c.high-c.low))*.8;
 const volumeRows=e.rows.slice(-21,-1),volumeTrusted=source!=="unknown"&&[x,...volumeRows].every(c=>Number.isFinite(Number(c.volume))&&Number(c.volume)>0),volumeGood=volumeTrusted&&Number(x.volume)>mean(volumeRows.map(c=>Number(c.volume)))*1.2;
 const expansion=x.high-x.low>atr*1.2,range=e.efficiency<.25&&Math.abs(b.slope)<b.atr*.15&&Math.abs(b.fast-b.mid)<b.atr*.5;
 const defs=[{type:"momentum_breakout",side:x.close>e.high?"long":x.close<e.low?"short":e.dir,trigger:(x.close>e.high||x.close<e.low)&&body>atr*.35&&(compression||expansion),level:x.close>e.high?e.high:e.low,quality:compression?20:12},
 {type:"pullback_continuation",side:e.dir,trigger:e.dir!=="none"&&e.rows.slice(-5,-1).some((c,n)=>c.low<=e.emaHistory[e.rows.length-5+n]+atr*.2&&c.high>=e.emaHistory[e.rows.length-5+n]-atr*.2)&&sign*(x.close-prev[sign>0?"high":"low"])>0&&sign*(x.close-x.open)>0&&sign*(x.close-e.fast)>0,level:e.fast,quality:body>atr*.4?20:14},
 {type:"range_reversal",side:x.low<=e.low+atr*.2?"long":"short",trigger:range&&((x.low<=e.low+atr*.2&&x.close>e.low+atr*.35&&x.close>x.open&&x.close>prev.close)||(x.high>=e.high-atr*.2&&x.close<e.high-atr*.35&&x.close<x.open&&x.close<prev.close)),level:x.low<=e.low+atr*.2?e.low:e.high,quality:range?20:0}];
 const pullback=defs.find(d=>d.type==="pullback_continuation");
 pullback.trigger=pullback.trigger&&(pullback.side==="long"?x.low>=e.low-atr*.2:x.high<=e.high+atr*.2);
 const quote=Number(price),cost=costs(account,config),candidates=[];
 for(const d of defs.filter(d=>config.entryModes.includes(d.type))){
  const direction=d.side,s=direction==="long"?1:-1,blockers=[];
  if(!["long","short"].includes(direction))blockers.push("没有短周期方向");
  if(!d.trigger)blockers.push("等待已收盘形态确认");
  if(direction!=="none"&&b.dir!=="none"&&b.dir!==direction)blockers.unshift("15m与5m方向冲突");
  if(d.type==="range_reversal"&&(!range||b.dir!=="none"))blockers.unshift("非确认区间或高周期强趋势，禁止逆势反转");
  if(!(quote>0)||Math.abs(quote-x.close)>atr*.5)blockers.unshift("执行报价缺失或跨场所基差过大");
  const entry=quote>0?quote:x.close,local=e.rows.slice(-6),structure=direction==="long"?Math.min(...local.map(c=>c.low)):Math.max(...local.map(c=>c.high));
  const distance=Math.max(atr*config.minStopAtr,s*(entry-structure)+atr*config.stopBufferAtr),stop=entry-s*distance;
  if(!(distance>0&&distance<=atr*config.maxStopAtr&&stop>0&&s*(entry-stop)>0))blockers.push("局部结构止损无效或过远");
  if(d.type!=="range_reversal"&&Math.abs(entry-d.level)>atr*config.maxExtensionAtr)blockers.push("远离确认位，不追单");
  const relevant=b.rows.slice(-48,-1).map(c=>direction==="long"?c.high:c.low).filter(v=>s*(v-entry)>atr*.2);
  const target=d.type==="range_reversal"?(direction==="long"?e.high:e.low):relevant.length?(direction==="long"?Math.min(...relevant):Math.max(...relevant)):null;
  const potentialGrossR=target===null?null:s*(target-entry)/distance,costR=cost.status==="incomplete"?null:entry*cost.roundTripCostRate/(distance+entry*cost.roundTripCostRate),potentialNetR=target===null||costR===null?null:(s*(target-entry)-entry*cost.roundTripCostRate)/(distance+entry*cost.roundTripCostRate);
  if(costR===null)blockers.push("成本未知，不允许按零处理");else if(costR>config.maxCostR)blockers.push("短周期成本超过上限");
  if(potentialNetR===null||potentialNetR<config.minimumPotentialNetR)blockers.push("净结构空间不足");
  const parts={background:b.dir===direction?15:b.dir==="none"?7:0,pattern:d.trigger?d.quality:0,momentum:Math.min(10,body/atr*8)+(expansion&&body/Math.max(x.high-x.low,1e-12)>.5?5:0),confirmation:d.trigger?15:0,space:potentialNetR===null?0:Math.min(15,Math.max(0,potentialNetR)*5),cost:costR===null?0:Math.max(0,15*(1-costR/config.maxCostR)),dataExecution:volumeGood?10:volumeTrusted?6:3};
  const score=Math.min(100,Object.values(parts).reduce((a,b)=>a+b,0)),grade=score>=config.gradeA?"A":score>=config.gradeB?"B":null,riskMultiplier=(grade==="A"?1:grade==="B"?.5:0)*(b.dir==="none"?.5:1);
  if(!grade)blockers.push("短周期评分不足");
  candidates.push({...d,side:direction,triggered:!!d.trigger,entryPrice:entry,initialStopLossPrice:stop,stopDistance:distance,atr,score,scoreBreakdown:parts,grade,riskMultiplier,potentialGrossR,potentialNetR,roundTripCostR:costR,costStatus:cost.status,costModel:cost,volumeStatus:volumeTrusted?"observed":"unavailable_score_reduced",blockers,allowed:blockers.length===0});
 }
 const selected=candidates.filter(c=>c.allowed).sort((a,b)=>b.score-a.score)[0]||null;
 return{...base,dataStatus:"healthy",time:x.time,timestamp:x.time,backgroundTime:b.last.time,direction:b.dir,marketRegime:range?"range":"directional",source,candidates,selected,finalDecision:selected?"READY":candidates.some(c=>c.triggered)?"BLOCKED":"WAIT",primaryBlocker:selected?null:candidates.find(c=>c.triggered)?.blockers[0]||"等待短周期形态确认"};
}

function plan(candidate,account,config,constraints={}){
 if(!candidate?.allowed)return{allowed:false,reason:"候选不合格"};
 if(!(Number(constraints.qtyStep)>0&&Number(constraints.minNotional)>0))return{allowed:false,reason:"交易所精度或最小名义金额未知"};
 const result=calculatePositionSize({equity:account.equity,available:account.available,entryPrice:candidate.entryPrice,stopDistance:candidate.stopDistance,riskPerTrade:config.riskPerTrade,riskMultiplier:candidate.riskMultiplier,costRate:candidate.costModel.roundTripCostRate,leverage:config.leverage,maxPositionRatio:Math.min(config.maxPositionRatio,config.maxNotional/(account.equity*config.leverage)),...constraints});
 if(result.allowed&&(constraints.minQty&&result.qty<constraints.minQty||constraints.maxQty&&result.qty>constraints.maxQty))return{allowed:false,reason:"交易所数量上下限"};
 return{...result,side:candidate.side,candidate};
}
function updatePostHoc(book,candles,now=Date.now()){
 const {fullWindow}=require("../trend_v3/quality_audit");
 const closed=(candles||[]).filter(c=>Number(c.time)+300000<=now);
 for(const v of book.journal||[])for(const n of [8,16,32]){
  if(v["PostExitMFE_R_"+n]!=null)continue;const rows=fullWindow(closed,v.exitTime,n,300000,false,now);if(!rows)continue;
  const s=v.side==="long"?1:-1,risk=v.initialEffectiveRiskU/v.positionSize;
  v["PostExitMFE_R_"+n]=Math.max(0,...rows.map(c=>s>0?c.high-v.exitPrice:v.exitPrice-c.low))/risk;v.postExitPostHocOnly=true;
 }
 for(const d of book.signals||[])for(const c of d.candidates||[]){
  if(!c.triggered||d.finalDecision==="ENTERED_SHADOW")continue;c.postHocOutcomes||={};
  for(const n of [8,16,32]){if(c.postHocOutcomes[n])continue;const rows=fullWindow(closed,d.evaluatedAt,n,300000,false,now);if(!rows)continue;const s=c.side==="long"?1:-1,unit=c.stopDistance+c.entryPrice*(c.costModel?.roundTripCostRate||0);if(!(unit>0))continue;
   const mfe=Math.max(0,...rows.map(r=>s>0?r.high-c.entryPrice:c.entryPrice-r.low))/unit,mae=Math.max(0,...rows.map(r=>s>0?c.entryPrice-r.low:r.high-c.entryPrice))/unit;c.postHocOutcomes[n]={postHocOnly:true,mfe,mae,missedTrend:mfe>=2&&mae<=.75};
  }
 }
}
function tick(book,signal,{account,config,price,now=Date.now(),constraints={},monitorRunning=true,realPosition=null,realPending=null,v3Candidate=null,portfolioAllowed=()=>({allowed:false,reason:"组合风控不可用"})}){
 book.orderPermission=false;book.lastTickAt=now;
 if(!(Number(price)>0&&Number.isFinite(Number(price)))){book.lastError="无有效执行报价，保留仓位与止损";return book;}
 const day=new Date(now).toISOString().slice(0,10);if(book.dailyDate!==day){book.dailyDate=day;book.dailyLoss=0;book.dayStartEquity=book.equity;}
 if(book.position){
  const p=book.position,s=p.side==="long"?1:-1,x=Number(price),oldStop=p.currentStopLossPrice;
  p.highestPrice=Math.max(p.highestPrice,x);p.lowestPrice=Math.min(p.lowestPrice,x);p.MFE_R=Math.max(p.MFE_R,s*(x-p.entryPrice)/p.stopDistance);p.MAE_R=Math.max(p.MAE_R,-s*(x-p.entryPrice)/p.stopDistance);
  const hit=s*(x-oldStop)<=0,timeout=now-p.entryTime>=config.maxHoldingBars*300000;
  if(hit||timeout){
   const fill=hit?require("../../trend_runtime").paperStopFill({side:p.side,stopPrice:oldStop,currentPrice:x,previousPrice:book.lastPrice,slippageBps:config.paperStopSlippageBps}):{stopExecutionPrice:x*(1-s*p.costModel.estimatedExitSlippage)};
   const exit=fill.stopExecutionPrice,gross=s*(exit-p.entryPrice)*p.positionSize,entryFee=p.entryPrice*p.positionSize*p.costModel.entryFeeRate,exitFee=exit*p.positionSize*p.costModel.exitFeeRate,fundingPnl=-p.entryPrice*p.positionSize*config.fundingRateEstimate,net=gross-entryFee-exitFee+fundingPnl;
   const v={...p,...fill,id:crypto.randomUUID(),exitPrice:exit,exitTime:now,holdingDurationMs:now-p.entryTime,grossPnl:gross,tradingFee:entryFee+exitFee,fundingPnl,netPnl:net,pnl:net,grossR:gross/p.initialEffectiveRiskU,netR:net/p.initialEffectiveRiskU,costR:(entryFee+exitFee-fundingPnl)/p.initialEffectiveRiskU,closeReason:hit?(p.protected?"trend_tp":"hard_sl"):"time_stop",costSource:"shadow_estimated_platform_fees_and_funding_reserve",sampleType:"shadow",paper:true,orderPermission:false};
   const entrySlip=Math.abs(p.entryPrice-(p.referenceEntryPrice??p.entryPrice))*p.positionSize,exitSlip=Math.abs(exit-(hit?oldStop:x))*p.positionSize;
   Object.assign(v,{finalStopLossPrice:oldStop,maximumFavorableExcursion:p.MFE_R*p.stopDistance,maximumAdverseExcursion:p.MAE_R*p.stopDistance,highestPriceSinceEntry:p.highestPrice,lowestPriceSinceEntry:p.lowestPrice,feeDrag:Math.abs(gross)>0?(entryFee+exitFee)/Math.abs(gross):null,slippageDrag:(entrySlip+exitSlip)/p.initialEffectiveRiskU,fundingDrag:-fundingPnl/p.initialEffectiveRiskU,embeddedSlippageU:entrySlip+exitSlip,slippageAlreadyInFillPrices:true,totalCostU:entryFee+exitFee-fundingPnl+entrySlip+exitSlip});
   v.costR=v.totalCostU/p.initialEffectiveRiskU;
   book.journal.push(v);book.position=null;book.equity+=net;book.dailyLoss=Math.max(0,book.dayStartEquity-book.equity);book.consecutiveLosses=net<0?book.consecutiveLosses+1:0;book.pauseUntil=now+config.cooldownBars*300000;if(book.consecutiveLosses>=config.maxConsecutiveLosses){book.pauseUntil=now+config.cooldownBars*2*300000;book.consecutiveLosses=0;}
  }else if(signal.dataStatus==="healthy"&&signal.time>Number(p.lastManagedSignalTime||0)){
   p.lastManagedSignalTime=signal.time;const r=s*(x-p.entryPrice)/p.stopDistance;
   let next=oldStop;const breakEven=require("../trend_v3/costs").calculateNetBreakEvenStop(p,config);
   if(r>=1.5&&breakEven){next=breakEven.trigger;p.protected=true;}if(r>=2.5)next=p.entryPrice+s*p.stopDistance*.8;if(r>=3)next=(s>0?p.highestPrice:p.lowestPrice)-s*p.atr*1.5;
   p.currentStopLossPrice=s>0?Math.max(oldStop,Math.min(next,x-p.atr*.5)):Math.min(oldStop,Math.max(next,x+p.atr*.5));
   if(p.currentStopLossPrice!==oldStop)p.stopTransitions.push({time:now,signalTime:signal.time,from:oldStop,to:p.currentStopLossPrice,reason:r>=3?"TRAIL":r>=2.5?"LOCK_PROFIT":"NET_BREAK_EVEN"});
  }
 }
 if(signal.time&&signal.time!==book.lastSignalTime){
  const decision={...signal,evaluatedAt:now,accountId:account.id,symbol:account.symbol,orderPermission:false,sampleType:"shadow"};
  const reason=!monitorRunning?"趋势监控已停止":book.position?"短周期已有仓位":book.pendingOrder?"Shadow订单尚未确认":realPending?"真实订单尚未确认":realPosition?"V3已有同标的仓位":v3Candidate?.allowed?"高质量V3候选优先":book.riskLock?"短周期风险锁":now<book.pauseUntil?"短周期冷却":book.dailyLoss>=book.dayStartEquity*config.maxDailyLossRatio?"短周期日亏损限制":null;
  const p=signal.selected&&!reason?plan(signal.selected,{...account,equity:book.equity,available:Math.min(book.equity,account.available)},config,constraints):null;
  const risk=p?.allowed?portfolioAllowed(p):null;
  if(p?.allowed&&risk?.allowed){
   const c=p.candidate,s=p.side==="long"?1:-1,entry=c.entryPrice*(1+s*c.costModel.estimatedEntrySlippage),stop=c.initialStopLossPrice,unit=s*(entry-stop)+entry*c.costModel.roundTripCostRate;
   p.qty=Math.floor(Math.min(p.qty,p.riskBudgetU/unit)/constraints.qtyStep)*constraints.qtyStep;
   const effective=p.qty*unit,fillRisk=portfolioAllowed({...p,initialEffectiveRiskU:effective});
   if(!(p.qty>0&&p.qty>=Number(constraints.minQty||0)&&p.qty<=Number(constraints.maxQty||Infinity)&&p.qty*entry>=constraints.minNotional&&p.qty*entry<=config.maxNotional&&fillRisk?.allowed)){decision.finalDecision="BLOCKED";decision.primaryBlocker=fillRisk?.reason||"成交后数量或组合风险不合法";book.signals.push(decision);book.lastSignalTime=signal.time;book.lastPrice=Number(price);return book;}
   if(s*(entry-stop)>0&&effective<=p.riskBudgetU+1e-8){book.position={...scopeFor(config,account),accountId:account.id,symbol:account.symbol,platform:account.platform,side:p.side,entryMode:c.type,entryTime:now,signalTime:signal.time,entryPrice:entry,positionSize:p.qty,initialStopLossPrice:stop,currentStopLossPrice:stop,stopDistance:s*(entry-stop),atr:c.atr,atrAtEntry:c.atr,costModel:c.costModel,initialEffectiveRiskU:effective,actualRiskAmount:effective,actualRiskRatio:effective/book.equity,plannedRiskAmount:p.riskBudgetU,score:c.score,grade:c.grade,scoreBreakdown:c.scoreBreakdown,potentialNetR:c.potentialNetR,whyEntered:c.type+" 已收盘确认",highestPrice:entry,lowestPrice:entry,MFE_R:0,MAE_R:0,diagnostic:signal,stopTransitions:[],sampleType:"shadow",orderPermission:false};decision.finalDecision="ENTERED_SHADOW";}else{decision.finalDecision="BLOCKED";decision.primaryBlocker="成交滑点后止损风险不合法";}
   if(book.position&&decision.finalDecision==="ENTERED_SHADOW"){
    const pos=book.position;pos.referenceEntryPrice=c.entryPrice;pos.marketRegime=signal.marketRegime;
    pos.costModel=costs(account,config,pos.entryPrice*pos.positionSize);
    for(const key of ["estimatedEntryFee","estimatedExitFee","estimatedSlippage","estimatedFunding","roundTripCostU"])pos[key]=pos.costModel[key];
    pos.roundTripCostR=pos.roundTripCostU/pos.initialEffectiveRiskU;pos.potentialGrossR=c.potentialGrossR;
   }
  }else if(reason||p&&!p.allowed||risk&&!risk.allowed){decision.finalDecision="BLOCKED";decision.primaryBlocker=reason||p.reason||risk.reason;}
  book.signals.push(decision);book.lastSignalTime=signal.time;
 }
 book.lastPrice=Number(price);book.signals=book.signals.slice(-5000);book.journal=book.journal.slice(-2000);
 return book;
}
module.exports={VERSION,REVISION,EXPERIMENT,DEFAULTS,SETUPS,normalizeConfig,scopeFor,initialState,indicators,costs,analyze,plan,updatePostHoc,tick};
