"use strict";
const {test}=require("node:test"), assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const C=require("../strategy/funding_carry/config"), B=require("../strategy/funding_carry/book"), M=require("../strategy/funding_carry/market"), R=require("../strategy/funding_carry/runtime");
const h=M.HOUR, epoch=Date.UTC(2026,0,7), start=epoch+h;
const account={id:"carry-1",name:"Paper carry",platform:"binance",symbol:"ETH",quoteAsset:"USDT",strategyType:C.ID,
 tradeMode:"simulation",simulationEnabled:true,simulationBalance:10000,leverage:1,carryConfig:C.defaults};
const rules={steps:[.001],minQty:.001,maxQty:1000,minNotional:5,maxNotional:Infinity};
function market(time=start) {
 const book=mid=>({bids:[[mid-.05,1000]],asks:[[mid+.05,1000]]});
 return {source:"binance_spot_usdm",symbol:"ETHUSDT",time,spotRequestedAt:time-500,perpTime:time-100,markTime:time-100,
  spot:book(2000),perp:book(2002),rate:.002,nextFundingAt:epoch+8*h,markPrice:2000,spotRules:rules,perpRules:rules,
  funding:Array.from({length:6},(_,i)=>({time:epoch-(5-i)*8*h,mark:2000,rate:.002}))};
}
const initial=()=>({...B.initial(account),running:true});
function hedge() {
 const open=B.advance(initial(),market(),C.defaults);
 return B.advance(open,market(start+15000),C.defaults);
}
test("Carry requires continuous funding evidence, positive net cost-adjusted edge, matching quantity and executable book depth",()=>{
 const data=market();
 assert.equal(B.quotePlan(data,C.defaults,10000).code,"ENTRY_READY");
 assert.equal(B.quotePlan({...data,rate:.00001},C.defaults,10000).code,"COST_BLOCK");
 assert.equal(B.quotePlan({...data,rate:-.01},C.defaults,10000).code,"RATE_BLOCK");
 assert.equal(B.quotePlan({...data,funding:data.funding.slice(1)},C.defaults,10000).code,"FUNDING_BLOCK");
 const thin={...data,perp:{...data.perp,bids:[[2001.95,.001]]}};
 assert.equal(B.quotePlan(thin,C.defaults,10000).code,"SIZE_BLOCK");
 assert.throws(()=>M.validate({...data,perpTime:start-20000},account,start),/过期/);
});
test("The isolated spot leg persists, rejects replayed futures quotes, and unwinds if the second leg fails",()=>{
 const first=B.advance(initial(),market(),C.defaults);
 assert.ok(first.position?.spot);
 assert.equal(first.position.perp,null);
 const repeated={...market(start+15000),perpTime:market().perpTime};
 assert.equal(B.advance(first,repeated,C.defaults).position.perp,null);
 const next=B.advance(first,{...market(start+15000),rate:0},C.defaults);
 assert.equal(next.position,null);
 assert.equal(next.trades[0].reason,"hedge_failed");
 assert.ok(next.realized<0);
 assert.equal(next.trades[0].fundingPnl,0);
});
test("Settles observed funding once, accounts for basis and slippage separately, and honours paused exit",()=>{
 const first=hedge(), time=epoch+8*h+1000, data=market(time);
 assert.ok(first.position.perp);
 data.funding.push({time:epoch+8*h,mark:2000,rate:.002});
 data.nextFundingAt+=8*h;
 const held=B.advance(first,data,C.defaults);
 assert.equal(held.position.funding,held.position.qty*4);
 const later={...data,time:time+15000,rate:-.001};
 const closed=B.advance({...held,running:false},later,C.defaults);
 assert.equal(closed.position,null);
 const trade=closed.trades[0];
 assert.equal(trade.reason,"rate_reversed");
 assert.equal(trade.fundingPnl,held.position.funding);
 assert.ok(Math.abs(trade.netPnl-(trade.basisPnl+trade.unhedgedPnl+trade.fundingPnl-trade.slippageAmount-trade.tradingFee))<1e-9);
 assert.equal(closed.running,false);
});
test("A missing exchange funding row defers financial settlement and blocks further entries",()=>{
 const time=epoch+8*h+120000, data=market(time);
 const incomplete=B.advance(hedge(),data,C.defaults);
 assert.equal(incomplete.decision.code,"RECONCILING");
 assert.equal(incomplete.realized,0);
 assert.equal(incomplete.trades.length,0);
 const next={...data,time:time+15000,funding:[...data.funding,{time:epoch+8*h+14,mark:2000,rate:.002}]};
 const closed=B.advance(incomplete,next,C.defaults);
 assert.equal(closed.position,null);
 assert.ok(closed.trades[0].fundingPnl>0);
 assert.equal(B.advance(closed,next,C.defaults).trades.length,1);
});
test("Paper identity and ledger restoration preserve both legs and refuse credentials, Live, and stale saves",async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"carry-test-"));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let now=start;
 const options={directory,now:()=>now,provider:{load:async()=>market(now)}};
 let engine=R.create(options);
 engine.commit(account,engine.initial(account));
 assert.equal(engine.view(account).running,false);
 await engine.refresh(account);
 engine.control(account,{},"start");
 await engine.tick(account,{});
 engine=R.create(options);
 now+=15000;
 await engine.tick(account,{});
 assert.equal(engine.view(account).carry.phase,"hedged");
 assert.equal(engine.configure(account,{allocationPct:.15},C.hash(C.defaults)).nextCycleOnly,true);
 assert.throws(()=>engine.configure(account,C.defaults,"wrong"),/CONFIG_CONFLICT/);
 assert.throws(()=>engine.get({...account,apiKey:"fixture"}),/PAPER_ONLY/);
 assert.throws(()=>engine.get({...account,tradeMode:"live"}),/PAPER_ONLY/);
 assert.equal(fs.existsSync(path.join(directory,"turtle_4h_paper.json")),false);
});
