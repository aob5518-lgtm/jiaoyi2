"use strict";

const C=require("./config");
const HOUR=4*C.BAR;

function hourly(rows) {
 const hours=[];
 for (let i=0;i+3<rows.length;i++) {
  const first=rows[i];
  if (first.time%HOUR!==0||rows[i+3].time-first.time!==3*C.BAR) continue;
  const group=rows.slice(i,i+4);
  hours.push({time:first.time,open:first.open,close:group[3].close,
   high:Math.max(...group.map(bar=>bar.high)),low:Math.min(...group.map(bar=>bar.low))});
 }
 return hours;
}

function direction(hours) {
 const highs=[],lows=[];
 for (let i=Math.max(2,hours.length-30);i<hours.length-2;i++) {
  const center=hours[i], neighbors=hours.slice(i-2,i+3).filter(v=>v!==center);
  if (neighbors.every(bar=>center.high>bar.high)) highs.push(center.high);
  if (neighbors.every(bar=>center.low<bar.low)) lows.push(center.low);
 }
 if (highs.length<2||lows.length<2) return null;
 const high=highs.at(-1)-highs.at(-2),low=lows.at(-1)-lows.at(-2),last=hours.at(-1).close;
 if (high>0&&low>0&&last>lows.at(-1)) return "long";
 if (high<0&&low<0&&last<highs.at(-1)) return "short";
 return null;
}

function atrs(rows) {
 const sample=rows.slice(1).map((bar,i)=>Math.max(bar.high-bar.low,Math.abs(bar.high-rows[i].close),Math.abs(bar.low-rows[i].close)));
 let atr=sample.slice(0,14).reduce((sum,value)=>sum+value,0)/14;
 const values=Array(14).fill(null);
 values.push(atr);
 for (const tr of sample.slice(14)) values.push(atr=(13*atr+tr)/14);
 return values;
}

function analyze(rows,input,now,{direct=false}={}) {
 const c=C.normalize(input);
 const bars=rows.filter(v=>v.time+C.BAR<=now).sort((a,b)=>a.time-b.time).slice(-160);
 if (bars.length<120) return {code:"WARMUP",reason:"完整 15 分钟 K 线不足，无法判断 1 小时结构"};
 if (bars.some((b,i)=>![b.time,b.open,b.close,b.high,b.low].every(Number.isFinite)||b.time%C.BAR!==0||
     b.low<=0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||i>0&&b.time-bars[i-1].time!==C.BAR)) {
  return {code:"CANDLE_GAP",reason:"15 分钟原生 K 线存在缺口或异常"};
 }
 const last=bars.at(-1),closedAt=last.time+C.BAR;
 if (closedAt+C.BAR<=now) return {code:"CANDLE_STALE",reason:"等待最新 15 分钟收盘 K 线"};
 const hours=hourly(bars), volatility=atrs(bars);
 let setup=null, answer;
 for (let i=bars.length-c.setupBars-5;i<bars.length;i++) {
  const bar=bars[i], closeTime=bar.time+C.BAR, atr=volatility[i-1];
  const trend=direction(hours.filter(hour=>hour.time+HOUR<=closeTime));
  const prior=bars.slice(i-c.breakoutBars,i);
  const upper=Math.max(...prior.map(b=>b.high)), lower=Math.min(...prior.map(b=>b.low));
  const info={closedAt:closeTime,atr,trend,setupAt:setup?.time??null,breakoutLevel:setup?.level??null,patternTarget:setup?.extension??null,
   next:{upper,lower,closesAt:closeTime+C.BAR}};
  const status=(code,reason,extra)=>({...info,...extra,code,reason});
  if (!trend||c.direction!=="both"&&c.direction!==trend||!(atr>0)) {
   setup=null;
   answer=status("WAIT_TREND","1 小时方向尚未成立，或当前设置不允许该方向");
   continue;
  }
  const sign=trend==="long"?1:-1;
  const near=trend==="long"?bar.low:bar.high, far=trend==="long"?bar.high:bar.low;
  const level=trend==="long"?upper:lower;
  if (setup&&(setup.side!==trend||closeTime-setup.time>c.setupBars*C.BAR)) setup=null;
  if (!setup) {
   if (sign*(bar.close-level)<=.05*atr) {
    answer=status("WAIT_BREAKOUT","1 小时方向成立，等待 15 分钟收盘突破整理区间",{setupAt:null,breakoutLevel:null,patternTarget:null});
    continue;
   }
   setup={time:closeTime,side:trend,level,atr,extension:far};
   // Direct breakout is the offline reference. Its target projects the pre-breakout range.
   if (direct&&i===bars.length-1) {
    return status("BREAKOUT","对照组在突破收盘后直接入场",{side:trend,setupAt:closeTime,
     entry:{stop:level-sign*.5*atr,target:level+sign*(upper-lower)}});
   }
   answer=status("WAIT_PULLBACK","已突破，等待价格回测原突破区",{setupAt:closeTime,breakoutLevel:level,patternTarget:far});
   continue;
  }
  if (sign*(bar.close-setup.level)<-.15*setup.atr||sign*(near-setup.level)<-.65*setup.atr) {
   setup=null;
   answer=status("SETUP_INVALID","价格跌回原区间，突破结构已失效");
   continue;
  }
  if (!setup.touchAt) {
   if (sign*(near-setup.level)<=.25*setup.atr&&sign*(setup.extension-setup.level)>=.75*setup.atr) {
    setup.touchAt=closeTime;
    setup.retestExtreme=near;
    setup.trigger=far;
    answer=status("WAIT_PULLBACK_CONFIRM","回踩守住突破区，等待收盘突破回踩小结构");
   } else {
    if (sign*far>sign*setup.extension) setup.extension=far;
    answer=status("WAIT_PULLBACK","已突破，等待价格回测原突破区",{patternTarget:setup.extension});
   }
   continue;
  }
  if (sign*(far-setup.extension)>=0||closeTime-setup.touchAt>4*C.BAR) {
   setup=null;
   answer=status("SETUP_INVALID","原目标已触及或回踩确认超时，等待新的结构");
   continue;
  }
  if (sign*near<sign*setup.retestExtreme) setup.retestExtreme=near;
  if (sign*(bar.close-setup.trigger)>0&&sign*(bar.close-bar.open)>0) {
   answer=direct?status("WAIT_BREAKOUT","对照组等待新的突破"):
    status("PULLBACK_CONFIRMED","回踩确认，核对原生盘口与扣成本后的盈亏比",
     {side:trend,entry:{stop:setup.retestExtreme-sign*.2*atr,target:setup.extension}});
   setup=null;
   continue;
  }
  answer=status("WAIT_PULLBACK_CONFIRM","回踩守住突破区，等待收盘突破回踩小结构");
 }
 return answer;
}

module.exports={analyze,hourly,direction};
