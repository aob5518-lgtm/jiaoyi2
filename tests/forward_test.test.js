"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const V3=require("../trend_only_v3"),{scopeFor,REVISION,EXPERIMENT,matches}=require("../strategy/trend_v3/scope");
const {updateQualityAudit,classify}=require("../strategy/trend_v3/quality_audit"),{buildStrategyAnalytics,summarizeRows}=require("../strategy/trend_v3/analytics");
const {enrich,distribution}=require("../strategy/trend_v3/forward_analytics"),{portfolioRiskKey,snapshot}=require("../strategy/trend_v3/portfolio");
const {describePullback,auditModes,buildShadows,metadata}=require("../strategy/trend_v3/telemetry"),{tickShadowBooks,shadowSummary,shadowPortfolioSnapshot}=require("../strategy/trend_v3/shadow_books");
const c=V3.normalizeConfig({allowWeekendOpen:true,maxStopDistanceAtr:3}),scope=scopeFor(c),ms=900000;
function input(){return{config:c,signalTime:ms,decisionTime:Date.parse("2026-10-19T12:00Z"),close:101,open:100.5,price:101,atr:1,chop:44,emaFast:100,emaMid:99,diPlus:35,diMinus:15,adx:32,adxHistory:[27,30,32],trendDirection:"long",higherDirection:"none",entryDirection:"long",structureLow:99,structureHigh:105,microHigh:100.5,microLow:99.5,pullbackLow:99.4,pullbackHigh:101,pullbackTouchedLong:true,pullbackTouchedShort:false,pullbackTouchSources:["EMA20"],breakoutHigh:103,breakoutLow:98,roundTripCostRate:.0015,trendIndicators:{structureDirection:"long",emaFast:100,emaMid:99,emaFastSlope:.5,close:101,adx:32,adxHistory:[27,30,32],diPlus:35,diMinus:15,latestSwingHigh:110,latestSwingLow:95},higherIndicators:{structureDirection:"none",adx:18,latestSwingHigh:120,latestSwingLow:90}};}
function account(){return{id:"synthetic",platform:"extended",symbol:"TEST",paper:true,equity:10000,available:10000,simulationSlippageBps:0,trendOnlyConfig:c,trendOnlyState:V3.initialState()};}
function voucher(extra={}){return{...scope,entryTime:0,exitTime:4*ms,entryTimeframe:"15m",entryPrice:100,initialStopLossPrice:98,exitPrice:98,side:"long",positionSize:1,initialEffectiveRiskU:2,netPnl:-2,netR:-1,grossPnl:-1.9,tradingFee:.1,closeReason:"hard_sl",maximumFavorableExcursion:.2,maximumAdverseExcursion:2,...extra};}
test("current experiment migrates old IDs, freezes revision and shares fill/API hash",()=>{
 assert.equal(V3.normalizeConfig({experimentId:"V3_STD_20260930_B"}).experimentId,EXPERIMENT);
 assert.equal(V3.normalizeConfig({strategyRevision:"old"}).strategyRevision,REVISION);
 const a=account(),i=input(),s=V3.detectMarketRegime([],i),p=V3.tryOpenTrendOnlyPosition(a,s,i,c);
 assert.equal(p.allowed,true,p.reason);assert.equal(p.configHash,scope.configHash);
 const position=V3.positionFromFill(p,{qty:p.qty,price:p.entryPrice},Date.now(),c);
 assert.equal(position.strategyRevision,REVISION);assert.equal(position.experimentId,EXPERIMENT);
});
test("revision/experiment/hash isolation does not upgrade or relabel old history",()=>{
 const old=voucher({strategyRevision:"V3_20261009_STRUCTURE"}),missing=voucher({strategyRevision:undefined}),other=voucher({configHash:"different"}),fresh=voucher();
 const rows=[old,missing,other,fresh],before=JSON.stringify(rows),a=buildStrategyAnalytics(rows,scope);
 assert.equal(a.summary.trades,1);assert.equal(JSON.stringify(rows),before);assert.equal(matches(missing,{strategyRevision:"unknown"}),true);
 assert.equal(buildStrategyAnalytics(rows,{...scope,strategyRevision:"all",configHash:"all"}).summary.trades,4);
});
test("hard-stop audit is matured, contiguous and measured in effective R",()=>{
 const v=voucher(),bars=Array.from({length:36},(_,n)=>({time:n*ms,high:n>=4?102:100.2,low:n>=4?97.8:99}));
 assert.equal(updateQualityAudit([v],bars.slice(0,11)),true);assert.equal(v.PostStopMFE_8,undefined);
 assert.equal(updateQualityAudit([v],bars),true);assert.equal(v.PostStopMFE_R_32,2);assert.equal(v.PostStopClassification_32,"STOP_TOO_TIGHT");assert.equal(v.hardStopAuditPostHocOnly,true);
 assert.equal(updateQualityAudit([v],bars),false);
 const gap=voucher();updateQualityAudit([gap],bars.filter(b=>b.time!==6*ms));assert.equal(gap.PostStopMFE_32,undefined);
});
test("partial entry/exit candle is excluded to avoid pre-event price leakage",()=>{
 const v=voucher({exitTime:4*ms+1000,entryTime:1000}),bars=Array.from({length:40},(_,n)=>({time:n*ms,high:n===4?999:100.2,low:98}));
 updateQualityAudit([v],bars);assert.ok(v.PostStopMFE_8<10);assert.equal(v.EntryMFE_R_4,(999-100)/2); // Entry window may legitimately include bar 4.
});
test("unknown historical risk and incomplete windows remain unknown",()=>{
 const v=voucher({initialEffectiveRiskU:null});updateQualityAudit([v],Array.from({length:100},(_,n)=>({time:n*ms,high:101,low:98})));
 assert.equal(v.PostStopMFE_32,undefined);assert.equal(enrich(v).effectiveMFE_R,null);
});
test("hard stop classifications are descriptive, never strategy inputs",()=>{
 assert.equal(classify(2,.1),"STOP_TOO_TIGHT");assert.equal(classify(.1,2),"ENTRY_WRONG");assert.equal(classify(.8,1.2),"STOP_CORRECT");assert.equal(classify(2,2),"AMBIGUOUS");
 const i=input(),before=V3.detectMarketRegime([],i),v=voucher();updateQualityAudit([v],Array.from({length:40},(_,n)=>({time:n*ms,high:102,low:98})));assert.deepEqual(V3.detectMarketRegime([],i),before);
});
test("quality denominators use mature/known samples instead of all stops",()=>{
 const rows=[voucher({PostStopMFE_R_32:2,PostStopClassification_32:"STOP_TOO_TIGHT"}),voucher({maximumFavorableExcursion:null})];
 const q=buildStrategyAnalytics(rows,scope).forward.quality;
 assert.equal(q.stopRebound[32].mature,1);assert.equal(q.stopRebound[32].rate,1);assert.equal(q.neverWorkedSamples,1);assert.equal(q.neverWorkedRate,1);assert.equal(q.stopRebound[8].rate,null);
});
test("winner capture uses compatible effective risk units and excludes losers",()=>{
 const q=buildStrategyAnalytics([voucher({netPnl:2,netR:1,closeReason:"trend_tp",maximumFavorableExcursion:10}),voucher()],scope).forward.quality;
 assert.equal(q.avgWinnerMFE,5);assert.equal(q.avgCaptureRatio,.2);assert.equal(q.captureByExit.trend_tp.samples,1);
});
test("cost summary preserves net PnL, does not deduct embedded slippage twice",()=>{
 const v=voucher({entryFee:.04,exitFee:.06,slippageCost:.02,fundingPnl:.01,stopSlippageAmount:.5});const e=enrich(v);
 assert.ok(Math.abs(e.totalCostU-.11)<1e-10);assert.equal(e.netPnl,v.netPnl);assert.equal(distribution([null,0,1,2]).samples,3);
 assert.equal(summarizeRows([voucher()]).expectancyR,-1);
});
test("UTC weekday/weekend partition is based on entry time, not locale or exit",()=>{
 const a=buildStrategyAnalytics([voucher({entryTime:Date.parse("2026-10-17T12:00Z")}),voucher({entryTime:Date.parse("2026-10-16T23:59Z")})],scope).forward;
 assert.equal(a.weekend.trades,1);assert.equal(a.weekday.trades,1);
 const e=enrich(voucher({entryTime:Date.parse("2026-10-16T23:59Z")}));assert.equal(e.entryLocalTime,"2026-10-17 07:59:00");assert.equal(e.entryLocalTimezone,"Asia/Shanghai");assert.equal(e.weekendUTC,false);
});
test("pullback subtype uses observed historical touch sources and keeps unknown unknown",()=>{
 const i=input();assert.equal(describePullback(i,"long",c).pullbackSubtype,"EMA20_SHALLOW");
 assert.equal(describePullback({...i,pullbackTouchSources:["EMA50"]},"long",c).pullbackSubtype,"EMA50_DEEP");
 assert.equal(describePullback({...i,pullbackTouchSources:["EMA20","EMA50"]},"long",c).pullbackSubtype,"MIXED_RETEST");
 assert.equal(describePullback({...i,pullbackTouchSources:[]},"long",c).pullbackSubtype,"UNKNOWN");
});
test("three mode audits retain distinct blockers and do not mutate actual state",()=>{
 const a=account(),before=JSON.stringify(a.trendOnlyState),audit=auditModes(V3,a,input());
 assert.deepEqual(Object.keys(audit),["breakout_entry","pullback_entry","continuation_entry"]);
 assert.equal(audit.pullback_entry.Triggered,true);assert.equal(audit.continuation_entry.Triggered,false);assert.ok(audit.continuation_entry.blocker);assert.equal(JSON.stringify(a.trendOnlyState),before);
 const f=buildStrategyAnalytics([],scope,[{...scope,time:1,modeAudit:audit}]).forward.modeFunnel;assert.equal(f.pullback_entry.Triggered,1);assert.equal(f.breakout_entry.Filled,0);
 const filled=buildStrategyAnalytics([],scope,[{...scope,time:2,modeAudit:audit,entryMode:"pullback_entry",orderSubmitted:true,orderFilled:true},{...scope,time:3,modeAudit:audit,entryMode:"breakout_entry",orderSubmitted:true}]).forward.modeFunnel;
 assert.equal(filled.pullback_entry.Submitted,1);assert.equal(filled.pullback_entry.Filled,1);assert.equal(filled.breakout_entry.Submitted,1);assert.equal(filled.breakout_entry.Filled,0);
});
test("cost and weekend shadows have no order permission and cannot modify real state",()=>{
 const a=account(),before=JSON.stringify(a.trendOnlyState),i=input(),s=V3.detectMarketRegime([],i),shadow=buildShadows(V3,a,s,i);
 assert.equal(shadow.V3_COST_TIGHT.orderPermission,false);assert.equal(JSON.stringify(a.trendOnlyState),before);
 const weekend=buildShadows(V3,a,s,{...i,decisionTime:Date.parse("2026-10-17T12:00Z")});assert.equal(weekend.weekend_filter_shadow.allowed,false);
 const state={};tickShadowBooks(V3,state,a,i,true);assert.equal(JSON.stringify(a.trendOnlyState),before);assert.equal(Object.keys(state.shadowBooks[scope.configHash].books).length,2);
 const summary=shadowSummary(state.shadowBooks[scope.configHash],[],summarizeRows);assert.equal(summary.V3_COST_TIGHT.orderPermission,false);assert.equal(summary.weekend_filter_shadow.trades,0);
});
test("basis thresholds are diagnostic only, not a new entry filter",()=>{
 const i=input(),before=V3.detectMarketRegime([],i);const after=V3.detectMarketRegime([],{...i,basisBps:99999,basisAtr:99});assert.equal(before.entryPermission,after.entryPermission);
 assert.equal(metadata({...i,referencePrice:100,basisBps:10,executionVenue:"extended"}).basisDiagnosticOnly,true);
});
test("portfolio identity never merges missing keys and separates Paper from Live",()=>{
 assert.notEqual(portfolioRiskKey({id:"a",platform:"extended",paper:true}),portfolioRiskKey({id:"b",platform:"extended",paper:true}));
 assert.notEqual(portfolioRiskKey({id:"a",address:"x",platform:"extended",paper:true}),portfolioRiskKey({id:"b",address:"x",platform:"extended",paper:false}));
 assert.equal(portfolioRiskKey({address:"0xAB",platform:"extended",paper:true}),portfolioRiskKey({address:"0xab",platform:"extended",paper:true}));
});
test("portfolio includes pending reserves, uses shared equity once and fails closed unknown risk",()=>{
 const a={id:"a",paper:true,platform:"extended",vault:"shared",trendOnlyConfig:c},b={...a,id:"b"};
 const entries=[{account:a,equity:10000,state:{position:{side:"long",positionSize:1,filledQty:1,initialEffectiveRiskU:100}}},{account:b,equity:10000,state:{pendingOrder:{kind:"open",side:"long",plan:{initialEffectiveRiskU:100}}}}];
 assert.equal(snapshot(a,entries,"long",60).allowed,false);assert.equal(snapshot(a,entries,"long",50).allowed,true);assert.equal(snapshot(a,entries,"long",0).portfolioEffectiveRiskPct,.02);
 entries[1].state.pendingOrder.plan={};assert.equal(snapshot(a,entries,"long",1).unknownRisk,true);
});
test("all main HTML inline scripts parse and Forward workbench defaults to current revision",()=>{
 const html=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8");
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 assert.match(html,/historyRevisionFilter.*当前修订/);assert.match(html,/Forward Test 策略诊断工作台/);assert.match(html,/strategyVersion=all&strategyRevision=all/);assert.match(html,/if\(includeAllVersions&&currentTab==="analytics"\)await loadAnalytics/);
});

