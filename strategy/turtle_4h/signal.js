"use strict";
const C=require("./config");
function analyze(rows,input,now) {
 const c=C.normalize(input),bars=rows.filter(v=>v.time+C.BAR<=now).sort((a,b)=>a.time-b.time);
 if(bars.length<Math.max(c.entryBars,c.exitBars,c.atrPeriod)+1)return {code:"WARMUP",reason:"已收盘 4H K 线不足，等待原生数据",side:null};
 for(let i=0;i<bars.length;i++){
  const b=bars[i];if(![b.time,b.open,b.high,b.low,b.close].every(Number.isFinite)||!(b.low>0&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close))||b.time%C.BAR!==0||i&&b.time-bars[i-1].time!==C.BAR)return {code:"CANDLE_GAP",reason:"4H K 线不连续或数值无效，禁止新增仓位",side:null};
 }
 const b=bars.at(-1),previous=bars.slice(0,-1),entry=previous.slice(-c.entryBars),exit=previous.slice(-c.exitBars);
 if(now-(b.time+C.BAR)>=C.BAR)return {code:"CANDLE_STALE",reason:"最新已收盘 K 线陈旧",side:null};
 const tr=bars.slice(1).map((b,i)=>Math.max(b.high-b.low,Math.abs(b.high-bars[i].close),Math.abs(b.low-bars[i].close)));
 let atr=tr.slice(0,c.atrPeriod).reduce((a,b)=>a+b,0)/c.atrPeriod;
 for(const n of tr.slice(c.atrPeriod))atr=(atr*(c.atrPeriod-1)+n)/c.atrPeriod;
 const upper=Math.max(...entry.map(v=>v.high)),lower=Math.min(...entry.map(v=>v.low));
 const exitLow=Math.min(...exit.map(v=>v.low)),exitHigh=Math.max(...exit.map(v=>v.high));
 const raw=b.close>upper?"long":b.close<lower?"short":null,side=raw&&(c.direction==="both"||c.direction===raw)?raw:null;
 const nextEntry=bars.slice(-c.entryBars);
 const next={upper:Math.max(...nextEntry.map(v=>v.high)),lower:Math.min(...nextEntry.map(v=>v.low)),closesAt:b.time+2*C.BAR};
 return {code:side?"BREAKOUT":"WAIT_BREAKOUT",reason:side?(side==="long"?"4H 收盘突破前高，形成做多信号":"4H 收盘跌破前低，形成做空信号"):"等待 4H 收盘突破通道，不因盘中触价开仓",side,raw,atr,upper,lower,exitLow,exitHigh,close:b.close,closedAt:b.time+C.BAR,barTime:b.time,next};
}
module.exports={analyze};
