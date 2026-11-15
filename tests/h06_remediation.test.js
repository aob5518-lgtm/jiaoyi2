"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const C=require('../strategy/macd_scale_in/config'),B=require('../strategy/macd_scale_in/book'),D=require('../strategy/macd_scale_in/diagnostics'),{createRuntime}=require('../strategy/macd_scale_in/runtime');
const T=Date.UTC(2024,0,1),H=3600000,account={id:'h06-lifecycle',platform:'binance',symbol:'ETH',quoteAsset:'USDT',strategyType:C.ID,h06Mode:'Paper',tradeMode:'simulation',simulationEnabled:true,simulationBalance:10000,h06Config:C.normalize({})};
const event=(n,price=2000,side='long')=>({time:T+n*H+100,price,running:true,marketOK:true,account,rules:{qtyStep:.001,minQty:.001,minNotional:5},signal:side?{id:'signal-'+n+'-'+side,side,closedTime:T+n*H,availableAt:T+n*H,atr:10}:null,permit:()=>({allowed:true})});
function open(c={}){const config=C.normalize(c),e=event(1),b=B.execute(B.advance(B.initial(account),e,config),{...e,time:e.time+2000});return{b,c:config};}
function act(x,e,result={}){x.b=B.advance(x.b,e,x.c);if(x.b.pending)x.b=B.execute(x.b,{...e,time:e.time+2000},result);return x.b;}
function directory(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'h06-lifecycle-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('首仓待成交时锁定配置，保存的新风险/费用/杠杆不改订单',()=>{
 const e=event(1),old=C.normalize({}),changed=C.normalize({leverage:5,maxCycleLossPct:.005,entryFeeRate:.001,maxParticipationPct:.0001});let b=B.advance(B.initial(account),e,old);
 const before=JSON.stringify(b.pending.meta),next=B.advance(b,{...e,time:e.time+500,signal:null},changed);assert.equal(JSON.stringify(next.pending.meta),before);
 const filled=B.execute(next,{...e,time:e.time+2000});assert.deepEqual(filled.cycle.config,old);assert.equal(filled.cycle.riskBudget,100);assert.ok(filled.cycle.marginUsed<101);
});
test('运行层首仓待成交也使用提交快照核验行情与盘口参与率',async t=>{
 const e=event(300),old=C.normalize({}),changed=C.normalize({maxParticipationPct:.0001,leverage:5}),a={...account,h06Config:changed},dir=directory(t);let seen;
 const candles=Array.from({length:300},(_,i)=>({time:T+i*H,open:2000,high:2001,low:1999,close:2000,volume:10}));
 const provider={load:async(a,c)=>{seen=c;return{source:'binance_usdm_native',symbol:'ETHUSDT',quoteAsset:'USDT',marketType:'perpetual',candles,quote:{bid:1999.9,ask:2000.1,price:2000,bidQty:2,askQty:2,timestamp:e.time+2000,symbol:'ETHUSDT'},rules:e.rules,funding:[],fundingComplete:true};}};
 let r=createRuntime({directory:dir,provider,now:()=>e.time+2000,permit:()=>({allowed:true})});r.commit(a,B.advance(B.initial(account),e,old));
 r=createRuntime({directory:dir,provider,now:()=>e.time+2000,permit:()=>({allowed:true})});assert.equal(r.report(a).configuration.activeSource,'pending_order');assert.equal(r.report(a).configuration.different,true);
 await r.tick(a,{running:true});assert.deepEqual(seen,old);assert.ok(r.get(a).cycle.qty>.001);assert.deepEqual(r.get(a).cycle.config,old);assert.deepEqual(r.report(a).config,changed);
});
test('补仓待成交及重启保留原轮次风险、层级和费用',t=>{
 const x=open(),e=event(2,1950);x.b=B.advance(x.b,e,x.c);assert.equal(x.b.pending.kind,'add');const dir=directory(t),newConfig=C.normalize({maxAdds:0,leverage:5,maxCycleLossPct:.001});
 let r=createRuntime({directory:dir});r.commit(account,x.b);r=createRuntime({directory:dir});const b=B.execute(B.advance(r.get(account),{...e,time:e.time+1000,signal:null},newConfig),{...e,time:e.time+2000});assert.deepEqual(b.cycle.config,x.c);assert.equal(b.cycle.entries.length,2);assert.equal(b.cycle.riskBudget,100);assert.equal(b.cycle.layers[1].marginBudget,100);
});
test('分批止盈待成交/部分成交/重启后仍按旧目标与剩余数量完成',t=>{
 const x=open({leverage:5}),e=event(2,2500,null);x.b=B.advance(x.b,e,x.c);assert.equal(x.b.pending.kind,'partial');const qty=x.b.pending.qty,original=x.b.cycle.qty;
 x.b=B.execute(x.b,{...e,time:e.time+2000,quoteId:'A'},{fillFraction:.5});assert.equal(x.b.pending.status,'PARTIALLY_FILLED');const dir=directory(t);let r=createRuntime({directory:dir});r.commit(account,x.b);r=createRuntime({directory:dir});
 const next=C.normalize({takeProfitRoiPct:20,partialClosePct:99,leverage:1,exitFeeRate:.005});let b=B.advance(r.get(account),{...e,time:e.time+3000},next);b=B.execute(b,{...e,time:e.time+4000,quoteId:'A'});assert.equal(b.pending.filledQty,x.b.pending.filledQty);
 b=B.execute(b,{...e,time:e.time+5000,quoteId:'B'});assert.equal(b.pending,null);assert.equal(b.cycle.partialTpDone,true);assert.deepEqual(b.cycle.config,x.c);assert.ok(Math.abs(original-b.cycle.qty-qty)<1e-8);assert.equal(b.cycle.exits.length,2);assert.equal(b.orders.at(-1).fills.length,2);
});
test('未知首仓订单在新配置和重启后不会丢失或假成交',t=>{
 const e=event(1);let b=B.execute(B.advance(B.initial(account),e,C.normalize({})),{...e,time:e.time+2000},{status:'UNKNOWN'});const dir=directory(t);let r=createRuntime({directory:dir});r.commit(account,b);r=createRuntime({directory:dir});b=B.advance(r.get(account),event(2),C.normalize({leverage:5}));assert.equal(b.pending.status,'UNKNOWN');assert.equal(b.cycle,null);assert.equal(b.riskLock,true);
});
test('活动委托当前快照与窗口新增委托分开，历史活动订单不算新增',()=>{
 const s=D.stats([],T,T+H,{orders:[{id:'old',kind:'open',submittedAt:T-H,status:'SUBMITTED',qty:1},{id:'new',kind:'add',submittedAt:T+1,status:'SUBMITTED',qty:1}]});assert.equal(s.activeOrdersNow,2);assert.equal(s.newOrdersInWindow,1);assert.equal(s.submittedEntries,1);
});
test('跨窗口部分成交和完成成交独立去重，不按轮询或重复信号累加',()=>{
 const o={id:'o',kind:'partial',submittedAt:T-H,status:'FILLED',qty:1,filledQty:1,lastFillTime:T+2000,terminalAt:T+2000,fills:[{id:'a',time:T-1000,qty:.5,cumulativeQty:.5},{id:'b',time:T+2000,qty:.5,cumulativeQty:1}]};
 const rows=[{time:T,orderFacts:[o]},{time:T+1,orderFacts:[o]}],s=D.stats(rows,T,T+H,{orders:[o]});assert.equal(s.newOrdersInWindow,0);assert.equal(s.fillEventsInWindow,1);assert.equal(s.ordersWithPartialFillInWindow,0);assert.equal(s.ordersCompletedInWindow,1);assert.equal(s.filledExits,1);assert.equal(s.activeOrdersNow,0);
 const all=D.stats(rows,T-H,T+H,{orders:[o]});assert.equal(all.ordersWithPartialFillInWindow,1);assert.equal(all.ordersCompletedInWindow,1);assert.equal(all.ordersWithFillInWindow,1);assert.equal(all.fillEventsInWindow,2);
});
test('部分成交后撤销的首仓不是完成成交，事件重复ID只计一次',()=>{
 const f={id:'same',time:T+1,qty:.5,cumulativeQty:.5},o={id:'open',kind:'open',submittedAt:T,status:'PARTIALLY_FILLED_CANCELLED',qty:1,filledQty:.5,terminalAt:T+2,fills:[f,f]};const s=D.stats([],T,T+H,{orders:[o]});assert.equal(s.ordersWithPartialFillInWindow,1);assert.equal(s.ordersCompletedInWindow,0);assert.equal(s.fillEventsInWindow,1);assert.equal(s.activeOrdersNow,0);
});
test('已落盘但缺失signalJournal的成交仍可核对；旧事实不伪造事件',()=>{
 const s=D.stats([],T,T+H,{orders:[{id:'durable',kind:'open',status:'FILLED',qty:1,filledQty:1,submittedAt:T,lastFillTime:T+100}]});assert.equal(s.ordersWithFillInWindow,1);assert.equal(s.fillEventsInWindow,0);assert.equal(s.legacyFillOrders,1);
});
test('阶段最高ROI按当时保证金记录，不用最终保证金倒算',()=>{
 const x=open();act(x,event(2,2100,null));const peak=x.b.cycle.audit.maximumRoiPct;act(x,event(3,1900));assert.equal(x.b.cycle.entries.length,2);assert.ok(x.b.cycle.audit.maximumRoiPct>=peak);assert.equal(x.b.cycle.audit.stages.length,2);assert.ok(peak>100*x.b.cycle.maximumFavorableExcursion/x.b.cycle.marginUsed);
});
test('100%ROI机制不是统计遗漏，目标观测、委托、成交与flag一致',()=>{
 const x=open({leverage:5});act(x,event(2,2500,null));act(x,event(3,2450,'short'));const h=x.b.history[0];assert.equal(h.audit.targetObserved,true);assert.ok(h.audit.maximumRoiPct>=100);assert.equal(h.audit.partialOrderIds.length,1);assert.equal(h.exits.filter(v=>v.reason==='roi_partial').length,1);assert.equal(h.partialTpDone,true);assert.equal(h.closeReason,'reverse_after_partial');
});
test('每层费用/资金费/退出损益分摊与最终净收益一致',()=>{
 const x=open({leverage:5,takeProfitRoiPct:20});act(x,event(2,1970));act(x,{...event(3,1990,null),funding:[{time:T+2*H+5000,markPrice:1970,rate:.001}]});act(x,event(4,2300,null));act(x,event(5,2250,'short'));const h=x.b.history[0];assert.ok(h);assert.ok(Math.abs(h.audit.attributionDelta)<1e-7);assert.equal(h.audit.layerAttribution.length,2);assert.ok(h.audit.stages[1].maximumFloatingNetLoss>=0);assert.ok(h.audit.stages[1].stopRiskAmount<=100+1e-5);
});
test('研究门槛和关闭反向退出只能离线使用，正式配置拒绝',()=>{
 assert.throws(()=>C.normalize({maxAddRiskFraction:.5}),/CONFIG_FIELDS/);assert.throws(()=>C.normalize({hardExitOnly:true}),/CONFIG_FIELDS/);assert.equal(C.defaults.leverage,1);assert.equal(C.defaults.takeProfitRoiPct,100);assert.equal(C.defaults.maxAdds,3);
});
test('原生验收仅允许Binance公共GET，不引入交易适配器',()=>{
 const script=fs.readFileSync(path.join(__dirname,'../scripts/h06_native_acceptance.js'),'utf8'),{allowedPaths}=require('../scripts/h06_native_acceptance');assert.equal(allowedPaths.size,4);assert.ok([...allowedPaths].every(p=>!p.includes('order')));assert.ok(script.includes("credentials:'omit'"));assert.ok(script.includes("u.origin!==P.BASE"));assert.ok(!script.includes("require('../exchanges"));
});