// Deterministic virtual fills isolate ledger lifecycle from market eligibility.
function shadowEngine(){return{
 initialState:()=>({...V3.initialState(),trendEntryCounts:{}}),normalizeConfig:V3.normalizeConfig,
 detectMarketRegime:(_,i)=>({signalTime:i.signalTime}),updateTrendContext:()=>{},
 tryOpenTrendOnlyPosition:(a,s)=>({allowed:true,side:"long",qty:1,signal:s,trendId:"test",initialEffectiveRiskU:10}),
 positionFromFill:(p,f)=>({side:p.side,positionSize:f.qty,signalTime:p.signal.signalTime,currentStopLossPrice:98,initialEffectiveRiskU:10}),
 manageTrendOnlyPosition:(_,__,i)=>i.testExit?{reason:"manual_close"}:{},
 recordClose:(a,_,reason)=>{const v={netPnl:-10,closeReason:reason,signalTime:a.trendOnlyState.position.signalTime};a.trendOnlyState.journal.push(v);a.trendOnlyState.position=null;return v;}
};}
test("shadow cohort and books persist across ticks, trades and serialization",()=>{
 const T=shadowEngine(),state={},a=account(),i=input();
 tickShadowBooks(T,state,a,i);assert.ok(state.shadowBooks[scope.configHash]);
 const cohort=state.shadowBooks[scope.configHash],b=cohort.books.V3_COST_TIGHT,position=b.state.position,startedAt=b.startedAt;
 assert.ok(b);assert.ok(position);assert.ok(cohort.books.weekend_filter_shadow.state.position);
 tickShadowBooks(T,state,a,{...i,decisionTime:i.decisionTime+1});
 assert.equal(cohort.books.V3_COST_TIGHT,b);assert.equal(b.state.position,position);assert.equal(b.startedAt,startedAt);assert.equal(b.barsObserved,1);
 tickShadowBooks(T,state,a,{...i,testExit:true,signalTime:i.signalTime+ms,decisionTime:i.decisionTime+ms});
 assert.equal(b.equity,9990);assert.equal(b.state.journal.length,1);
 const restored=JSON.parse(JSON.stringify(state));tickShadowBooks(T,restored,{...a,equity:999999},{...i,signalTime:i.signalTime+2*ms,decisionTime:i.decisionTime+2*ms});
 const saved=restored.shadowBooks[scope.configHash].books.V3_COST_TIGHT;
 assert.equal(saved.equity,9990);assert.equal(saved.startedAt,startedAt);assert.equal(saved.state.journal.length,1);assert.ok(saved.state.position);assert.equal(saved.orderPermission,false);
});
test("real risk locks, pending orders and exchange orders do not block independent shadows",()=>{
 for(const temporary of [{riskLock:true},{pendingOrder:{status:"unknown_order_state"}},{conflictingAccount:true,exchangeOpenOrders:[{id:"real"}]}]){
  const state={...temporary};tickShadowBooks(shadowEngine(),state,account(),input());
  for(const b of Object.values(state.shadowBooks[scope.configHash].books)){assert.ok(b.state.position);assert.equal(b.orderPermission,false);}
 }
});
test("each shadow honors its own risk lock, pending state, daily loss and cooldown",()=>{
 for(const block of [{riskLock:true},{pendingOrder:{}},{pauseUntil:input().decisionTime+ms},{dailyDate:"2026-10-19",dayStartEquity:10000,dailyLoss:1000}]){
  const T=shadowEngine(),state={};tickShadowBooks(T,state,account(),input(),false);
  Object.assign(state.shadowBooks[scope.configHash].books.V3_COST_TIGHT.state,block);
  tickShadowBooks(T,state,account(),input());assert.equal(state.shadowBooks[scope.configHash].books.V3_COST_TIGHT.state.position,null);assert.ok(state.shadowBooks[scope.configHash].books.weekend_filter_shadow.state.position);
 }
});
test("shadow portfolio uses only same named books and reports incomplete coverage",()=>{
 const a={...account(),vault:"shared"},b={...a,id:"other"},missing={...a,id:"missing"};
 const book=(risk,equity)=>({equity,state:{position:risk?{side:"long",positionSize:1,initialEffectiveRiskU:risk}:null}});
 const entries=[{account:a,equity:1,state:{shadowBooks:{[scope.configHash]:{books:{V3_COST_TIGHT:book(0,10000),weekend_filter_shadow:book(0,5000)}}}}},{account:b,equity:999999,state:{position:{initialEffectiveRiskU:999999},shadowBooks:{[scope.configHash]:{books:{V3_COST_TIGHT:book(200,10000),weekend_filter_shadow:book(0,5000)}}}}}];
 const tight=shadowPortfolioSnapshot(V3,a,entries,"V3_COST_TIGHT","long",60),weekend=shadowPortfolioSnapshot(V3,a,entries,"weekend_filter_shadow","long",60);
 assert.equal(tight.allowed,false);assert.equal(tight.openEffectiveRiskU,200);assert.equal(tight.equityBasis,10000);assert.equal(weekend.allowed,true);assert.equal(weekend.openEffectiveRiskU,0);assert.equal(weekend.equityBasis,5000);
 const partial=shadowPortfolioSnapshot(V3,a,[...entries,{account:missing,equity:999999,state:{}}],"V3_COST_TIGHT","long",0);
 assert.equal(partial.portfolioShadowCoverage.status,"PARTIAL");assert.deepEqual(partial.portfolioShadowCoverage.missingAccountIds,["missing"]);assert.equal(partial.equityBasis,10000);
});
test("uninitialized shadow reports insufficient samples, not zero historical trades",()=>{
 const summary=shadowSummary(null,[],summarizeRows).V3_COST_TIGHT;
 assert.equal(summary.initialized,false);assert.equal(summary.trades,null);assert.equal(summary.persistenceHealthy,false);assert.match(summary.message,/尚未形成有效样本/);
});
test("breakout and continuation do not require pullback-specific metadata",()=>{
 for(const entryMode of ["breakout_entry","continuation_entry"]){assert.equal(buildStrategyAnalytics([voucher({entryMode,signalMarketDataSource:"binance_futures"})],scope).forward.missingFields,0);}
 assert.equal(buildStrategyAnalytics([voucher({entryMode:"pullback_entry",signalMarketDataSource:"binance_futures"})],scope).forward.missingFields,1);
});
test("PostExit and missed-opportunity maturity require complete contiguous closed windows",()=>{
 const {updatePostExitAnalytics}=require("../strategy/trend_v3/post_exit"),{registerMissedCandidate,updateMissedOpportunities}=require("../strategy/trend_v3/posthoc");
 const bars=Array.from({length:33},(_,n)=>({time:n*ms,high:102,low:99}));
 for(const data of [bars.filter(b=>b.time!==3*ms),bars.slice(0,7)]){
  const v=voucher({exitTime:ms+1}),state={};updatePostExitAnalytics([v],data);assert.equal(v.PostExitMFE_8,undefined);assert.equal(v.PostExitMFE_16,undefined);assert.equal(v.PostExitMFE_32,undefined);
  registerMissedCandidate(state,{signalTime:ms,directionRaw:"long",entryPermission:"wait_pullback",structureLow:99},{...input(),close:100});updateMissedOpportunities(state,data);assert.deepEqual(state.missedOpportunityJournal[0].outcomes,{});
 }
 const {fullWindow}=require("../strategy/trend_v3/quality_audit");assert.equal(fullWindow(bars,ms,8,ms,false,8*ms),null);
});
test("canonical revision reaches journal, missed candidates, fills and explicit npm test",()=>{
 const state=V3.initialState(),i=input(),s=V3.detectMarketRegime([],i);
 V3.appendShadowSignal(state,"synthetic",s,i);assert.equal(state.signalJournal[0].strategyRevision,REVISION);assert.equal(state.signalJournal[0].configHash,scope.configHash);
 const {registerMissedCandidate}=require("../strategy/trend_v3/posthoc");registerMissedCandidate(state,{...s,signalTime:2*ms,entryPermission:"wait_pullback",directionRaw:"long"},i);assert.equal(state.missedOpportunityJournal[0].strategyRevision,REVISION);
 const previous=voucher({strategyRevision:"V3_20261015_CONFIRM_COST"});assert.equal(buildStrategyAnalytics([previous],scope).summary.trades,0);assert.equal(previous.strategyRevision,"V3_20261015_CONFIRM_COST");
 assert.match(require("../package.json").scripts.test,/node --test[^&]*tests\/forward_test\.test\.js/);
});
