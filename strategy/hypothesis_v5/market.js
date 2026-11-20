"use strict";
const T = require("../../trend_only");
const {normalize,hash} = require("./config");
const MS={"4h":14400000,"1h":3600000,"15m":900000};
function closed(raw,tf,now) {
 const ms=MS[tf];if(!ms||!Number.isFinite(now))throw Error("周期/时间错误");
 if(!Array.isArray(raw))throw Error("行情缺失");
 const rows=raw.filter(v=>Number(v.time)+ms<=now).map(v=>Object.fromEntries(["time","open","high","low","close","volume"].map(k=>[k,Number(v[k])])));
 if(rows.length<210)throw Error(tf+"已收盘数据不足");
 for(let n=0;n<rows.length;n++){const v=rows[n];if(!Object.values(v).every(Number.isFinite)||v.time%ms||v.low<=0||v.volume<0||v.high<Math.max(v.open,v.close)||v.low>Math.min(v.open,v.close)||v.high<v.low||(n&&v.time-rows[n-1].time!==ms))throw Error(tf+"数据异常/缺口/时间错位");}
 if(rows.at(-1).time!==Math.floor(now/ms)*ms-ms)throw Error(tf+"数据陈旧");
 return rows;
}
const median=xs=>{const v=[...xs].sort((a,b)=>a-b),n=v.length;return n%2?v[(n-1)/2]:(v[n/2-1]+v[n/2])/2;};
const ema=(rows,n)=>{let x=rows[0].close;return rows.map(v=>x+=(v.close-x)*2/(n+1));};
function regime(rows,c,options={}) {
 const i=T.indicatorsFor(rows,{}, "4h",rows.at(-1).time+MS["4h"]),e50=ema(rows,50),e200=ema(rows,200),recent=rows.slice(-21),movement=recent.slice(1).reduce((s,v,n)=>s+Math.abs(v.close-recent[n].close),0),efficiency=movement?Math.abs(recent.at(-1).close-recent[0].close)/movement:0;
 const baseline=median(rows.slice(-100,-1).map((v,n)=>{const prev=rows[rows.length-101+n];return Math.max(v.high-v.low,Math.abs(v.high-prev.close),Math.abs(v.low-prev.close));}));
 const crosses=rows.slice(-20).reduce((n,v,k)=>{const index=rows.length-20+k;return n+(k&&Math.sign(v.close-e50[index])!==Math.sign(rows[index-1].close-e50[index-1])?1:0);},0),slope=e50.at(-1)-e50.at(-6);
 const up=e50.at(-1)>e200.at(-1)&&slope>0&&i.close>e50.at(-1),down=e50.at(-1)<e200.at(-1)&&slope<0&&i.close<e50.at(-1);
 const high=i.atr/i.close>c.maxAtrPct||i.atr>baseline*c.highVolAtrRatio;
 const strong=options.omitAdx||i.adx>=c.adxMin;
 const quality=(options.omitEfficiency||efficiency>=c.minEfficiency)&&(options.omitCrosses||crosses<=c.maxCrosses);
 return {state:high?"HIGH_VOLATILITY":strong&&quality&&up?"TREND_UP":strong&&quality&&down?"TREND_DOWN":"RANGE",direction:up?"long":down?"short":"none",adx:i.adx,atr:i.atr,atrPct:i.atr/i.close,ema50:e50.at(-1),ema200:e200.at(-1),slope,efficiency,crosses};
}
function weekend(now,c,liquidity){const weekend=[0,6].includes(new Date(now).getUTCDay());return{weekend,mode:c.weekendMode,allowed:!weekend||c.weekendMode==="A"||c.weekendMode==="C"&&liquidity===true};}
function quoteReview(q,symbol,now,c,omitLiquidity=false) {
 const reasons=[];if(!q||![q.bid,q.ask,q.time,q.depthNotional].every(Number.isFinite)||q.bid<=0||q.ask<q.bid||q.time>now||now-q.time>c.maxQuoteAgeMs)reasons.push("QUOTE_INVALID_OR_STALE");
 if(q?.platform!=="binance"||q?.symbol!==symbol+"USDT"||q?.marketType!=="perpetual"||q?.quoteAsset!=="USDT"||q?.source!=="native_binance")reasons.push("SOURCE_MISMATCH");
 const spread=q?.bid>0?(q.ask-q.bid)/((q.ask+q.bid)/2)*10000:Infinity;
 if(!omitLiquidity&&(spread>c.maxSpreadBps||!(q?.depthNotional>=c.minDepthNotional)))reasons.push("LIQUIDITY_BLOCK");
 return{allowed:!reasons.length,reasons,spreadBps:Number.isFinite(spread)?spread:null,quality:q?.quality||"UNKNOWN"};
}
function evaluate({bars,symbol,now,quote,config,variant={}}) {
 const c=normalize(config),base={hypothesisId:"H01",symbol,evaluatedAt:now,regime:{state:"UNKNOWN",direction:"none"},signalPermission:"blocked",executionPermission:"not_evaluated",blockers:[],gates:{},dataHealth:"invalid"};
 try{
  const h4=closed(bars["4h"],"4h",now),h1=closed(bars["1h"],"1h",now),m15=closed(bars["15m"],"15m",now),r=regime(h4,c,variant),i=T.indicatorsFor(h1,{},"1h",now),last=h1.at(-1),previous=h1.slice(-c.breakoutLookback-1,-1),hi=Math.max(...previous.map(v=>v.high)),lo=Math.min(...previous.map(v=>v.low)),vol=median(previous.map(v=>v.volume)),direction=variant.omitRegime?(last.close>hi?"long":last.close<lo?"short":"none"):r.state==="TREND_UP"?"long":r.state==="TREND_DOWN"?"short":"none";
  let side=direction,breakout=side==="long"?last.close>hi:side==="short"&&last.close<lo;
  if(variant.random){const seed=parseInt(hash({time:last.time,symbol}).slice(0,8),16);side=seed%2?"long":"short";breakout=seed%24===0;}
  const q=quoteReview(quote,symbol,now,c,variant.omitLiquidity),w=weekend(now,c,q.allowed),gates={regime:variant.omitRegime?r.state!=="HIGH_VOLATILITY":["TREND_UP","TREND_DOWN"].includes(r.state),breakout,volume:last.volume>0&&vol>0&&(variant.omitVolume||last.volume>=vol*c.volumeMultiplier),liquidity:q.allowed,weekend:w.allowed};
  const reasons=Object.entries(gates).filter(([,v])=>!v).map(([k])=>({regime:"REGIME_NOT_TREND",breakout:"WAIT_BREAKOUT",volume:"VOLUME_INSUFFICIENT",liquidity:q.reasons.join(","),weekend:"WEEKEND_BLOCK"}[k]));
  return{...base,dataHealth:"healthy",regime:r,direction:side,atr:i.atr,signalTime:last.time+MS["1h"],signalId:hash({symbol,time:last.time,side}),breakout:{high:hi,low:lo,close:last.close,passed:breakout},volume:{value:last.volume,median:vol,threshold:vol*c.volumeMultiplier},weekend:w,quote:q,barTimes:{fourHourClose:h4.at(-1).time+MS["4h"],hourClose:last.time+MS["1h"],entryClose:m15.at(-1).time+MS["15m"]},gates,blockers:reasons,signalPermission:reasons.length?"blocked":"allowed",referencePrice:last.close};
 }catch(e){return{...base,blockers:["DATA_INVALID: "+e.message]};}
}
module.exports={MS,closed,median,regime,weekend,quoteReview,evaluate};