test('Binance ETH/BTC公共响应解析：原生时间、资金费、交易规格及断流恢复（合成响应）',async()=>{
 const P=require('../strategy/macd_scale_in/provider');
 for(const symbol of ['ETH','BTC']){const a={...account,symbol},calls=[],now=T+500*H;let offline=false;
  const provider=P.createProvider(async url=>{calls.push(url);if(offline)throw Error('synthetic disconnect');const u=new URL(url);assert.equal(u.origin,P.BASE);
   if(u.pathname.endsWith('exchangeInfo'))return{symbols:[{symbol:symbol+'USDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',filters:[{filterType:'MARKET_LOT_SIZE',minQty:'.001',stepSize:'.001',maxQty:'1000'},{filterType:'PRICE_FILTER',tickSize:'.01'},{filterType:'MIN_NOTIONAL',notional:'5'}]}]};
   if(u.pathname.endsWith('bookTicker'))return{symbol:symbol+'USDT',time:now,bidPrice:'2000',askPrice:'2000.1',bidQty:'5',askQty:'6'};
   if(u.pathname.endsWith('fundingRate'))return[{fundingTime:now-8*H,fundingRate:'.0001',markPrice:'1990'}];
   if(u.pathname.endsWith('klines'))return Array.from({length:500},(_,i)=>[T+i*H,'2000','2001','1999','2000','10']);throw Error('unexpected public endpoint');
  });
  const first=await provider.load(a,C.defaults,now-24*H);assert.equal(P.validate(first,a,C.defaults,now+100),null);assert.equal(first.quote.timestamp,now);assert.equal(first.receivedAt,first.quote.receivedAt);assert.equal(first.candles.length,500);assert.equal(first.funding[0].markPrice,1990);assert.equal(first.rules.qtyStep,.001);assert.equal(first.rules.priceTick,.01);assert.ok(calls.every(v=>!v.includes('signature')));
  offline=true;await assert.rejects(provider.load(a,C.defaults),/synthetic disconnect/);offline=false;const recovered=await provider.load(a,C.defaults);assert.equal(recovered.source,'binance_usdm_native');assert.equal(P.validate({...recovered,source:'other_venue'},a,C.defaults,now)[0],'SOURCE_MISMATCH');assert.equal(P.validate({...recovered,quote:{...recovered.quote,timestamp:undefined}},a,C.defaults,now)[0],'QUOTE_STALE');
 }
});
