"use strict";
const {test}=require("node:test"), A=require("node:assert/strict");
const L=require("../market_leverage"), Classic=require("../terminal/classic-paper");
const T=require("../strategy/turtle_4h/config"), B=require("../strategy/turtle_4h/book");
const F=require("./turtle_fixture"), S=require("../strategy/turtle_4h/signal");
const binance={success:true,data:{brackets:[
 {symbol:"BTCUSDT",riskBrackets:[{bracketNotionalFloor:0,bracketNotionalCap:300000,maxOpenPosLeverage:150},
  {bracketNotionalFloor:300000,bracketNotionalCap:800000,maxOpenPosLeverage:100}]},
 {symbol:"ETHUSDT",riskBrackets:[{bracketNotionalFloor:0,bracketNotionalCap:10000,maxOpenPosLeverage:75}]}
]}};
test("Public ceilings come from the exact Binance, Hyperliquid and Extended notional tier",()=>{
 const spec=L.parseBinance(binance,"BTC",1);
 A.equal(L.maxAt(spec,1),150);
 A.equal(L.maxAt(spec,300000),100);
 A.equal(L.maxAt(spec,800000),0);
 A.throws(()=>L.assertAllowed(125,spec,300000),/最高 100 倍/);
 A.throws(()=>L.assertAllowed(5,null,0),/未取得/);
 A.throws(()=>L.parseBinance(binance,"SOL",1),/分档无效/);
 const hyper=L.parseHyper({universe:[{name:"ETH",maxLeverage:25,marginTableId:55}],marginTables:[
  [55,{marginTiers:[{lowerBound:"0",maxLeverage:25},{lowerBound:"1000000",maxLeverage:15}]}]
 ]},"ETH",1);
 A.equal(L.maxAt(hyper,1e6),15);
 const extended=L.parseExtended({status:"OK",data:[{name:"ETH-USD",active:true,tradingConfig:{maxLeverage:"50",maxPositionValue:"1000000",
  riskFactorConfig:[{upperBound:"800000",riskFactor:".02"},{upperBound:"1000000",riskFactor:".06"}]}}]},"ETH",1);
 A.equal(L.maxAt(extended,799999),50);
 A.equal(L.maxAt(extended,800000),50);
 A.equal(L.maxAt(extended,800001),16.7);
 A.equal(L.leverageError(16.7,extended,900000),"");
 A.match(L.leverageError(1.5,spec,5),/整数/);
});
test("Cache separates instruments and expires instead of reusing unverifiable tiers",async()=>{
 let calls=0,time=1,fail=false;
 const loader=L.create(async()=>{calls++;if(fail)throw Error("fixture unavailable");return binance;},()=>time);
 const accounts=["BTC","ETH"].map(symbol=>({platform:"binance",symbol}));
 A.deepEqual((await Promise.all(accounts.map(loader.load))).map(s=>s.maxLeverage),[150,75]);
 A.equal(calls,1);
 time+=301000;fail=true;
 await A.rejects(loader.load(accounts[0]),/暂未取得/);
 await A.rejects(loader.load(accounts[1]),/暂未取得/);
 A.equal(calls,2);
});
test("Classic margin accepts above 10x and blocks only entry or adds when simulated notional crosses a tier",()=>{
 const settings=Classic.normalize({...Classic.defaults,leverage:50,baseAmount:100,maxAdds:0},1000);
 const book={settings,running:true,balance:1000,cost:{slippage:0,entryFee:0,exitFee:0},lastActionAt:0,trades:[],position:null,realized:0};
 const spec={market:"ETH",tiers:[{floor:0,cap:100,maxLeverage:50},{floor:100,cap:null,maxLeverage:25}]};
 const result=Classic.step(book,100,60000,false,spec);
 A.equal(result.book.position,null);
 A.match(result.notice,/25 倍/);
 const opened=Classic.step(book,100,60000,false,undefined).book;
 A.equal(Classic.targets(opened,100).margin,2);
 A.equal(Classic.step(opened,101,61000,true,null).book.position,null);
});
test("Paper opening and next quote fill recheck tiers without changing the stop-based risk budget",()=>{
 const a=F.account(), c=T.normalize({leverage:75}), time=F.NOW;
 const data=F.market(time), analysis=S.analyze(data.candles,c,time);
 const b={...B.initial(a),running:true};
 const spec=L.parseBinance(binance,"ETH",time);
 const queued=B.advance(b,F.event({account:a,data:{...data,leverageSpec:spec},analysis}),c);
 A.equal(queued.pending.meta.budget,b.balance*c.riskPerTrade);
 const next=F.market(time+2000);
 const cancelled=B.advance(queued,F.event({account:a,time:time+2000,data:{...next,leverageSpec:null},analysis}),c);
 A.equal(cancelled.position,null);
 A.equal(cancelled.decision.code,"LEVERAGE_BLOCK");
 const filled=B.advance(queued,F.event({account:a,time:time+2000,data:{...next,leverageSpec:spec},analysis}),c);
 A.ok(filled.position.actualRisk<=queued.pending.meta.budget);
 A.equal(filled.position.config.leverage,75);
});
