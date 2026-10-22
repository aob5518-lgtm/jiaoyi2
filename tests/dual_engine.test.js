"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const V3=require("../trend_only_v3"),{buildDecision,recordDecision,decisionStats}=require("../strategy/trend_v3/decision");
test("P0 unified decision separates waiting from risk and keeps one blocker per candidate",()=>{
 const config=V3.normalizeConfig({}),state={signal:{signalTime:Date.now(),directionRaw:"long",entryPermission:"wait_pullback",blockers:["等待回踩","等待确认"],entryCandidates:[]},marketData:{status:"healthy"},indicators:{},executionEvaluation:{setup:"WAITING"}};
 const d=buildDecision({account:{id:"x",symbol:"TEST"},config,state,execution:{state:"WAIT_PULLBACK"}});assert.equal(d.finalDecision,"WAIT");assert.equal(d.trendDirection,"long");assert.equal(d.primaryBlocker,"等待回踩");recordDecision(state,d);recordDecision(state,{...d,evaluatedAt:Date.now()+1});assert.equal(state.decisionJournal.length,1);
 assert.equal(decisionStats(state.decisionJournal,V3.scopeFor(config),24).total,1);
 const blocked=buildDecision({account:{id:"x"},config,state,execution:{state:"RISK_LOCK",reason:"安全锁"},previous:d});assert.equal(blocked.finalDecision,"BLOCKED");assert.equal(blocked.primaryBlocker,"安全锁");
});
test("P0 filled event is not erased by later position management",()=>{
 const config=V3.normalizeConfig({}),time=Date.now(),state={signal:{signalTime:time,directionRaw:"long",entryPermission:"allowed"},signalJournal:[{time,orderFilled:true}],marketData:{status:"healthy"}};
 assert.equal(buildDecision({account:{id:"x"},config,state,execution:{state:"POSITION_MANAGED"}}).finalDecision,"ENTERED");
});

