"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {create}=require("../terminal/live-exchange");
const A={id:"native",symbol:"ETH",address:"0x"+"a".repeat(40),privateKey:"test",apiKey:"test-key",apiSecret:"test-secret",publicKey:"public",starkPrivateKey:"stark",vault:"12"};
const response=data=>({ok:true,text:async()=>JSON.stringify(data)});

test("Hyperliquid adapter sends the selected real account and native reduce-only IOC, then reconciles fills and fees",async()=>{
 const calls=[],orders=[],user=A.address;
 const api=create({keyAddress:()=>user,hlClient:()=>({order:async order=>{
  orders.push(order);return {response:{data:{statuses:[{filled:{oid:"553"}}]}}};
 }}),request:async(_url,options)=>{
  const q=JSON.parse(options.body);calls.push(q);
  const payload={
   meta:{universe:[{name:"ETH",szDecimals:4,maxLeverage:50}]},
   clearinghouseState:{marginSummary:{accountValue:"1000"},withdrawable:"900",assetPositions:[]},
   activeAssetData:{coin:"ETH",leverage:{value:5,type:"cross"},maxTradeSzs:["10","10"]},
   l2Book:{time:Date.now(),levels:[[{px:"2000",sz:"3"}],[{px:"2000.1",sz:"3"}]]},
   frontendOpenOrders:[],userFees:{userCrossRate:".00045"},userRole:{role:"user"},
   orderStatus:{status:"order",order:{status:"filled",order:{oid:"553",coin:"ETH",side:"A"}}},
   userFillsByTime:[{oid:"553",sz:".1",px:"2000",fee:".09",feeToken:"USDC"}]
  }[q.type];
  return response(payload);
 }});
 const s=await api.snapshot({...A,platform:"hyperliquid",quoteAsset:"USDC"});
 assert.equal(s.balance,1000);assert.equal(s.positions.length,0);
 const pending={kind:"close",side:"long",contracts:.1,price:"2000.000",localId:"12345678-1234-1234-1234-123456789abc",submittedAt:Date.now()};
 assert.equal(await api.place({...A,platform:"hyperliquid"},pending),"553");
 assert.equal(orders[0].orders[0].r,true);
 assert.equal(orders[0].orders[0].b,false);
 assert.equal(orders[0].orders[0].s,"0.1");
 assert.equal(orders[0].orders[0].t.limit.tif,"Ioc");
 const fill=await api.order({...A,platform:"hyperliquid"},"553",pending);
 assert.equal(fill.contracts,.1);assert.equal(fill.price,2000);assert.equal(fill.fee,.09);
 assert.ok(calls.filter(q=>q.user).every(q=>q.user===user));
});

test("Binance one-way and hedge-mode closes use correct reduce-only/positionSide fields and native order quantities",async()=>{
 const sent=[];
 const api=create({request:async(raw,options)=>{
  const url=new URL(raw);sent.push({url,options});
  assert.equal(url.origin,"https://fapi.binance.com");
  assert.equal(options.headers["X-MBX-APIKEY"],A.apiKey);
  if(options.method==="POST")return response({orderId:"808"});
  if(url.pathname.endsWith("userTrades"))return response([{qty:".05",commission:".04",commissionAsset:"USDT"}]);
  return response({orderId:"808",symbol:"ETHUSDT",status:"FILLED",side:"SELL",executedQty:".05",avgPrice:"2000"});
 }});
 const a={...A,platform:"binance"},pending={kind:"close",side:"long",contracts:.05,price:"2000.00",localId:"real-intent",hedged:false};
 assert.equal(await api.place(a,pending),"808");
 assert.equal(sent[0].url.searchParams.get("reduceOnly"),"true");
 assert.equal(sent[0].url.searchParams.get("positionSide"),"BOTH");
 assert.equal(sent[0].url.searchParams.get("quantity"),"0.05");
 await api.place(a,{...pending,hedged:true});
 assert.equal(sent[1].url.searchParams.get("reduceOnly"),null);
 assert.equal(sent[1].url.searchParams.get("positionSide"),"LONG");
 const fill=await api.order(a,"808",pending);
 assert.deepEqual({qty:fill.contracts,fee:fill.fee,price:fill.price},{qty:.05,fee:.04,price:2000});
});

test("Extended adapter preserves decimal quantities, explicit reduce-only and checks native completed orders",async()=>{
 let submitted;
 const api=create({extendedOrder:async input=>{submitted=input;return {id:"90071992547409931"};},
  request:async(raw,options)=>{
   assert.equal(new URL(raw).hostname,"api.starknet.extended.exchange");
   assert.equal(options.headers["X-Api-Key"],A.apiKey);
   return response({status:"OK",data:{id:"90071992547409931",market:"ETH-USD",status:"FILLED",
    side:"BUY",filledQty:".0001",averagePrice:"2000.123",payedFee:".00005",reduceOnly:true}});
  }});
 const a={...A,platform:"extended"},pending={kind:"close",side:"short",contracts:.0001,price:"2000.123",localId:"x"};
 const id=await api.place(a,pending);
 assert.equal(submitted.size,"0.0001");assert.equal(submitted.price,"2000.123");assert.equal(submitted.reduceOnly,true);
 const fill=await api.order(a,id,pending);
 assert.equal(fill.status,2);assert.equal(fill.contracts,.0001);assert.equal(fill.fee,.00005);
});

test("Hotcoin candle parser uses official low/high/open/close ordering and Extended uses ISO durations",async()=>{
 const bar=3600000,time=Math.floor(Date.now()/bar)*bar-bar;
 const api=create({request:async(raw)=>{
  const url=new URL(raw);
  if(url.hostname==="api-ct.hotcoin.fit")return response({code:200,data:[[time,"98","103","100","102","42"]]});
  assert.equal(url.searchParams.get("interval"),"PT1H");
  return response({status:"OK",data:[{T:time,o:"100",h:"103",l:"98",c:"102",v:"42"}]});
 }});
 const hot=await api.candles({...A,platform:"hotcoin",quoteAsset:"USDT"},"1h",bar);
 const ext=await api.candles({...A,platform:"extended"},"1h",bar);
 assert.deepEqual(hot,ext);
 assert.equal(hot[0].open,100);assert.equal(hot[0].low,98);
});
