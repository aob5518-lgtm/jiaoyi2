"use strict";
const {normalize,scope}=require("./config"),{PLATFORM_DEFAULTS,getEstimatedTradeCost}=require("../../trade_cost");
const MS={"1h":3600000,"4h":14400000,"1d":86400000};
function series(raw,tf,now,c){
 const ms=MS[tf],rows=(raw||[]).filter(v=>Number(v.time)+ms<=now).map(v=>({...v,time:Number(v.time),open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close)})).sort((a,b)=>a.time-b.time);
 if(rows.length<210)throw Error(tf+" 已收盘指标数据不足（需210根）");
 rows.forEach((v,n)=>{if(![v.time,v.open,v.high,v.low,v.close].every(Number.isFinite)||v.low<=0||v.time%ms||v.high<Math.max(v.open,v.close)||v.low>Math.min(v.open,v.close)||(n&&v.time-rows[n-1].time!==ms))throw Error(tf+" 数据缺口或周期错位");});
 if(rows.at(-1).time!==Math.floor(now/ms)*ms-ms)throw Error(tf+" 数据过期");
 const ema=period=>{let value=rows[0].close;return rows.map(v=>value+=(v.close-value)*2/(period+1));},e20=ema(20),e50=ema(50),e200=ema(200),tr=rows.slice(1).map((v,n)=>Math.max(v.high-v.low,Math.abs(v.high-rows[n].close),Math.abs(v.low-rows[n].close)));
 const atr=tr.slice(-c.atrPeriod).reduce((a,b)=>a+b,0)/c.atrPeriod;if(!(atr>0))throw Error(tf+" ATR无效");
 const swings=[];for(let n=2;n<rows.length-2;n++){const x=rows[n],neighbours=[rows[n-2],rows[n-1],rows[n+1],rows[n+2]];if(neighbours.every(v=>x.low<v.low))swings.push({kind:"low",price:x.low,time:x.time,confirmedAt:rows[n+2].time+ms});if(neighbours.every(v=>x.high>v.high))swings.push({kind:"high",price:x.high,time:x.time,confirmedAt:rows[n+2].time+ms});}
 let gain=0,loss=0;for(let n=rows.length-14;n<rows.length;n++){const delta=rows[n].close-rows[n-1].close;gain+=Math.max(0,delta);loss+=Math.max(0,-delta);}
 const last=rows.at(-1),slope=e20.at(-1)-e20.at(-4),direction=last.close>e200.at(-1)&&e20.at(-1)>e50.at(-1)&&slope>0?"long":last.close<e200.at(-1)&&e20.at(-1)<e50.at(-1)&&slope<0?"short":"none";
 return{rows,last,atr,swings,ema20:e20.at(-1),ema50:e50.at(-1),ema200:e200.at(-1),slope,direction,rsi:loss===0?100:100-100/(1+gain/loss)};
}
function costModel(account,c){
 if(!PLATFORM_DEFAULTS[account.platform])throw Error("平台费用未知，禁止按零成本交易");
 const m=getEstimatedTradeCost({...account,paper:true},"compound_4h_v1");
 return{entryFeeRate:m.entryFeeRate,exitFeeRate:m.exitFeeRate,stopSlippageRate:Math.max(c.stopSlippageBps/10000,m.estimatedExitSlippage),fundingRate:c.fundingReserveRate,status:"estimated_taker_conservative",makerAssumed:false,estimatedMakerFeeRate:null};
}
function analyzeRaw({bars,now=Date.now(),account,config}){
 const c=normalize(config),base={...scope(c,account),accountId:account.id,symbol:account.symbol,timestamp:now,evaluatedAt:now,decision:"BLOCKED",primaryBlocker:null,secondaryBlockers:[],dataFreshness:"invalid"};
 try{
  const d=series(bars["1d"],"1d",now,c),h=series(bars["4h"],"4h",now,c),micro=series(bars["1h"],"1h",now,c),side=d.direction,s=side==="long"?1:-1;
  const result={...base,dailyTrend:d.direction,fourHourTrend:h.direction,atr:h.atr,rsi:h.rsi,candidateDirection:side,dataFreshness:"healthy",fourHourOpenTime:h.last.time,fourHourCloseTime:h.last.time+MS['4h'],confirmationCloseTime:micro.last.time+MS['1h'],confirmationClosePrice:micro.last.close,dataTimes:{daily:d.last.time,fourHour:h.last.time,hour:micro.last.time},conditions:{dailyEma:(d.last.close>d.ema200&&d.ema20>d.ema50)||(d.last.close<d.ema200&&d.ema20<d.ema50),dailySlope:side!=="none",atr:h.atr>0,paper:account.tradeMode==="simulation"&&account.simulationEnabled===true},indicators:{dailyEma20:d.ema20,dailyEma50:d.ema50,dailyEma200:d.ema200,dailySlope:d.slope,ema20:h.ema20,ema50:h.ema50,ema200:h.ema200},predictionSnapshotVersion:2};
  if(side==="none")return{...result,decision:"OBSERVE",reasonCode:"DAILY_DIRECTION_UNCLEAR",primaryBlocker:"日线趋势不明确，暂不生成新的反转计划"};
  const supports=h.swings.filter(v=>v.kind===(s>0?"low":"high")&&s*(h.last.close-v.price)>0).slice(-8);
  if(!supports.length)return{...result,conditions:{...result.conditions,swing:false},reasonCode:"NO_CONFIRMED_SWING",primaryBlocker:"没有已确认4H结构区域"};
  const structure=supports.sort((a,b)=>Math.abs(h.last.close-a.price)-Math.abs(h.last.close-b.price))[0],zone={low:structure.price-h.atr*c.zoneAtr,high:structure.price+h.atr*c.zoneAtr};
  const range=h.rows.slice(-20),far=s>0?Math.max(...range.map(v=>v.high)):Math.min(...range.map(v=>v.low)),depth=s*(far-h.last.close)/h.atr;
  const rejection=s>0?micro.last.close>micro.last.open&&micro.last.close>micro.rows.at(-2).close:micro.last.close<micro.last.open&&micro.last.close<micro.rows.at(-2).close;
  const recent=h.rows.slice(-4),decay=Math.abs(recent.at(-1).close-recent.at(-1).open)<Math.abs(recent[0].close-recent[0].open),near=Math.abs(h.last.close-structure.price)<=h.atr*3;
  const confirmation=rejection&&micro.last.low<=zone.high+h.atr*.5&&micro.last.high>=zone.low-h.atr*.5;
  const stop=s>0?zone.low-h.atr*c.stopBufferAtr:zone.high+h.atr*c.stopBufferAtr,entry=s>0?zone.high:zone.low;
  const targetSwings=h.swings.filter(v=>v.kind===(s>0?"high":"low")&&s*(v.price-entry)>0);const target=targetSwings.length?(s>0?Math.min(...targetSwings.map(v=>v.price)):Math.max(...targetSwings.map(v=>v.price))):null;
  const costs=costModel(account,c),unitRisk=s*(entry-stop)+entry*(costs.entryFeeRate+costs.exitFeeRate+costs.stopSlippageRate+costs.fundingRate),netRR=target===null?null:(s*(target-entry)-entry*(costs.entryFeeRate+costs.exitFeeRate+costs.fundingRate))/unitRisk;
  const volumeKnown=range.every(v=>Number(v.volume)>0),parts={daily:c.weights.daily,structure:c.weights.structure*(near?1:.3),momentum:c.weights.momentum*((decay?.6:.2)+(depth>=.5?.4:0)),confirmation:c.weights.confirmation*(confirmation?1:0),space:c.weights.space*(netRR===null?0:Math.min(1,Math.max(0,netRR)/3)),quality:c.weights.quality*(volumeKnown?1:.6)};
  const score=Object.values(parts).reduce((a,b)=>a+b,0),grade=score>=c.gradeA?"A":score>=c.gradeB?"B":"C",blockers=[];
  if(!near||depth<.5)blockers.push("4H尚未回调至有效结构区域");if(!confirmation)blockers.push("已有4H区域，等待1H已收盘拒绝确认");if(netRR===null||netRR<c.minimumNetRR)blockers.push("扣费净结构空间不足");if(grade==="C")blockers.push("质量评分不足："+score.toFixed(1));
  return{...result,conditions:{...result.conditions,swing:true,zone:near,depth:depth>=.5,confirmation,momentum:decay,grade:grade!=="C",netRR:netRR!==null&&netRR>=c.minimumNetRR},fourHourStructure:structure,reversalZone:zone,candidateScore:score,scoreGrade:grade,scoreBreakdown:parts,plannedStopPrice:stop,plannedEntryPrice:entry,plannedTakeProfit:target,projectedRewardRiskRatio:netRR,costs,volumeStatus:volumeKnown?"observed":"unavailable_score_reduced",decision:blockers.length?"WAIT":"READY",primaryBlocker:blockers[0]||null,secondaryBlockers:blockers.slice(1)};
 }catch(error){return{...base,primaryBlocker:error.message};}
}
function analyze(input){return require("./review").decorate(analyzeRaw(input));}
module.exports={MS,series,costModel,analyze};
