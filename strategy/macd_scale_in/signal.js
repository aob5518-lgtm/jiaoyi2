"use strict";
const C=require('./config'),HOUR=3600000;
function ema(values,period){let value=null;const alpha=2/(period+1);return values.map(v=>{value=value===null?v:alpha*v+(1-alpha)*value;return value;});}
function series(candles,config={}){const c=C.normalize(config),prices=candles.map(v=>v.close),fast=ema(prices,c.fastPeriod),slow=ema(prices,c.slowPeriod),dif=fast.map((v,i)=>v-slow[i]),dea=ema(dif,c.signalPeriod);return candles.map((v,i)=>({...v,dif:dif[i],dea:dea[i],histogram:2*(dif[i]-dea[i])}));}
function analyze(candles,config,now,identity={}){
 const c=C.normalize(config),closed=candles.filter(v=>v.time+HOUR<=now),minimum=Math.max(c.slowPeriod*8,200);
 const result={...C.scope(c,identity),evaluatedAt:now,signal:null,code:'NO_SIGNAL',reason:'等待新的已收盘 MACD 信号',closedTime:closed.at(-1)?.time+HOUR||null};
 if(closed.length<minimum)return{...result,code:'WARMUP',reason:'已收盘 K 线不足，MACD 需要 '+minimum+' 根预热'};
 const bars=closed.slice(-Math.max(minimum+20,500));
 for(let i=0;i<bars.length;i++){
  const b=bars[i];if(!['time','open','high','low','close','volume'].every(k=>Number.isFinite(b[k]))||b.time%HOUR!==0||b.low<=0||b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close)||b.volume<0||i&&b.time-bars[i-1].time!==HOUR)return{...result,code:'CANDLE_GAP',reason:'K 线存在缺口、重复或无效 OHLCV'};
 }
 if(now-result.closedTime>c.candleMaxDelayMs)return{...result,code:'CANDLE_STALE',reason:'最新已收盘 1H K 线延迟超过限制'};
 const values=series(bars,c),last=values.at(-1),confirm=c.crossConfirmBars,j=values.length-confirm;
 let cross=null,momentum=null;
 const signed=v=>v.dif-v.dea;
 if(signed(values[j-1])<=0&&values.slice(j).every(v=>signed(v)>0))cross='long';
 if(signed(values[j-1])>=0&&values.slice(j).every(v=>signed(v)<0))cross='short';
 const n=c.momentumConfirmBars,k=values.length-n-1;
 if(values[k].histogram<=values[k-1].histogram&&values.slice(k+1).every((v,i)=>v.histogram>values[k+i].histogram)&&values[k].histogram<0)momentum='long';
 if(values[k].histogram>=values[k-1].histogram&&values.slice(k+1).every((v,i)=>v.histogram<values[k+i].histogram)&&values[k].histogram>0)momentum='short';
 // COMBINED: a confirmed cross plus consecutive same-direction histogram slopes (momentumConfirmBars).
 const m=values.length-c.momentumConfirmBars;
 const combined=cross&&values.slice(m).every((v,i)=>(v.histogram-values[m+i-1].histogram)*(cross==='long'?1:-1)>0)?cross:null;
 const side=c.signalMode==='CROSS'?cross:c.signalMode==='MOMENTUM'?momentum:combined;
 const tr=bars.slice(-c.atrPeriod).map((v,i)=>Math.max(v.high-v.low,Math.abs(v.high-bars[bars.length-c.atrPeriod+i-1].close),Math.abs(v.low-bars[bars.length-c.atrPeriod+i-1].close)));
 result.indicators={dif:last.dif,dea:last.dea,histogram:last.histogram,atr:tr.reduce((a,b)=>a+b,0)/tr.length,emaSeed:'first_close_recursive',histogramMultiplier:2,cross,momentum};
 if(!side)return result;
 const signalId=[identity.symbol||'ETH','USDT','1h',c.signalMode,c.crossConfirmBars,c.momentumConfirmBars,result.closedTime,side].join(':');
 return{...result,code:side==='long'?'MACD_LONG_SIGNAL':'MACD_SHORT_SIGNAL',reason:side==='long'?'已收盘 MACD 做多信号':'已收盘 MACD 做空信号',signal:{id:signalId,side,closedTime:result.closedTime,barOpenTime:last.time,availableAt:result.closedTime,...result.indicators}};
}
module.exports={HOUR,ema,series,analyze};