const S=require("../strategy/short_term_v1/engine"),now=Date.UTC(2026,9,23,12),c=S.normalizeConfig(),a={id:"test",symbol:"TEST",platform:"binance",equity:10000,available:10000,simulationSlippageBps:1,tradeCostConfig:{entryFeeRate:.0001,exitFeeRate:.0001}};
function bars(tf,bg=false){const ms=tf==="5m"?300000:900000;return Array.from({length:120},(_,n)=>{const center=(bg?105:99)+n*.02+Math.sin(n*.8)*.15;return{time:now-(120-n)*ms,open:center-.04,close:center+.04,high:center+.18,low:center-.18,volume:100};});}
function market(){const entryCandles=bars("5m"),backgroundCandles=bars("15m",true),previous=entryCandles.slice(0,-1),high=Math.max(...previous.slice(-20).map(x=>x.high));Object.assign(entryCandles.at(-1),{open:high-.1,close:high+.3,high:high+.4,low:high-.2,volume:250});return{entryCandles,backgroundCandles,now,account:a,config:c,price:high+.3,source:"futures"};}
function candidate(){return{allowed:true,type:"momentum_breakout",side:"long",entryPrice:100,initialStopLossPrice:98,stopDistance:2,atr:1,riskMultiplier:1,grade:"A",score:90,costModel:S.costs(a,c),scoreBreakdown:{},potentialNetR:3};}
function signal(time=now-300000){return{...S.scopeFor(c),timestamp:time,time,dataStatus:"healthy",selected:candidate(),candidates:[candidate()],finalDecision:"READY"};}
const bounds={qtyStep:.001,minNotional:5};
test("P1 independent short-term produces confirmed breakout candidates and seven real score components",()=>{
 const s=S.analyze(market()),b=s.candidates.find(c=>c.type==="momentum_breakout");assert.equal(s.dataStatus,"healthy");assert.equal(b.triggered,true);assert.equal(Object.keys(b.scoreBreakdown).length,7);assert.equal(b.score,Object.values(b.scoreBreakdown).reduce((x,y)=>x+y,0));assert.equal(s.orderPermission,false);
});
test("P1 core signals use closed 5m/15m bars only, and gaps or misalignment fail closed",()=>{
 const m=market(),before=S.analyze(m);m.entryCandles.push({time:now,open:1,close:100000,high:100000,low:1,volume:999999});assert.deepEqual(S.analyze(m),before);
 const bad=market();bad.entryCandles.splice(60,1);assert.equal(S.analyze(bad).dataStatus,"invalid");
 const stale=market();stale.backgroundCandles.pop();assert.equal(S.analyze(stale).dataStatus,"invalid");
});
test("P1 unconfirmed breakout never triggers; strong background rejects range reversal",()=>{
 const m=market();m.entryCandles=bars("5m");const s=S.analyze(m);assert.equal(s.candidates.find(c=>c.type==="momentum_breakout").allowed,false);assert.equal(s.candidates.find(c=>c.type==="range_reversal").allowed,false);assert.match(s.candidates.find(c=>c.type==="range_reversal").blockers.join(),/禁止逆势/);
});
test("P1 unknown costs and insufficient net structural space block execution",()=>{
 assert.equal(S.costs({platform:"unknown"},c).status,"incomplete");const m=market();m.account={...a,platform:"unknown"};const x=S.analyze(m).candidates[0];assert.equal(x.roundTripCostR,null);assert.equal(x.allowed,false);assert.match(x.blockers.join(),/成本未知/);
 const narrow=market();narrow.config=S.normalizeConfig({minimumPotentialNetR:1000});assert.equal(S.analyze(narrow).selected,null);
});
test("P1 independent effective-risk sizing shrinks for wider stops and rejects missing exchange rules",()=>{
 const small=S.plan(candidate(),a,c,bounds),large=S.plan({...candidate(),stopDistance:4},a,c,bounds);assert.ok(small.allowed);assert.ok(large.qty<small.qty);assert.ok(small.initialEffectiveRiskU<=a.equity*c.riskPerTrade);assert.equal(S.plan(candidate(),a,c,{}).allowed,false);
});
test("P1 router enforces V3 priority, position exclusion, unresolved order exclusion and portfolio cap",()=>{
 for(const extra of [{realPosition:{}},{realPending:{}},{v3Candidate:{allowed:true}},{portfolioAllowed:()=>({allowed:false,reason:"组合上限"})}]){const b=S.initialState(10000);S.tick(b,signal(),{account:a,config:c,price:100,now,constraints:bounds,portfolioAllowed:()=>({allowed:true}),...extra});assert.equal(b.position,null);assert.equal(b.signals[0].finalDecision,"BLOCKED");}
});
test("P1 Shadow restart, conservative stop execution and net accounting stay isolated",()=>{
 let b=S.initialState(10000);S.tick(b,signal(),{account:a,config:c,price:100,now,constraints:bounds,portfolioAllowed:()=>({allowed:true})});assert.ok(b.position);const before=b.equity;b=JSON.parse(JSON.stringify(b));
 S.tick(b,{...signal(),selected:null},{account:a,config:c,price:95,now:now+60000,constraints:bounds});assert.equal(b.position,null);assert.equal(b.journal.length,1);const v=b.journal[0];assert.ok(v.exitPrice<=95);assert.ok(Math.abs(v.netPnl-(v.grossPnl-v.tradingFee+v.fundingPnl))<1e-10);assert.equal(v.netR,v.netPnl/v.initialEffectiveRiskU);assert.equal(v.strategyVersion,"short_term_v1");assert.equal(v.sampleType,"shadow");assert.equal(v.orderPermission,false);assert.equal(b.equity,before+v.netPnl);assert.notEqual(S.scopeFor(c).experimentId,V3.scopeFor(V3.normalizeConfig()).experimentId);
});
test("P1 disabling Live is non-overridable and all short setups can be independently disabled",()=>{
 assert.equal(S.normalizeConfig({allowLive:true,sampleType:"paper"}).allowLive,false);const m=market();m.config=S.normalizeConfig({entryModes:[]});assert.equal(S.analyze(m).candidates.length,0);
});

