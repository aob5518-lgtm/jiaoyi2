"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const V3 = require("../trend_only_v3");
const { chooseEntry } = require("../strategy/trend_v3/entries");
const { evaluateReentry } = require("../strategy/trend_v3/reentry");
const { calculateInitialStop } = require("../strategy/trend_v3/stops");
const c = V3.normalizeConfig();
const { evaluatePullback } = require("../strategy/trend_v3/entries");
const { calculateNetBreakEvenStop, buildTradeCostModel } = require("../strategy/trend_v3/costs");
const input = { close:101, open:100, atr:1, emaFast:100, chop:44, pullbackLow:99.4, pullbackHigh:102, structureLow:99, structureHigh:103, pullbackTouchedLong:true, microHigh:100.5, diPlus:35, diMinus:15, breakoutHigh:100.8, breakoutLow:90, latestSwingLow:99.8, compression:true, expansion:true };
test("EMA touch and DI alone are not confirmed pullback entries",()=>{
 const weak={...input,microHigh:105,previousHigh:104};
 assert.equal(evaluatePullback('long',weak,c).triggered,false);
 const recovery=evaluatePullback('long',{...weak,previousHigh:100.8},c);
 assert.equal(recovery.triggered,true);assert.equal(recovery.factors.recoveryBreak,true);
 assert.equal(evaluatePullback('long',{...weak,previousHigh:100.8,diPlus:10,diMinus:35},c).triggered,false);
});
test("short recovery requires closed directional reclaim and previous low break",()=>{
 const s={open:100,close:99,emaFast:99.5,atr:1,structureHigh:102,pullbackHigh:101,pullbackTouchedShort:true,diMinus:35,diPlus:10,microLow:98,previousLow:99.2};
 assert.equal(evaluatePullback('short',s,c).triggered,true);
 assert.equal(evaluatePullback('short',{...s,previousLow:98.8},c).triggered,false);
});
for(const side of ['long','short']) test(`net break-even covers ${side} entry/exit fees and normal stop slippage`,()=>{
 const p={side,paper:true,entryPrice:100.1234,positionSize:20,filledQty:20,costModel:{entryFeeRate:0.0005,exitFeeRate:0.0005}};
 const b=calculateNetBreakEvenStop(p,c),exit=b.executionPrice;
 const gross=(exit-p.entryPrice)*p.positionSize*(side==='long'?1:-1);
 const fee=(exit+p.entryPrice)*p.positionSize*0.0005;
 assert.ok(Math.abs(gross-fee)<0.000001);
 const old=p.entryPrice*(side==='long'?1.001:0.999);
 const oldExit=old*(side==='long'?0.9995:1.0005);
 assert.ok((oldExit-p.entryPrice)*(side==='long'?1:-1)-(oldExit+p.entryPrice)*0.0005<0);
 p.entryFeeActual=0;assert.notEqual(calculateNetBreakEvenStop(p,c).trigger,b.trigger);
});
test("V3 risk cost reserves protective stop slippage even with zero regular slippage",()=>{
 const cost=buildTradeCostModel({paper:true,platform:'extended',simulationSlippageBps:0,trendOnlyConfig:{paperStopSlippageBps:5}},'pullback_entry');
 assert.equal(cost.roundTripCostRate,0.0015);assert.equal(cost.estimatedEntrySlippage,0);assert.equal(cost.estimatedExitSlippage,0.0005);
});
test("negative protection exit labels and zero-profit PF reflect actual net result",()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
 const snippets=['reasonLabel','netPnlOf','historyReasonLabel'].map(name=>html.match(new RegExp('const '+name+' = [^\\n]+'))[0]);
 const label=vm.runInNewContext(snippets.join('\n')+'\nhistoryReasonLabel');
 assert.equal(label({closeReason:'trend_tp',netPnl:-10}),'保护退出（净亏损）');
 assert.equal(label({closeReason:'trend_tp',netPnl:100}),'移动止盈/保护止盈');
 const M=require('../public/history-model');assert.equal(M.summary([{netPnl:-1}]).profitFactor,0);assert.equal(M.summary([]).profitFactor,null);
});
test("higher-quality triggered mode is not swallowed by pullback priority", () => {
  assert.equal(chooseEntry("long", { ...input, microHigh:101.5 }, c).selected.type, "breakout_entry");
});
test("invalid breakout pivot does not veto a valid pullback setup", () => {
  const result = chooseEntry("long", { ...input, latestSwingLow:90 }, c);
  assert.equal(result.selected.type, "pullback_entry");
  assert.equal(result.candidates.find(x=>x.type==="breakout_entry").stopAllowed, false);
});
test("extended breakout does not veto an independently valid pullback", () => {
  const result = chooseEntry("long", { ...input, emaFast:98 }, c);
  assert.equal(result.selected.type, "pullback_entry"); assert.equal(result.waitRetest, false);
});
test("conditional CHOP still selects only pullback, regardless of breakout score", () => {
  assert.equal(chooseEntry("long", { ...input, chop:58 }, c).selected.type, "pullback_entry");
});
test("breakout stop uses confirmed setup pivot but never clamps a far pivot", () => {
  const args = { side:"long", entryMode:"breakout_entry", entryPrice:101, atr:1, signal:input, input, config:c };
  assert.equal(calculateInitialStop(args).allowed, true);
  assert.equal(calculateInitialStop({ ...args, input:{...input,latestSwingLow:90} }).allowed, false);
});
test("invalid structure stop is signal-blocked instead of fake allowed", () => {
  const signal = V3.detectMarketRegime([], { ...input, config:c, signalTime:1000, trendDirection:"long", entryDirection:"none", higherDirection:"none", entryModes:["pullback_entry"], pullbackLow:90, structureLow:89, breakoutHigh:110 });
  assert.notEqual(signal.entryPermission, "allowed"); assert.match(signal.blockers.join(" "), /止损距离/);
});
test("a new confirmed wave may reenter after full cooldown without dropping per-wave cap", () => {
  const prior = { lastExitSignalTime:900000, direction:"short", structureHigh:110, structureLow:100 };
  const state = { trendContext:{trendId:"short:base"}, trendEntryCounts:{"short:base":2}, reentryState:prior };
  const signal = { tradeDirection:"short", signalTime:900000*9, entryMode:"pullback_entry", structureHigh:108, structureLow:98 };
  const next = evaluateReentry(state, signal, c);
  assert.equal(next.allowed, true); assert.match(next.trendId, /:wave:/);
  assert.equal(state.activeEntryWave, undefined); // No commit before fill.
  assert.equal(evaluateReentry({...state, activeEntryWave:next.trendWave, trendEntryCounts:{[next.trendId]:2}}, signal, c).allowed, false);
  assert.equal(evaluateReentry(state, {...signal,structureLow:101}, c).allowed, false);
  assert.equal(evaluateReentry(state, {...signal,signalTime:900000*4}, c).allowed, false);
});
test("V3 diagnostics retain 14 days while V2 retains 72h, including mode factors", () => {
  const V2 = require("../trend_only_v2"); const state = V3.initialState();
  for(let n=1;n<=1500;n++) V3.appendShadowSignal(state,"a",{ signalTime:n*900000, entryPermission:"blocked", entryCandidates:[{type:"continuation_entry", factors:{structure:false}}] }, { config:c,close:100,atr:1,emaFast:100 });
  assert.equal(state.signalJournal.length,V3.journalRetentionBars("15m"));
  assert.ok(state.signalJournal.length>V2.journalRetentionBars("15m"));
  assert.equal(state.signalJournal.at(-1).entryCandidates[0].factors.structure,false);
  for(const tf of ["15m","5m","1m"]) assert.ok(V3.journalRetentionBars(tf)*V3.INTERVALS[tf]>=14*24*3600000);
});
test("swing and compression diagnostics do not consume future/unclosed candles", () => {
  const bars=Array.from({length:260},(_,n)=>({time:n*900000,open:100+Math.sin(n)*2,close:100+Math.sin(n)*2,high:103+Math.sin(n)*2,low:97+Math.sin(n)*2,volume:1}));
  const now=260*900000;
  const before=V3.indicatorsFor(bars,c,"15m",now);
  const future={time:now,open:1,close:10000,high:20000,low:0.1,volume:1};
  const after=V3.indicatorsFor([...bars,future],c,"15m",now);
  assert.deepEqual(after.swings,before.swings);
  assert.equal(after.continuationCompressionRecent,before.continuationCompressionRecent);
});
