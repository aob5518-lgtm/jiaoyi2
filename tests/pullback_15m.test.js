"use strict";
const {test}=require("node:test"), A=require("node:assert/strict");
const C=require("../strategy/pullback_15m/config"), S=require("../strategy/pullback_15m/signal");
const B=require("../strategy/turtle_4h/book"), M=require("../strategy/turtle_4h/provider");

const bar=C.BAR, epoch=Date.UTC(2026,0,1), setup=137;
const account={id:"pullback",strategyType:C.ID,platform:"binance",symbol:"ETH",quoteAsset:"USDT",tradeMode:"simulation",
 simulationEnabled:true,simulationBalance:10000,leverage:1,pullbackConfig:C.defaults};
function fixture(short=false) {
 const rows=Array.from({length:160},(_,i)=>{
  const close=100+i*.04+1.6*Math.cos((i-3)*Math.PI/16);
  return {time:epoch+i*bar,open:close,close,high:close+.11,low:close-.11};
 });
 const level=Math.max(...rows.slice(setup-20,setup).map(v=>v.high));
 const parts=[[.05,.45,-.03,.32],[.32,2.05,.30,1.2],[.18,.24,.02,.09],[.09,.41,.08,.39]];
 parts.forEach(([open,high,low,close],i)=>Object.assign(rows[setup+i],{open:level+open,high:level+high,low:level+low,close:level+close}));
 if (short) for(const b of rows) Object.assign(b,{open:200-b.open,close:200-b.close,high:200-b.low,low:200-b.high});
 return rows;
}
const event=(time,price,analysis)=>({time,account,analysis,marketOK:true,permit:()=>({allowed:true}),
 data:{fundingFrom:epoch,funding:[],quote:{bid:price-.005,ask:price+.005,bidQty:5000,askQty:5000,time},
  rules:{step:.001,minQty:.001,maxQty:10000,minNotional:5}}});
const closeOf=i=>epoch+(i+1)*bar;
const running=()=>({...B.initial(account,C),running:true});

test("Long and short wait for closed retest confirmation; direct breakout control uses only earlier data",()=>{
 for(const side of ["long","short"]){
  const rows=fixture(side==="short");
  const at=S.analyze(rows,C.defaults,closeOf(setup));
  A.equal(at.code,"WAIT_PULLBACK");A.equal(at.trend,side);A.equal(at.side,undefined);
  A.equal(S.analyze(rows,C.defaults,closeOf(setup),{direct:true}).side,side);
  A.equal(S.analyze(rows,C.defaults,closeOf(setup+2)).code,"WAIT_PULLBACK_CONFIRM");
  A.equal(S.analyze(rows,C.defaults,closeOf(setup+3)-1).side,undefined);
  const confirmed=S.analyze(rows,C.defaults,closeOf(setup+3));
  A.equal(confirmed.side,side);
  A.equal(confirmed.setupAt,closeOf(setup));
  A.deepEqual(S.analyze(rows.slice(0,setup+4),C.defaults,closeOf(setup+3)),confirmed);
 }
});

test("Missing candle, broken retest and direction mismatch cannot authorize trading",()=>{
 const rows=fixture();
 A.equal(S.analyze(rows.filter((_,i)=>i!==100),C.defaults,closeOf(setup+3)).code,"CANDLE_GAP");
 A.equal(S.analyze(rows,{direction:"short"},closeOf(setup+3)).code,"WAIT_TREND");
 rows[setup+2].low-=1;
 A.equal(S.analyze(rows,C.defaults,closeOf(setup+2)).code,"SETUP_INVALID");
 A.equal(S.analyze(rows,C.defaults,closeOf(setup+3)).side,undefined);
 A.equal(S.direction(S.hourly(rows.slice(0,3))),null);
});

test("Costs and lateness block entry; actual fill rechecks stop, target and risk",()=>{
 const rows=fixture(), time=closeOf(setup+3), p=rows[setup+3].close;
 const a=S.analyze(rows,C.defaults,time);
 const expired=B.advance(running(),event(time+91000,p,a),C.defaults,C);
 A.equal(expired.decision.code,"SIGNAL_EXPIRED");
 A.equal(B.advance(running(),event(time+5,p+.45,a),C.defaults,C).decision.code,"COST_BLOCK");
 const waiting=B.advance(running(),event(time+10,p,a),C.defaults,C);
 A.equal(waiting.pending.kind,"open");
 A.equal(B.advance(waiting,event(time+2000,a.entry.target-.01,a),C.defaults,C).position,null);
 const opened=B.advance(waiting,event(time+2000,p,a),C.defaults,C);
 A.equal(opened.position.side,"long");
 A.ok(opened.position.actualRisk<=30&&opened.position.plannedNetR>=1.5);
 const target=opened.position.target+.04;
 const closing=B.advance({...opened,running:false},event(time+3000,target,a),{...C.defaults,maxHoldBars:4},C);
 A.equal(closing.pending.meta.reason,"swing_target");
 const settled=B.advance(closing,event(time+4000,target,a),C.defaults,C);
 A.equal(settled.trades.length,1);
 A.equal(settled.trades[0].sampleType,"paper_forward");
 A.ok(settled.realized>0);
});

test("Binance provider requests 15m bars and refetches on the next quarter-hour boundary",async()=>{
 let now=epoch+bar-1000;const requests=[];
 const fetch=async url=>{
  requests.push(url);
  if(url.includes("bookTicker"))return {bidPrice:100,askPrice:100.01,bidQty:1,askQty:1,time:now};
  if(url.includes("klines"))return [[epoch,100,101,99,100]];
  if(url.includes("fundingRate"))return [];
  return {symbols:[{symbol:"ETHUSDT",contractType:"PERPETUAL",quoteAsset:"USDT",status:"TRADING",
   filters:[{filterType:"MARKET_LOT_SIZE",stepSize:".001",minQty:".001",maxQty:10},{filterType:"MIN_NOTIONAL",notional:5}]}]};
 };
 const provider=M.create(fetch,()=>now,C);
 A.equal((await provider.load(account,C.defaults,epoch)).candles.length,0);
 now+=2000;
 A.equal((await provider.load(account,C.defaults,epoch)).candles.length,1);
 A.equal(requests.filter(url=>url.includes("interval=15m")).length,2);
 A.throws(()=>C.assertAccount({...account,tradeMode:"live"}),/PAPER_ONLY/);
 A.throws(()=>C.assertAccount({...account,apiKey:"fixture"}),/PAPER_ONLY/);
});
