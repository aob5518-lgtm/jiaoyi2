"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {Readable} = require("node:stream");
const Live = require("../terminal/classic-live");
const C = require("../terminal/classic-paper");
const {handle} = require("../terminal/desk");
const {create: createAdapter} = require("../terminal/hotcoin-execution");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"classic-live-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const account = {id:"live-eth",platform:"hotcoin",tradeMode:"live",strategyType:"connection_only",
    symbol:"ETH",quoteAsset:"USDT",apiKey:"test-key",apiSecret:"test-secret"};
  let time = 1_800_000_000_000;
  const market = {positions:[],working:[],balance:500,available:500,unrealizedPnl:0,mode:1,
    bid:999.99,ask:1000,bidSize:200,askSize:200,spec:{unit:.01,step:1,digits:2,maxLeverage:200},
    leverage:{long:2,short:3},limits:{long:100,short:100},feeRate:.0006};
  const intents = [], replies = new Map();
  const exchange = {
    snapshot:async () => ({...structuredClone(market),at:time}),
    place:async (_account,intent) => {intents.push(intent);return String(100+intents.length);},
    order:async (_account,id) => replies.get(id)
  };
  const make = () => Live.create({directory,exchange,now:()=>time});
  return {account,market,exchange,intents,replies,live:make(),make,advance:(ms=61_000)=>{time+=ms;}};
}

test("Hotcoin classic tracks a real-order acknowledgement, partial add and native close separately",async t=>{
  const {account,market,live,intents,replies,make,advance}=fixture(t);
  live.configure(account,{leverage:2});
  assert.equal(intents.length,0);
  await live.start(account);
  await live.tick(account);
  assert.deepEqual([intents[0].side,intents[0].kind,intents[0].contracts,intents[0].price],["long","open",10,"1000.00"]);
  assert.ok(live.get(account.id).pending);
  assert.equal(live.get(account.id).position,null);
  replies.set("101",{side:"open_long",status:2,contracts:10,price:1000,fee:.06});
  market.positions=[{market:"ETHUSDT",id:"147",side:"long",qty:10,entry:1000,leverage:2}];
  const recovered=make();
  await recovered.tick(account);
  assert.equal(intents.length,1);
  assert.equal(recovered.get(account.id).position.qty,.1);
  assert.throws(()=>recovered.configure(account,{leverage:3}),/暂停并结清/);
  market.bid=979.99;market.ask=980;advance();
  await recovered.tick(account);
  assert.equal(intents[1].kind,"add");
  assert.equal(intents[1].positionId,"147");
  replies.set("102",{side:"open_long",status:1,contracts:3,price:980,fee:.01764});
  market.positions[0]={...market.positions[0],qty:13,entry:995.38};
  await recovered.tick(account);
  assert.equal(recovered.get(account.id).position.contracts,10);
  assert.ok(recovered.get(account.id).pending);
  replies.get("102").status=-1;
  await recovered.tick(account);
  assert.equal(recovered.get(account.id).position.contracts,13);
  assert.equal(recovered.get(account.id).position.adds,1);
  recovered.pause(account);
  market.bid=1010;market.ask=1010.01;
  await recovered.tick(account);
  assert.deepEqual([intents[2].kind,intents[2].positionId,intents[2].contracts],["close","147",13]);
  replies.set("103",{side:"close_long",status:2,contracts:13,price:1010,fee:.07878});
  await recovered.tick(account).then(()=>assert.fail("await native settlement"),error=>assert.match(error.message,/尚未/));
  market.positions=[];
  await recovered.tick(account);
  const done=make().get(account.id);
  assert.equal(done.running,false);
  assert.equal(done.pending,null);
  assert.equal(done.position,null);
  assert.equal(done.trades.length,1);
  assert.equal(done.trades[0].sampleType,"Live");
  assert.ok(Math.abs(done.trades[0].tradingFee-.15642)<1e-9);
  assert.ok(done.trades[0].netPnl>0);
});

