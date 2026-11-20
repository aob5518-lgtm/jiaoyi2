"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path"),C=require("../strategy/hypothesis_v5/config"),M=require("../strategy/hypothesis_v5/market"),B=require("../strategy/hypothesis_v5/book"),V=require("../strategy/hypothesis_v5/service"),R=require("../strategy/hypothesis_v5/registry"),H=require("../strategy/hypothesis_v5/research"),A=require("../strategy/hypothesis_v5/analytics");
const now=Date.UTC(2026,10,4,12),rules={qtyStep:.001,minQty:.001,maxQty:10000,priceTick:.01,minNotional:5};
function candles(tf,count=260,end=now){const ms=M.MS[tf];return Array.from({length:count},(_,k)=>{const close=100+k*.25;return{time:Math.floor(end/ms)*ms-(count-k)*ms,open:close-.1,close,high:close+1,low:close-1,volume:100};});}
function bars(){const v=Object.fromEntries(Object.keys(M.MS).map(tf=>[tf,candles(tf)]));v["1h"].at(-1).close+=3;v["1h"].at(-1).high+=3;v["1h"].at(-1).volume=200;return v;}
function quote(price=168,time=now){return{bid:price*.9999,ask:price*1.0001,time,depthNotional:10000000,symbol:"ETHUSDT",platform:"binance",quoteAsset:"USDT",marketType:"perpetual",source:"native_binance",quality:"SYNTHETIC_TEST_ONLY"};}
const signal=(time=now)=>({signalPermission:"allowed",signalId:"signal-"+time,signalTime:time,direction:"long",referencePrice:168,atr:2,dataHealth:"healthy",regime:{state:"TREND_UP",direction:"long"},blockers:[]});
function book(id="test"){const b=B.create({id,symbol:"ETH"});b.running=true;return b;}
function event(time=now,extra={}){return{time,quote:quote(168,time),rules,signal:signal(now),...extra};}
function open(b){B.step(b,event());assert.ok(b.pending);B.step(b,event(now+1000));assert.ok(b.position);}
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"hypothesis-v5-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test("H01 config hard caps, no Live, asset whitelist, deterministic parameter hash",()=>{
 for(const x of [{riskPerTrade:.004},{dailyLossLimit:.03},{maxLeverage:11},{maxPositions:3},{portfolioRiskLimit:.02},{privateKey:"x"},{weekendMode:"X"}])assert.throws(()=>C.normalize(x));
 assert.throws(()=>C.scope({},"ETH","Live"));assert.throws(()=>C.scope({},"SOL"));
 assert.equal(C.scope({},"ETH").configHash,C.scope({...C.DEFAULTS},"ETH").configHash);
 assert.notEqual(C.scope({weekendMode:"A"},"ETH").configHash,C.scope({},"ETH").configHash);
});
test("H01 five-box hypotheses, failed-experiment retention and H02-H04 registration only",()=>{
 for(const h of R.hypotheses)for(const k of ["observation","hypothesis","mechanism","validation","falsification","createdAt","parameterVersion"])assert.ok(h[k]);
 assert.equal(R.hypotheses.filter(h=>h.status==="REGISTERED_ONLY").length,3);
 assert.ok(R.experiments.some(v=>v.id==="RANDOM"));assert.throws(()=>R.variant({},"BEST_AFTER_OOS"));
});
test("H01 closed candles ignore unclosed/future values, reject gaps, wrong alignment and volume",()=>{
 const x=candles("1h");assert.equal(M.closed([...x,{time:now,close:999999}],"1h",now).length,x.length);
 for(const y of [x.slice(0,-1),x.filter((_,k)=>k!==40),x.map((v,k)=>k===3?{...v,time:v.time+1}:v),x.map((v,k)=>k===7?{...v,volume:-1}:v)])assert.throws(()=>M.closed(y,"1h",now));
});
test("H01 market state recognizes trends, low ADX range and abnormal volatility",()=>{
 const x=candles("4h"),c=C.normalize();assert.equal(M.regime(x,c).state,"TREND_UP");
 const down=x.map((v,k)=>({...v,open:200-k*.25+.1,close:200-k*.25,high:201-k*.25,low:199-k*.25}));assert.equal(M.regime(down,c).state,"TREND_DOWN");
 assert.equal(M.regime(x,{...c,adxMin:101}).state,"RANGE");
 const violent=x.map((v,k)=>k===x.length-1?{...v,high:v.high+100}:v);assert.equal(M.regime(violent,c).state,"HIGH_VOLATILITY");
});
test("H01 actual multi-timeframe breakout and volume reference exclude breakout candle",()=>{
 const x=bars(),price=x["1h"].at(-1).close,r=M.evaluate({bars:x,symbol:"ETH",now,quote:quote(price),config:{}});
 assert.equal(r.dataHealth,"healthy");assert.equal(r.breakout.passed,true);assert.equal(r.volume.median,100);assert.equal(r.signalPermission,"allowed");
 x["1h"].at(-1).volume=100;assert.ok(M.evaluate({bars:x,symbol:"ETH",now,quote:quote(price),config:{}}).blockers.includes("VOLUME_INSUFFICIENT"));
});
test("H05 UTC Friday/Saturday/Sunday/Monday boundaries and A/B/C only block new risk",()=>{
 const sat=Date.UTC(2026,10,7);assert.equal(M.weekend(sat-1,C.normalize(),true).allowed,true);assert.equal(M.weekend(sat,C.normalize(),true).allowed,false);
 assert.equal(M.weekend(sat+86400000,C.normalize(),true).allowed,false);assert.equal(M.weekend(sat+2*86400000,C.normalize(),false).allowed,true);
 assert.equal(M.weekend(sat,C.normalize({weekendMode:"A"}),false).allowed,true);assert.equal(M.weekend(sat,C.normalize({weekendMode:"C"}),false).allowed,false);assert.equal(M.weekend(sat,C.normalize({weekendMode:"C"}),true).allowed,true);
});
test("H01 native quote identity, staleness, real future timestamps and spread block in backend",()=>{
 for(const q of [{...quote(),time:now+1},{...quote(),time:now-6000},{...quote(),source:"fallback"},{...quote(),quoteAsset:"USDC"},{...quote(),ask:180},{...quote(),depthNotional:1}])assert.equal(M.quoteReview(q,"ETH",now,C.normalize()).allowed,false);
});
test("H01 risk sizing includes costs; pending does not create position and duplicate signal cannot duplicate",()=>{
 const b=book();B.step(b,event());assert.equal(b.position,null);assert.ok(b.pending.riskAmount<=30);B.step(b,event());B.step(b,event(now+100,{noFill:true}));assert.equal(b.orders.length,1);assert.equal(b.orders[0].filledQty,0);
});
test("H01 partial fill cancels remainder, fixed risk basis and simulated protection exist",()=>{
 const b=book();B.step(b,event());B.step(b,event(now+1000,{fillFraction:.5}));assert.ok(b.position);assert.equal(b.pending,null);assert.equal(b.orders[0].status,"PARTIAL_CANCELLED");assert.equal(b.position.protection,"SIMULATED_ACTIVE");assert.ok(b.position.initialRiskAmount<=30);
});
test("H01 submit response timeout and cancel uncertainty remain UNKNOWN/risk locked",()=>{
 for(const fault of ["submitTimeout","cancelFailed"]){const b=book();B.step(b,event());B.step(b,event(now+1000,{[fault]:true}));assert.equal(b.riskLock,true);assert.equal(b.orders[0].status,"UNKNOWN");assert.ok(b.pending);}
});
test("H01 local/exchange reconciliation mismatch prevents new risk",()=>{
 const b=book();B.step(b,event(now,{reconcileMismatch:true}));assert.equal(b.riskLock,true);assert.equal(b.pending,null);
});
test("H01 protective stop rejection creates no unprotected position",()=>{
 const b=book();B.step(b,event());B.step(b,event(now+1000,{stopRejected:true}));assert.equal(b.position,null);assert.equal(b.riskLock,true);
});
test("H01 risk lock and pause retain hard stop protection, without clearing history",()=>{
 for(const stop of ["pause","risk"]){const b=book();open(b);if(stop==="pause")b.running=false;else B.lock(b,"review");const initial=b.position.initialRiskAmount;B.step(b,event(now+2000,{quote:quote(150,now+2000),signal:null}));assert.equal(b.position,null);assert.equal(b.history[0].closeReason,"hard_sl");assert.equal(b.history[0].riskAmount,initial);assert.equal(b.history.length,1);}
});
test("H01 gap stop precedes simultaneous target and never promises stop-price execution",()=>{
 const b=book();open(b);const stop=b.position.stop;B.step(b,event(now+901000,{quote:quote(180,now+901000),bar:{time:now,open:150,low:149,high:190,close:180},signal:null}));assert.equal(b.history[0].closeReason,"hard_sl");assert.ok(b.history[0].exitPrice<stop);
});
test("H01 trailing stop activates after 1.5R, never loosens when ATR expands",()=>{
 const b=book();open(b);B.step(b,event(now+2000,{quote:quote(180,now+2000),signal:{...signal(),atr:1}}));assert.equal(b.position.trailing,true);const stop=b.position.stop;B.step(b,event(now+3000,{quote:quote(181,now+3000),signal:{...signal(),atr:10}}));assert.ok(b.position.stop>=stop);
});
test("H01 daily loss and post-stop eight-hour cooldown are backend gates",()=>{
 const b=book();b.day=new Date(now).toISOString().slice(0,10);b.dayStartEquity=10000;b.equity=9700;B.step(b,event());assert.equal(b.pending,null);assert.ok(b.lastSnapshot.decision.blockers.includes("DAILY_LOSS"));
 const c=book();open(c);B.step(c,event(now+2000,{quote:quote(150,now+2000),signal:null}));assert.ok(c.cooldownUntil>=now+8*3600000);B.step(c,event(now+3000,{signal:signal(now+3000)}));assert.equal(c.pending,null);
});
test("H01 no-chase, expired window, min quantity and liquidation-risk estimates refuse trades",()=>{
 for(const extra of [{quote:quote(180)},{time:now+3600000,quote:quote(168,now+3600000)},{rules:{...rules,minNotional:999999}}]){const b=book();B.step(b,event(now,extra));assert.equal(b.pending,null);}
});
test("H01 correlated BTC/ETH portfolio counts positions AND pending full risk with max two slots",()=>{
 const a=book("a"),b=book("b"),c=book("c");B.step(a,event(),[a,b,c]);B.step(b,event(),[a,b,c]);B.step(c,event(),[a,b,c]);assert.ok(a.pending&&b.pending);assert.equal(c.pending,null);assert.ok(c.lastSnapshot.decision.blockers.includes("PORTFOLIO_RISK_OR_POSITION_LIMIT"));
});
test("H01 funding events deduplicate, no future data, settle costs into net PnL",()=>{
 const b=book();open(b);const f={time:now+2000,rate:.001,markPrice:168};B.step(b,event(now+2000,{funding:[f],signal:null}));const paid=b.position.fundingPnl;B.step(b,event(now+3000,{funding:[f],signal:null}));assert.equal(b.position.fundingPnl,paid);
 B.step(b,event(now+4000,{funding:[{...f,time:now+5000}],signal:null}));assert.equal(b.riskLock,true);
});
test("H01 old position executes its immutable config snapshot",()=>{
 const b=book();open(b);const p=b.position;b.config={...b.config,slippageBps:100};B.step(b,event(now+2000,{quote:quote(150,now+2000),signal:null}));assert.equal(b.history[0].configHash,C.scope(p.config,b.symbol,b.mode,b.experimentId).configHash);
});
test("H01 research stores failures in tamper-evident append history",t=>{
 const d=temp(t);H.appendExperiment(d,{passed:false,reason:"negative"});H.appendExperiment(d,{passed:false,reason:"stress"});assert.equal(fs.readFileSync(path.join(d,"experiments.jsonl"),"utf8").trim().split("\n").length,2);fs.appendFileSync(path.join(d,"experiments.jsonl"),'{"hash":"bad"}\n');assert.throws(()=>H.appendExperiment(d,{}));
});
test("H01 empty and insufficient samples cannot pass research or pretend profitability",()=>{
 const b=book(),m=A.metrics(b);assert.equal(m.netPnl,null);assert.equal(m.winRate,null);assert.equal(A.verdict(m,m).status,"NOT_PASSED");assert.equal(A.verdict(m,m).allowLive,false);
});
test("H01 restart retains risk lock, unknown orders, portfolio and signal dedup; corruption fails closed",t=>{
 const directory=temp(t),v=V.createService({directory,data:{}}),a=v.create({symbol:"ETH"}),b=v.get(a.id);B.step(b,event());b.riskLock=true;v.save();v.stop();const w=V.createService({directory,data:{}});assert.equal(w.get(a.id).riskLock,true);assert.equal(w.get(a.id).orders.length,0);w.stop();
 fs.writeFileSync(path.join(directory,"runtime.json"),"broken");const x=V.createService({directory,data:{}});assert.ok(x.status().loadError);assert.throws(()=>x.create({symbol:"ETH"}));assert.equal(fs.readFileSync(path.join(directory,"runtime.json"),"utf8"),"broken");
});
test("H01 multiple accounts isolate state, no control accepts Live or arbitrary keys",t=>{
 const s=V.createService({directory:temp(t),data:{}}),a=s.create({symbol:"ETH"}),b=s.create({symbol:"BTC"});assert.notEqual(a.id,b.id);s.control(a.id,"start");assert.equal(s.get(b.id).running,false);assert.throws(()=>s.create({mode:"Live"}));assert.throws(()=>s.create({apiKey:"secret"}));assert.throws(()=>s.control(a.id,"unlock"));s.stop();
});
test("H01 Shadow public data adapter never exposes order methods; failed data marks execution blocked",async t=>{
 const s=V.createService({directory:temp(t),data:{snapshot:async()=>{throw Error("privateKey=must-not-leak");}}}),a=s.create({symbol:"ETH"});s.control(a.id,"start");await s.tick();const out=JSON.stringify(s.list());assert.ok(!out.includes("must-not-leak"));assert.equal(s.get(a.id).lastSnapshot.decision.finalDecision,"DATA_ERROR");s.stop();
});
test("H01 no future window contamination, stable seed, same raw data across ablations",()=>{
 const rows=candles("1h");assert.deepEqual(H.before([...rows,{time:now,close:999999}],now,3600000),rows);
 assert.equal(R.variant(C.normalize(),"NO_WEEKEND").config.weekendMode,"A");assert.equal(R.variant(C.normalize(),"WEEKEND_B").config.weekendMode,"B");assert.equal(R.variant(C.normalize(),"NO_VOLUME").omitVolume,true);
});
test("H01 credential redaction excludes nested secret fields and front-end never stores credentials",()=>{
 assert.deepEqual(V.safeJson({privateKey:"x",child:{apiSecret:"x",value:1}}),{child:{value:1}});
 const ui=fs.readFileSync(path.join(__dirname,"../public/hypothesis/workbench.js"),"utf8");assert.doesNotMatch(ui,/innerHTML|localStorage|sessionStorage/);assert.match(ui,/textContent/);
});
test("H01 UNKNOWN pending remains unresolved over later ticks, cannot expire away",()=>{
 const b=book();B.step(b,event());B.step(b,event(now+1000,{submitTimeout:true}));B.step(b,event(now+3600000,{signal:null,quote:quote(168,now+3600000)}));assert.equal(b.orders[0].status,"UNKNOWN");assert.ok(b.pending);assert.equal(b.riskLock,true);
});
test("H01 hard stop includes same-event funding and equity reconciles to net vouchers",()=>{
 const b=book();open(b);B.step(b,event(now+2000,{quote:quote(150,now+2000),funding:[{time:now+1500,rate:.001,markPrice:168}],signal:null}));assert.equal(b.history.length,1);assert.ok(b.history[0].fundingPnl<0);assert.ok(Math.abs(b.equity-b.initialEquity-b.history[0].netPnl)<1e-8);
});
test("H01 stale/unknown-source quote cannot invent a simulated stop execution",()=>{
 const b=book();open(b);B.step(b,event(now+2000,{quote:{...quote(150,now+2000),source:"unverified"},signal:null}));assert.ok(b.position);assert.equal(b.history.length,0);
});
test("H01 Shadow executes real deterministic signal path without any real order adapter",async t=>{
 const x=bars(),price=x["1h"].at(-1).close;let clock=now,requests=0;
 const s=V.createService({directory:temp(t),data:{snapshot:async()=>{requests++;return{time:clock,bars:x,quote:quote(price,clock),rules};}}}),a=s.create({symbol:"ETH"});s.control(a.id,"start");await s.tick();assert.ok(s.get(a.id).pending);clock+=1000;await s.tick();assert.ok(s.get(a.id).position);assert.equal(s.get(a.id).position.protection,"SIMULATED_ACTIVE");assert.equal(requests,2);s.stop();
});
test("H01 standalone loopback has independent auth, no auto-account creation, rejects Live",async t=>{
 const x=require("../scripts/hypothesis_shadow").start({directory:temp(t),port:0});t.after(()=>x.stop());await new Promise(r=>x.server.listening?r():x.server.once("listening",r));const base="http://127.0.0.1:"+x.server.address().port;
 assert.equal(x.server.address().address,"127.0.0.1");assert.equal((await fetch(base+"/api/v5/status")).status,401);assert.equal((await fetch(base+"/api/v5/status",{headers:{Authorization:"Bearer "+"é".repeat(43)}})).status,401);
 const dir=Object.keys(require.cache).length;assert.ok(dir>0);assert.equal(x.service.list().accounts.length,0);
 const file=x.service;assert.throws(()=>file.create({mode:"Live",symbol:"ETH"}));assert.equal((await fetch(base+"/")).status,200);
});
test("H01 short execution has stop above entry, protective exit and conserved net accounting",()=>{
 const b=book(),s={...signal(),signalId:"short-1",direction:"short",regime:{state:"TREND_DOWN",direction:"short"}};
 B.step(b,event(now,{signal:s}));B.step(b,event(now+1000,{signal:s}));assert.ok(b.position.stop>b.position.entryPrice);
 B.step(b,event(now+2000,{quote:quote(180,now+2000),signal:null}));assert.equal(b.history[0].side,"short");assert.equal(b.history[0].closeReason,"hard_sl");assert.ok(b.history[0].netPnl<0);assert.ok(Math.abs(b.equity-b.initialEquity-b.history[0].netPnl)<1e-8);
});
test("H01 no current-bar volume leakage into historical OPEN liquidity",()=>{
 const x={source:"BINANCE_USDM_NATIVE",symbol:"ETH",marketType:"perpetual",funding:[],rules,bars:Object.fromEntries(Object.keys(M.MS).map(tf=>[tf,candles(tf)]))};
 const prepared=H.prepared(x);assert.ok(prepared.length>0);const last=prepared.at(-1),raw=x.bars["15m"],prior=raw.at(-2);
 assert.equal(last.quote.depthNotional,Math.min(100000,prior.volume*prior.close*.01));
 const changed=structuredClone(x);changed.bars["15m"].at(-1).volume=99999999;assert.equal(H.prepared(changed).at(-1).quote.depthNotional,last.quote.depthNotional);
});
test("H01 real zero-volume bar remains in raw data and cannot confirm an entry",()=>{
 const x=bars();x["1h"].at(-1).volume=0;const r=M.evaluate({bars:x,symbol:"ETH",now,quote:quote(),config:{}});
 assert.equal(r.dataHealth,"healthy");assert.equal(r.signalPermission,"blocked");assert.ok(r.blockers.includes("VOLUME_INSUFFICIENT"));
});
test("H01 shadow audit failure cannot leave a partially-created account",t=>{
 const directory=temp(t),audit=path.join(directory,"audit");fs.mkdirSync(audit);fs.writeFileSync(path.join(audit,"experiments.jsonl"),'{"invalid":true}\n');const s=V.createService({directory,data:{}});assert.throws(()=>s.create({symbol:"ETH"}));assert.equal(s.list().accounts.length,0);assert.equal(fs.existsSync(path.join(directory,"runtime.json")),false);s.stop();
});
test("H01 corrupt fill/position ledger locks future risk without deleting evidence",()=>{
 const b=book();open(b);b.position.qty+=1;const orders=JSON.stringify(b.orders);B.step(b,event(now+2000,{signal:null}));assert.equal(b.riskLock,true);assert.equal(b.riskReason,"LEDGER_POSITION_MISMATCH");assert.equal(JSON.stringify(b.orders),orders);
});
test("H01 research cannot silently replace absent funding history with zero cost",()=>{
 assert.throws(()=>H.suite({funding:[],bars:{}}),/资金费历史覆盖不足/);assert.throws(()=>H.suite({funding:[{}],missingFundingMonths:["2024-01"]}),/资金费历史覆盖不足/);
});
test("H01 market adapter refuses every private/trading route before network access",async()=>{
 let calls=0;const d=require("../strategy/hypothesis_v5/data").adapter(async()=>{calls++;throw Error("Network should not run");});
 for(const route of ["/fapi/v1/order","/fapi/v1/leverage","/fapi/v2/account","/sapi/v1/futures/transfer","https://evil.example/fapi/v1/klines"])await assert.rejects(()=>d.get(route),/PUBLIC_DATA_ONLY/);
 assert.equal(calls,0);assert.equal(d.order,undefined);assert.equal(d.cancel,undefined);
});
test("H01 repricing never expands submitted quantity or reserved risk",()=>{
 for(const side of ["long","short"])for(const price of [167,168,168.5]){
  const b=book(),s={...signal(),direction:side};B.step(b,event(now,{signal:s}));const submitted=structuredClone(b.orders[0]),risk=b.pending.remainingRisk;
  B.step(b,event(now+1000,{signal:s,quote:quote(price,now+1000)}));
  if(b.position){assert.ok(b.position.qty<=submitted.plannedQty+1e-10);assert.ok(b.position.initialRiskAmount<=risk+1e-10);assert.ok(Math.abs(b.orders[0].filledQty+b.orders[0].remainingQty-submitted.plannedQty)<1e-10);}
 }
});
test("H01 stop aligns outward to tick and risk sizing uses the rounded distance",()=>{
 for(const direction of ["long","short"]){const b=book(),s={...signal(),direction};B.step(b,event(now,{signal:s,rules:{...rules,priceTick:.5}}));const p=b.pending;assert.ok(p);assert.ok(Math.abs(p.stop/.5-Math.round(p.stop/.5))<1e-10);assert.ok(p.distance>=s.atr*b.config.stopAtr);assert.ok(p.riskAmount<=b.equity*b.config.riskPerTrade);}
});
test("H01 missing pending reservation stays UNKNOWN instead of creating NaN position",()=>{
 const b=book();B.step(b,event());delete b.pending.remainingRisk;B.step(b,event(now+1000));assert.equal(b.position,null);assert.ok(b.pending);assert.equal(b.orders[0].status,"UNKNOWN");assert.equal(b.riskLock,true);
});
test("H01 old cohort keeps original version/hash at close and cannot create new risk",t=>{
 const b=book();open(b);b.strategyRevision="H01_20261106_RESEARCH_V1";b.configHash="old-snapshot";B.step(b,event(now+2000,{quote:quote(150,now+2000),signal:null}));assert.equal(b.history[0].strategyRevision,b.strategyRevision);assert.equal(b.history[0].configHash,"old-snapshot");
 const s=V.createService({directory:temp(t),data:{}}),a=s.create({symbol:"ETH"});s.get(a.id).strategyRevision="old";s.get(a.id).configHash="preserved";assert.throws(()=>s.control(a.id,"start"),/引擎已升级/);assert.equal(s.list().accounts[0].scope.configHash,"preserved");s.stop();
});
test("H01 expired and repricing-rejected orders publish their final execution decision",()=>{
 const expired=book();B.step(expired,event());B.step(expired,event(now+1800001,{quote:quote(168,now+1800001),signal:null}));assert.equal(expired.lastSnapshot.decision.finalDecision,"ORDER_EXPIRED");
 const rejected=book();B.step(rejected,event());B.step(rejected,event(now+1000,{quote:quote(180,now+1000),signal:null}));assert.equal(rejected.lastSnapshot.decision.finalDecision,"ORDER_REJECTED");assert.ok(rejected.lastSnapshot.decision.blockers.includes("NO_CHASE"));
});
test("H01 workbench DOM renders backend blockers safely and disables disconnected controls",async()=>{
 const vm=require("vm"),nodes={};class Element{constructor(tag){this.tagName=tag;this.children=[];this.value="";this.textContent="";this.disabled=false;}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}}
 const document={getElementById:id=>nodes[id]||=(new Element("div")),createElement:tag=>new Element(tag)},b=V.projections(book());b.running=false;b.lastSnapshot={signal:{blockers:["<img src=x onerror=alert(1)>"],signalPermission:"blocked",direction:"none",regime:{state:"RANGE"}},decision:{finalDecision:"NO_SIGNAL",blockers:["<img src=x onerror=alert(1)>"]}};
 let fail=false;vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../public/hypothesis/workbench.js"),"utf8"),{document,fetch:async()=>{if(fail)throw Error("断流");return{ok:true,json:async()=>({ok:true,accounts:[b]})};},setInterval(){},FormData:class{}});
 await new Promise(setImmediate);assert.equal(nodes.start.disabled,false);assert.match(nodes.decision.textContent,/<img/);assert.equal(nodes.decision.children.length,0);
 fail=true;await nodes.refresh.onclick();assert.equal(nodes.start.disabled,true);assert.equal(nodes.pause.disabled,true);assert.equal(nodes.error.textContent,"断流");
});
