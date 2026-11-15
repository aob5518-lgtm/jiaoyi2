"use strict";
const C=require("./config");
function indicators(bars){
 let fast=bars[0].close,slow=fast,signal=0,ema20=fast,ema60=fast,atr=0;
 return bars.map((b,i)=>{
  const prev=bars[i-1]?.close??b.close,tr=Math.max(b.high-b.low,Math.abs(b.high-prev),Math.abs(b.low-prev));
  fast+=2/13*(b.close-fast);slow+=2/27*(b.close-slow);const dif=fast-slow;
  signal+=2/10*(dif-signal);ema20+=2/21*(b.close-ema20);ema60+=2/61*(b.close-ema60);
  atr=i<14?(atr*i+tr)/(i+1):(atr*13+tr)/14;
  return {atr,ema20,ema60,dif,dea:signal,hist:dif-signal};
 });
}
function prototypeAnalyze(rows,input,now){
 const c=C.normalize(input),bars=rows.filter(b=>b.time+C.BAR<=now).sort((a,b)=>a.time-b.time).slice(-240);
 if(bars.length<120)return {code:"WARMUP",reason:"完整 1 小时 K 线不足 120 根"};
 if(bars.some((b,i)=>![b.time,b.open,b.close,b.high,b.low].every(Number.isFinite)||b.time%C.BAR!==0||
  b.low<=0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||i>0&&b.time-bars[i-1].time!==C.BAR)){
  return {code:"CANDLE_GAP",reason:"1 小时原生 K 线缺失或价格异常，暂停新开仓"};
 }
 if(bars.at(-1).time+2*C.BAR<=now)return {code:"CANDLE_STALE",reason:"等待最新已收盘 1 小时 K 线"};
 const values=indicators(bars);let lowSetup=null,highSetup=null,result;
 for(let i=100;i<bars.length;i++){
  const b=bars[i],p=bars[i-1],v=values[i],atr=values[i-1].atr;
  const prior=bars.slice(i-c.channelBars,i),upper=Math.max(...prior.map(x=>x.high)),lower=Math.min(...prior.map(x=>x.low));
  const rising=Array.from({length:c.confirmBars},(_,k)=>values[i-k].hist>values[i-k-1].hist).every(Boolean);
  const falling=Array.from({length:c.confirmBars},(_,k)=>values[i-k].hist<values[i-k-1].hist).every(Boolean);
  const closeTime=b.time+C.BAR;
  const info={closedAt:closeTime,barOpenedAt:b.time,close:b.close,high:b.high,low:b.low,atr,
   ema20:v.ema20,ema60:v.ema60,dif:v.dif,dea:v.dea,hist:v.hist,histRising:rising,histFalling:falling,
   previousHigh:p.high,previousLow:p.low,trend:v.ema20>v.ema60?"long":v.ema20<v.ema60?"short":"none",
   next:{upper,lower,closesAt:closeTime+C.BAR}};
  const status=(code,reason,extra={})=>({...info,code,reason,...extra});
  if(lowSetup&&i-lowSetup.index>8)lowSetup=null;
  if(highSetup&&i-highSetup.index>8)highSetup=null;
  // A candidate extremum is known on this candle only. Confirmation must be on a later close.
  const long=lowSetup&&i>lowSetup.index&&b.close>p.high&&b.close-lowSetup.price>=.5*atr&&rising;
  const short=highSetup&&i>highSetup.index&&b.close<p.low&&highSetup.price-b.close>=.5*atr&&falling;
  let side,entry,setupAt,mode;
  if(long||short){
   side=long?"long":"short";const s=long?lowSetup:highSetup;
   entry={stop:s.price+(long?-.25:.25)*atr};setupAt=bars[s.index].time+C.BAR;mode="extreme_reversal";
   if(long)lowSetup=null;else highSetup=null;
  }else if(b.close>upper+.1*atr&&p.close<=upper&&v.hist>0&&rising&&v.ema20>values[i-3].ema20||
           b.close<lower-.1*atr&&p.close>=lower&&v.hist<0&&falling&&v.ema20<values[i-3].ema20){
   side=b.close>upper?"long":"short";
   const recent=bars.slice(i-3,i+1);
   entry={stop:side==="long"?Math.min(...recent.map(x=>x.low))-.25*atr:Math.max(...recent.map(x=>x.high))+.25*atr};
   setupAt=closeTime;mode="range_breakout";
  }
  // Register after confirmation, so a new lower low/higher high cannot confirm itself.
  if(b.low<=lower&&b.low<values[i-1].ema20-.5*atr&&(!lowSetup||b.low<lowSetup.price))lowSetup={index:i,price:b.low};
  if(b.high>=upper&&b.high>values[i-1].ema20+.5*atr&&(!highSetup||b.high>highSetup.price))highSetup={index:i,price:b.high};
  const observations={lowerCandidate:lowSetup?.price??null,upperCandidate:highSetup?.price??null};
  if(side){
   entry.mode=mode;
   result=c.direction!=="both"&&side!==c.direction?status("DIRECTION_BLOCK","当前设置不允许该方向",observations):
    status("SWING_CONFIRMED",(side==="long"?"做多":"做空")+(mode==="extreme_reversal"?"极值后收盘确认":"区间突破确认")+"，等待成本、规格和组合风控核验",{...observations,side,entry,setupAt,entryMode:mode});
  }else result=status(lowSetup||highSetup?"WAIT_SWING_CONFIRM":"WAIT_SWING",lowSetup||highSetup?
   "已观察到区间极值，等待收盘突破前一根小结构及 MACD 动量确认":"尚无新的极值转向或区间突破信号",observations);
 }
 return result;
}
// Candidate B uses causal directional change. A local extreme becomes a setup only after
// a meaningful wave, and is not tradable until price and closed MACD confirm a turn.
function analyze(rows,input,now){
 const c=C.normalize(input),base=prototypeAnalyze(rows,c,now);
 if(["WARMUP","CANDLE_GAP","CANDLE_STALE"].includes(base.code))return base;
 const bars=rows.filter(b=>b.time+C.BAR<=now).sort((a,b)=>a.time-b.time).slice(-240),values=indicators(bars);
 let phase=null,peak=bars[80].high,trough=bars[80].low,peakAt=80,troughAt=80,result;
 for(let i=81;i<bars.length;i++){
  const b=bars[i],p=bars[i-1],v=values[i],atr=values[i-1].atr;
  if(b.high>peak){peak=b.high;peakAt=i;}if(b.low<trough){trough=b.low;troughAt=i;}
  const rising=Array.from({length:c.confirmBars},(_,k)=>values[i-k].hist>values[i-k-1].hist).every(Boolean);
  const falling=Array.from({length:c.confirmBars},(_,k)=>values[i-k].hist<values[i-k-1].hist).every(Boolean);
  const prior=bars.slice(i-c.channelBars,i),upper=Math.max(...prior.map(x=>x.high)),lower=Math.min(...prior.map(x=>x.low));
  const enough=peak-trough>=3*atr&&Math.max(upper,b.high)-Math.min(lower,b.low)>=3*atr;
  const long=phase!=="long"&&enough&&i>troughAt&&b.close-trough>=c.stopAtr*atr&&b.close>p.high&&rising;
  const short=phase!=="short"&&enough&&i>peakAt&&peak-b.close>=c.stopAtr*atr&&b.close<p.low&&falling;
  const info={closedAt:b.time+C.BAR,barOpenedAt:b.time,close:b.close,high:b.high,low:b.low,atr,
   ema20:v.ema20,ema60:v.ema60,dif:v.dif,dea:v.dea,hist:v.hist,histRising:rising,histFalling:falling,
   previousHigh:p.high,previousLow:p.low,trend:phase||"none",lowerCandidate:trough,upperCandidate:peak,
   next:{upper,lower,closesAt:b.time+2*C.BAR}};
  if(long!==short&&(long||short)){
   const side=long?"long":"short",extreme=long?trough:peak,at=long?troughAt:peakAt;
   phase=side;
   result={...info,trend:side,code:"SWING_CONFIRMED",reason:(long?"做多":"做空")+"波段幅度、收盘小结构和动量均已确认，等待执行风控"};
   if(c.direction==="both"||c.direction===side)Object.assign(result,{side,setupAt:bars[at].time+C.BAR,
    entryMode:"directional_change",entry:{stop:extreme+(long?-.25:.25)*atr,mode:"directional_change"}});
   else Object.assign(result,{code:"DIRECTION_BLOCK",reason:"当前参数不允许该方向"});
   // Begin measuring the next opposite wave only after this confirmed turn.
   peak=b.high;trough=b.low;peakAt=troughAt=i;
  }else result={...info,code:enough?"WAIT_SWING_CONFIRM":"WAIT_SWING",reason:enough?
   "波段幅度已形成，等待价格离开极值并由收盘小结构、MACD 确认":"波动幅度不足，等待形成新的有效波段"};
 }
 return result;
}
module.exports={analyze,prototypeAnalyze,indicators};