const M=require("../public/history-model");
test("P2 history scope, sample, dates and CSV use the same filtered rows",()=>{
 const rows=[{strategyVersion:"trend_only_v3",experimentId:"v3",strategyRevision:"r",configHash:"h",paper:true,netPnl:-2,netR:-.5,exitTime:1000},{strategyVersion:"short_term_v1",experimentId:"short",strategyRevision:"r2",configHash:"h2",sampleType:"shadow",netPnl:10,netR:2,exitTime:2000}];
 const subset=M.filter(rows,{strategy:"short_term_v1",sample:"shadow",experiment:"short",revision:"r2",hash:"h2",from:1500});assert.equal(subset.length,1);assert.equal(M.summary(subset).netPnl,10);assert.equal(M.summary(rows).comparable,false);const csv=M.csv(subset);assert.ok(csv.includes('"short_term_v1"'));assert.ok(!csv.includes('"trend_only_v3"'));assert.ok(M.csv([{symbol:"=DANGEROUS()"}]).includes("'=DANGEROUS()"));
});
test("P2 empty/legacy history does not invent R, fees or risk values",()=>{
 const s=M.summary([]);assert.equal(s.netPnl,null);assert.equal(s.winRate,null);assert.equal(s.profitFactor,null);assert.equal(s.maxDrawdown,null);assert.equal(M.r({netR:null}),null);assert.equal(M.summary([{pnl:-5},{pnl:10}]).netPnl,5);
});
test("P2 history is structurally separated from analytics and supports pagination/mobile cards",()=>{
 const fs=require('fs'),path=require('path'),html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');const history=html.slice(html.indexOf('id="tab-history"'),html.indexOf('id="tab-analytics"'));
 assert.ok(!history.includes('id="forwardWorkbench"'));assert.ok(history.includes('historyCoreStats'));assert.ok(history.includes('更多统计'));assert.ok(history.includes('historyAdvanced'));assert.ok(html.includes('const size=50'));assert.ok(html.includes('historyMobileCards'));assert.ok(html.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));assert.ok(html.includes('无记录'));
});
test("P3 V3 daily loss, cooldown and pending orders are enforced by actual plan, not only UI",()=>{
 const config=V3.normalizeConfig({allowWeekendOpen:true}),base={equity:10000,paper:true,trendOnlyConfig:config};
 for(const state of [{pauseUntil:now+1000},{pendingOrder:{}},{position:{}},{dailyDate:new Date(now).toISOString().slice(0,10),dayStartEquity:10000,dailyLoss:10000}])assert.equal(V3.tryOpenTrendOnlyPosition({...base,trendOnlyState:state},{entryPermission:"allowed",tradeDirection:"long"},{now}).allowed,false);
});
test("P3 short-term config rejects credential fields, invalid quote cannot corrupt a position",()=>{
 assert.equal(S.normalizeConfig({apiSecret:"not-a-real-key"}).apiSecret,undefined);const b=S.initialState(10000);S.tick(b,signal(),{account:a,config:c,price:100,now,constraints:bounds,portfolioAllowed:()=>({allowed:true})});const old=JSON.stringify(b.position);S.tick(b,signal(),{account:a,config:c,price:NaN,now});assert.equal(JSON.stringify(b.position),old);
});
test("P3 short-term post-hoc maturity requires complete future bars and never changes entry permission",()=>{
 const b={journal:[{exitTime:now,exitPrice:100,positionSize:1,initialEffectiveRiskU:2,side:"long"}],signals:[]};
 const future=Array.from({length:9},(_,n)=>({time:now+n*300000,high:102,low:99}));S.updatePostHoc(b,future.filter((_,n)=>n!==3),now+9*300000);assert.equal(b.journal[0].PostExitMFE_R_8,undefined);S.updatePostHoc(b,future,now+9*300000);assert.equal(b.journal[0].PostExitMFE_R_8,1);
});

test("P3 volume absence reduces score honestly and a neutral background is not a hard alignment block",()=>{
 const m=market(),trusted=S.analyze(m),untrusted=S.analyze({...m,source:"unknown"});assert.ok(untrusted.candidates[0].score<trusted.candidates[0].score);assert.equal(untrusted.candidates[0].volumeStatus,"unavailable_score_reduced");
 const neutral=market();neutral.backgroundCandles=neutral.backgroundCandles.map((x,n)=>({...x,open:100,close:100,high:100.1,low:99.9}));const result=S.analyze(neutral);assert.equal(result.direction,"none");assert.ok(!result.candidates[0].blockers.some(x=>x.includes("15m与5m方向冲突")));
});
test("P3 short-term books isolate market identity and stopped monitoring cannot open",()=>{
 assert.notEqual(S.scopeFor(c,a).configHash,S.scopeFor(c,{...a,symbol:"BTC"}).configHash);
 assert.notEqual(S.scopeFor(c,a).configHash,S.scopeFor(c,{...a,platform:"extended"}).configHash);
 const b=S.initialState(10000);S.tick(b,signal(),{account:a,config:c,price:100,now,constraints:bounds,monitorRunning:false,portfolioAllowed:()=>({allowed:true})});assert.equal(b.position,null);assert.match(b.signals[0].primaryBlocker,/已停止/);
});
test("P3 short-term metrics preserve missing costs and separate real Paper from Shadow",()=>{
 const A=require("../strategy/short_term_v1/analytics"),empty=A.metrics([]);assert.equal(empty.netPnl,null);assert.equal(empty.avgCostR,null);
 const v=A.metrics([{netPnl:-2,netR:-.2,entryTime:now,exitTime:now+1000,holdingDurationMs:1000}],[]);assert.equal(v.actualPaperTrades,0);assert.equal(v.shadowTrades,1);assert.equal(v.avgCostR,null);assert.equal(v.feeDrag.samples,0);assert.equal(v.evaluation,"NEGATIVE_EXPECTANCY");assert.equal(v.missedSignals.missedTrendRate,null);
});
test("P3 same-bar duplicates and restored virtual pending order cannot open twice",()=>{
 const b=S.initialState(10000);b.pendingOrder={status:"unknown"};S.tick(b,signal(),{account:a,config:c,price:100,now,constraints:bounds,portfolioAllowed:()=>({allowed:true})});assert.equal(b.position,null);assert.match(b.signals[0].primaryBlocker,/尚未确认/);
 b.pendingOrder=null;S.tick(b,signal(),{account:a,config:c,price:100,now,constraints:bounds,portfolioAllowed:()=>({allowed:true})});assert.equal(b.position,null);assert.equal(b.signals.length,1);
});