test("An acknowledgement timeout is persisted before sending and never resubmits after restart",async t=>{
  const {account,live,make,exchange}=fixture(t);
  live.configure(account,{leverage:2});
  await live.start(account);
  let submissions=0;
  exchange.place=async ()=>{
    submissions++;
    assert.equal(make().get(account.id).pending.exchangeId,null);
    throw Error("network timeout");
  };
  await assert.rejects(live.tick(account),/委托未确认/);
  const recovered=make();
  await assert.rejects(recovered.tick(account),/未知 Hotcoin 委托/);
  assert.equal(recovered.get(account.id).running,false);
  assert.equal((await recovered.preflight(account)).allowed,false);
  assert.equal(submissions,1);
});

test("Native preflight rejects leverage mismatch, foreign exposure, working orders and sub-contract sizing",async t=>{
  const {account,market,live,intents}=fixture(t);
  live.configure(account,{leverage:1});
  assert.match((await live.preflight(account)).blockers[0],/杠杆/);
  live.configure(account,{leverage:2,baseAmount:2});
  assert.match((await live.preflight(account)).blockers[0],/合约规格/);
  live.configure(account,{leverage:2});
  market.working=[null];
  assert.match((await live.preflight(account)).blockers[0],/未完成委托/);
  market.working=[];market.positions=[{side:"long",qty:1,id:"99"}];
  assert.match((await live.preflight(account)).blockers[0],/账本不一致/);
  assert.equal(intents.length,0);
});

test("Workbench routes can configure Live without opening and require explicit start confirmation",async t=>{
  const {account,live,intents}=fixture(t);
  const d={classicPaper:{view:()=>null,get:()=>null,corrupt:()=>false},classicLive:live,
    getAccountById:id=>id===account.id?account:null,getCurrentAccount:()=>account,accounts:()=>[account],
    state:()=>({}),lock:()=>true,unlock:()=>{},json:(_,code,data)=>({code,data})};
  const request=(route="",input)=>{
    const req=Readable.from(input?[JSON.stringify({id:account.id,...input})]:[]);
    req.method=input?"POST":"GET";req.headers={host:"localhost"};
    return handle(req,{}, {pathname:"/api/v4/desk"+route,query:{id:account.id}},d);
  };
  const desk=(await request()).data;
  assert.equal(desk.selected.liveStrategy,true);
  assert.equal(desk.selected.paper,false);
  assert.equal(desk.selected.ready,false);
  assert.equal((await request("/settings",{settings:{...C.defaults,leverage:2}})).code,200);
  assert.equal((await request("/control",{action:"start"})).code,400);
  const {allowed,settingsHash}= (await request("/preflight")).data;
  assert.equal(allowed,true);
  assert.equal((await request("/control",{action:"start",confirm:true,settingsHash:"changed"})).code,400);
  assert.equal((await request("/control",{action:"start",confirm:true,settingsHash})).code,200);
  assert.equal((await request("/control",{action:"pause"})).code,200);
  assert.equal(live.get(account.id).running,false);
  assert.equal(intents.length,0);
});

test("Native order requests sign the correct methods and preserve IDs and signed exchange fees",async t=>{
  const {account}=fixture(t), calls=[];
  const id="90071992547409931";
  const exchange=createAdapter(async (raw,options)=>{
    const url=new URL(raw);
    calls.push({url,options});
    const body=options.method==="POST"?'{"id":'+id+'}':
      '{"id":'+id+',"contractCode":"ethusdt","dealAmount":"2","avgPrice":"999.2","status":2,"detailSide":"close_short","fee":"-0.011"}';
    return {ok:true,text:async()=>body};
  });
  assert.equal(await exchange.place(account,{kind:"open",side:"short",contracts:2,price:"1000.00"}),id);
  assert.equal(await exchange.place(account,{kind:"close",side:"short",contracts:2,positionId:id}),id);
  assert.deepEqual(JSON.parse(calls[0].options.body),{type:"10",side:"open_short",amount:2,price:"1000.00",ioc:1});
  assert.deepEqual(JSON.parse(calls[1].options.body),{type:"11",side:"close_short",amount:2});
  assert.equal(calls[1].url.searchParams.get("positionId"),id);
  assert.equal((await exchange.order(account,id)).fee,.011);
  assert.equal(calls[2].options.method,"GET");
});
