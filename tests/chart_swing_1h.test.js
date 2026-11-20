"use strict";
const {test}=require("node:test"),A=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const C=require("../strategy/chart_swing_1h/config"),S=require("../strategy/chart_swing_1h/signal"),B=require("../strategy/turtle_4h/book");
const R=require("../strategy/turtle_4h/runtime"),Research=require("../scripts/chart_swing_research"),annotations=require("../scripts/research/chart_swing_annotations");
const epoch=Date.UTC(2026,0,1),H=C.BAR;
const account={id:"chart-test",strategyType:C.ID,platform:"binance",symbol:"ETH",quoteAsset:"USDT",tradeMode:"simulation",
 simulationEnabled:true,simulationBalance:10000,leverage:1,chartSwingConfig:C.defaults};
function candles(){return Array.from({length:300},(_,i)=>{const close=100+.02*i+4*Math.sin(i/9);return {
 time:epoch+i*H,open:close-.03,close,high:close+.15,low:close-.15,volume:1000};});}
function event(time,price,side="long",analysis){
 return {time,account,marketOK:true,permit:()=>({allowed:true}),analysis:analysis||{closedAt:epoch+120*H,barOpenedAt:epoch+119*H,
  atr:2,side,entry:{stop:side==="long"?97:103,mode:"directional_change"},setupAt:epoch+117*H},
  data:{funding:[],fundingFrom:epoch,quote:{bid:price-.005,ask:price+.005,bidQty:1000,askQty:1000,time},
   rules:{step:.001,minQty:.001,maxQty:10000,minNotional:20}}};
}
const time=epoch+120*H;
function opened(side="long"){
 const b={...B.initial(account,C),running:true},pending=B.advance(b,event(time,100,side),C.defaults,C);
 return B.advance(pending,event(time+1000,100,side),C.defaults,C);
}
test("Directional-change signals require later closed confirmation, are causal and input-immutable",()=>{
 const rows=candles(),raw=JSON.stringify(rows),sides=new Set();
 for(let i=120;i<rows.length;i++){
  const now=rows[i].time+H,signal=S.analyze(rows.slice(0,i+1),C.defaults,now);
  A.deepEqual(S.analyze(rows,C.defaults,now),signal);
  if(signal.side){sides.add(signal.side);A.ok(signal.setupAt<signal.closedAt);A.equal(signal.entryMode,"directional_change");}
 }
 A.deepEqual([...sides].sort(),["long","short"]);A.equal(JSON.stringify(rows),raw);
 const end=rows.at(-1).time+H;
 A.equal(S.analyze(rows.filter((_,i)=>i!==280),C.defaults,end).code,"CANDLE_GAP");
 A.equal(S.analyze(rows,C.defaults,end+H).code,"CANDLE_STALE");
});
test("Direction permissions do not rewrite the raw wave and provisional future candles cannot influence decisions",()=>{
 const rows=candles();let chosen;
 for(let i=120;i<rows.length&&!chosen;i++)if(S.analyze(rows,C.defaults,rows[i].time+H).side==="long")chosen=rows[i].time+H;
 A.ok(chosen);const s=S.analyze(rows,C.defaults,chosen);
 const blocked=S.analyze(rows,{direction:"short"},chosen);A.equal(blocked.side,undefined);A.equal(blocked.trend,"long");
 A.deepEqual(S.analyze([...rows,{time:chosen+100*H,open:100,high:1e6,low:1,close:1e6}],C.defaults,chosen),s);
});
for(const side of ["long","short"])test(side+" fills revalidate structure and locked cost risk; worse fill reduces size or cancels",()=>{
 const b={...B.initial(account,C),running:true},waiting=B.advance(b,event(time,100,side),C.defaults,C);
 A.equal(waiting.position,null);A.equal(waiting.pending.status,"SUBMITTED");
 const actual=B.advance(waiting,event(time+1000,side==="long"?101:99,side),{...C.defaults,riskPerTrade:.01},C);
 A.ok(actual.position);A.ok(actual.position.actualRisk<=50);A.deepEqual(actual.position.config,C.defaults);
 A.ok(side==="long"?actual.position.stop<actual.position.entry:actual.position.stop>actual.position.entry);
 const invalid=B.advance(waiting,event(time+1000,side==="long"?96:104,side),C.defaults,C);
 A.equal(invalid.position,null);A.equal(invalid.pending,null);A.equal(invalid.orders[0].status,"CANCELLED");
 A.equal(B.advance(waiting,event(time+91000,100,side),C.defaults,C).position,null);
});
test("One quote cannot fill twice; same signal/structure cannot create duplicate orders",()=>{
 const b=opened(),again=B.advance(JSON.parse(JSON.stringify(b)),event(time+1000,100),C.defaults,C);
 A.equal(again.orders.length,1);A.equal(again.position.qty,b.position.qty);
 const closed={...b,position:null,pending:null,lastSignalAt:time,lastSetupAt:epoch+117*H};
 A.equal(B.advance(closed,event(time+2000,100),C.defaults,C).orders.length,1);
});
test("Pause preserves hard stop, hard stop precedes soft exit, net history reconciles fees and funding",()=>{
 let b=opened();b.running=false;
 const quote=b.position.stop-2,e=event(time+2*H,quote);
 e.analysis={closedAt:time+2*H,close:quote,atr:2,histFalling:true,previousLow:101};
 b=B.advance(b,e,C.defaults,C);A.equal(b.pending.meta.reason,"hard_sl");
 b=B.advance(JSON.parse(JSON.stringify(b)),event(time+2*H+1000,quote),C.defaults,C);
 A.equal(b.position,null);A.equal(b.trades.length,1);A.equal(b.trades[0].entryMode,"directional_change");
 A.ok(Math.abs(b.trades[0].grossPnl-b.trades[0].tradingFee+b.trades[0].fundingPnl-b.trades[0].netPnl)<1e-7);
 A.ok(Math.abs(b.balance-10000-b.realized)<1e-7);
});
test("ATR protection only tightens, is evaluated once per close and restores a profitable stop",t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"chart-swing-"));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let b=opened();b.running=false;
 const closedAt=time+3*H,analysis={closedAt,barOpenedAt:time+2*H,high:112,low:109,close:111,atr:2,histFalling:false};
 b=B.advance(b,event(closedAt,111,"long",analysis),C.defaults,C);
 A.ok(b.position.stop>b.position.entry);const stop=b.position.stop;
 b=B.advance(b,event(closedAt+1000,111,"long",{...analysis,high:120}),C.defaults,C);
 A.equal(b.position.stop,stop);
 const engine=R.create({directory,profile:C,analyze:S.analyze});engine.commit(account,b);
 const restored=R.create({directory,profile:C,analyze:S.analyze});A.equal(restored.failure(),"");A.equal(restored.get(account).position.stop,stop);
 b=B.advance(b,event(closedAt+2000,stop-.1),C.defaults,C);A.equal(b.pending.meta.reason,"swing_trailing_exit");
});
test("Paper-only, credentials, risk-lock, portfolio denial and unsupported config are fail-closed",()=>{
 for(const patch of [{tradeMode:"live"},{simulationEnabled:false},{apiKey:"x"},{privateKey:"x"},{platform:"hyperliquid"}])A.throws(()=>C.assertAccount({...account,...patch}),/PAPER_ONLY/);
 A.throws(()=>C.normalize({lookahead:true}));A.equal(C.normalize({leverage:150}).leverage,150);
 for(const e of [{riskLock:true},{blocker:"外部委托"},{permit:()=>({allowed:false,reason:"组合风险"})}]){
  const b={...B.initial(account,C),running:true,riskLock:!!e.riskLock};
  A.equal(B.advance(b,{...event(time,100),...e},C.defaults,C).pending,null);
 }
});
test("All 46 screenshots are represented, duplicates do not inflate the 39 reference opportunities",()=>{
 const ids=[...annotations.targets,...annotations.duplicates].map(x=>x.image).sort((a,b)=>a-b);
 A.deepEqual(ids,Array.from({length:46},(_,i)=>i+1));A.equal(annotations.targets.length,39);
 const one=annotations.targets[0],trade={side:one.side,entryTime:one.entry.from,entryPrice:1900,time:one.exit.from,exitPrice:2500};
 const result=Research.compare({signals:[],trades:[trade,trade]});A.equal(result.entryMatched,1);A.equal(result.extraTrades,1);
 A.equal(Research.inZone(one.entry.to,1900,one.entry),false);
});
test("Offline replay marks trades as historical research rather than real Paper forward performance",()=>{
 const bars=candles(),data={source:"binance_usdm_native",market:"ETHUSDT",interval:"1h",from:epoch,
  end:epoch+bars.length*H,fetchedAt:epoch+bars.length*H,bars,funding:[]};
 const run=Research.replay(data,epoch+120*H,data.end);
 A.ok(run.trades.length>0);A.ok(run.trades.every(t=>t.sampleType==="historical_replay"&&t.matchingPrecision==="hourly_proxy"));
});
