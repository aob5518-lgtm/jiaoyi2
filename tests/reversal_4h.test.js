"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const C = require("../strategy/reversal_4h/config");
const S = require("../strategy/reversal_4h/signal");
const B = require("../strategy/turtle_4h/book");
const R = require("../strategy/turtle_4h/runtime");
const F = require("./turtle_fixture");

const account = F.account({id:"reversal-test",strategyType:C.ID,leverage:1,reversalConfig:C.defaults});
function pattern(short = false) {
 const base = Math.floor(F.NOW / C.BAR) * C.BAR;
 const candles = Array.from({length:90}, (_, i) => {
  const close = 100 + Math.min(23,89-i)*.15 + .5*Math.sin(i*1.7);
  return {time:base-(90-i)*C.BAR,open:close,high:close+.25,low:close-.25,close};
 });
 const a = candles[87].close;
 Object.assign(candles[88], {open:a,high:a+.1,low:a-.7,close:a-.6});
 Object.assign(candles[89], {open:a-.6,high:a-.1,low:a-.65,close:a-.2});
 if(short){
  for(const bar of candles)Object.assign(bar,{open:200-bar.open,close:200-bar.close,high:200-bar.low,low:200-bar.high});
 }
 return candles;
}
function market(time, mid, candles = pattern()) {
 const data = F.market(time);
 return {...data,candles,quote:{...data.quote,bid:mid-.01,ask:mid+.01}};
}
function event(time, data, analysis = S.analyze(data.candles,C.defaults,time)) {
 return {time,data,analysis,marketOK:true,account,permit:()=>({allowed:true})};
}

test("4H oversold and overbought require closed reversal confirmation and cannot read future candles", () => {
 const long = pattern(), short = pattern(true);
 const confirmTime = long.at(-1).time+C.BAR;
 assert.equal(S.analyze(long,C.defaults,confirmTime-1).side,null);
 const result = S.analyze(long,C.defaults,confirmTime);
 assert.equal(result.side,"long");
 assert.equal(S.analyze(short,C.defaults,confirmTime).side,"short");
 assert.equal(S.analyze(long,{direction:"short"},confirmTime).code,"DIRECTION_BLOCK");
 assert.equal(S.analyze(long,{maxAdx:15},confirmTime).code,"TREND_BLOCK");
 assert.equal(S.analyze(long.filter((_, i)=>i!==72),C.defaults,confirmTime).code,"CANDLE_GAP");
 const future = {...long.at(-1),time:confirmTime,high:1000,close:1000};
 assert.deepEqual(S.analyze([...long,future],C.defaults,confirmTime),result);
});

test("Reversal entry, fill, paused position protection and settlement are symmetrical", () => {
 for(const side of ["long","short"]){
  const candles = pattern(side==="short"), time = F.NOW, price = candles.at(-1).close;
  const cfg = C.defaults;
  const data = market(time,price,candles);
  const seeded = {...B.initial(account,C),running:true};
  let opened = B.advance(seeded,event(time,data),cfg,C);
  assert.equal(opened.pending?.kind,"open");
  assert.equal(opened.position,null);
  assert.equal(B.advance(opened,event(time,data),cfg,C).position,null);
  opened = B.advance(opened,event(time+1000,market(time+1000,price,candles)),cfg,C);
  assert.equal(opened.position?.side,side);
  assert.ok(opened.position.actualRisk<=50);
  assert.ok(opened.position.plannedNetR>=cfg.minNetR);
  assert.ok(side==="long"?opened.position.stop<opened.position.entry:opened.position.stop>opened.position.entry);
  const target = opened.position.target+(side==="long"?.3:-.3);
  opened.running=false;
  const exiting=B.advance(opened,event(time+2000,market(time+2000,target,candles)),{...cfg,maxHoldBars:4},C);
  assert.equal(exiting.pending.meta.reason,"mean_target");
  const finished=B.advance(exiting,event(time+3000,market(time+3000,target,candles)),cfg,C);
  assert.equal(finished.position,null);
  assert.equal(finished.trades.length,1);
  assert.equal(finished.trades[0].strategyRevision,C.REVISION);
  assert.ok(finished.trades[0].tradingFee>0&&finished.realized>0);
  assert.equal(finished.running,false);
 }
});

test("Reward and structural stop are rechecked at fill; adverse quote is not fabricated into a profitable entry", () => {
 const candles=pattern(),price=candles.at(-1).close;
 const initial={...B.initial(account,C),running:true};
 const open=B.advance(initial,event(F.NOW,market(F.NOW,price,candles)),C.defaults,C);
 const result=B.advance(open,event(F.NOW+1000,market(F.NOW+1000,price+.4,candles)),C.defaults,C);
 assert.equal(result.pending,null);
 assert.equal(result.position,null);
 assert.equal(result.orders[0].status,"CANCELLED");
 assert.match(result.decision.reason,/COST_BLOCK|STRUCTURE_RISK/);
 assert.equal(B.advance(result,event(F.NOW+2000,market(F.NOW+2000,price,candles)),C.defaults,C).orders.length,1);
});

test("Reversal ledger reload keeps locked position, blocks real or cross-strategy accounts and honours the locked time stop", async t => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"reversal-"));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const candles=pattern(),price=candles.at(-1).close, time=F.NOW;
 let now=time,data=market(now,price,candles);
 const options={directory,profile:C,analyze:S.analyze,provider:{load:async()=>data},now:()=>now,permit:()=>({allowed:true})};
 const engine=R.create(options), st={};
 engine.commit(account,{...B.initial(account,C),running:true});
 await engine.tick(account,st);
 now+=1000;data=market(now,price,candles);
 await engine.tick(account,st);
 const p=engine.get(account).position;
 assert.ok(p);
 const restarted=R.create(options), next={...account,reversalConfig:{...C.defaults,maxHoldBars:4}};
 assert.deepEqual(restarted.get(next).position,p);
 assert.throws(()=>restarted.get({...account,tradeMode:"live"}),/PAPER_ONLY/);
 assert.throws(()=>restarted.get(F.account()),/PAPER_ONLY/);
 assert.equal(fs.existsSync(path.join(directory,"turtle_4h_paper.json")),false);
 const firstCheck=p.openedAt+4*C.BAR;
 let after=B.advance(restarted.get(next),event(firstCheck,{...market(firstCheck,price,candles),fundingFrom:p.fundingThrough}),next.reversalConfig,C);
 assert.equal(after.pending,null);
 const deadline=p.openedAt+C.defaults.maxHoldBars*C.BAR;
 after=B.advance(after,event(deadline,{...market(deadline,price,candles),fundingFrom:firstCheck}),next.reversalConfig,C);
 assert.equal(after.pending.meta.reason,"time_stop");
});
