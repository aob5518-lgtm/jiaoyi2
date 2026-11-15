"use strict";
const C=require("../strategy/turtle_4h/config");
const NOW=Math.floor(Date.now()/C.BAR)*C.BAR+60000;
const account=(extra={})=>({id:"turtle-test",name:"海龟测试",strategyType:C.ID,platform:"binance",symbol:"ETH",quoteAsset:"USDT",tradeMode:"simulation",simulationEnabled:true,simulationBalance:10000,turtleConfig:C.normalize({}),...extra});
function market(now=NOW,side="long"){
 const base=Math.floor(now/C.BAR)*C.BAR;
 const candles=Array.from({length:90},(_,i)=>({time:base-(90-i)*C.BAR,open:100,high:101,low:99,close:100}));
 const last=candles.at(-1);if(side==="long")Object.assign(last,{high:105,close:104});if(side==="short")Object.assign(last,{low:95,close:96});
 const price=last.close;
 return {source:"binance_usdm_native",symbol:"ETHUSDT",quoteAsset:"USDT",marketType:"perpetual",quote:{bid:price-.01,ask:price+.01,bidQty:10000,askQty:10000,time:now},candles,rules:{step:.001,minQty:.001,maxQty:10000,minNotional:5},funding:[],fundingFrom:now-24*3600000,fundingComplete:true};
}
function event(extra={}){
 const data=extra.data||market(extra.time||NOW),analysis=extra.analysis||require("../strategy/turtle_4h/signal").analyze(data.candles,C.defaults,extra.time||NOW);
 return {time:NOW,data,analysis,marketOK:true,account:account(),permit:()=>({allowed:true}),...extra};
}
module.exports={NOW,account,market,event};
