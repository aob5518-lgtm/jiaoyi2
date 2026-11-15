"use strict";
const fs=require("fs"),path=require("path"),crypto=require("crypto"),C=require("../strategy/turtle_4h/config"),S=require("../strategy/turtle_4h/signal"),B=require("../strategy/turtle_4h/book");
function aggregate(rows){
 const groups=new Map();for(const b of rows){const key=Math.floor(b.time/C.BAR)*C.BAR;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b);}
 return [...groups].filter(([time,v])=>v.length===4&&v.every((b,i)=>b.time===time+i*3600000)).map(([time,v])=>({time,open:v[0].open,high:Math.max(...v.map(b=>b.high)),low:Math.min(...v.map(b=>b.low)),close:v.at(-1).close}));
}
function replay(dataset,symbol,year){
 const from=Date.UTC(year,0,1),to=Date.UTC(year+1,0,1),rows=dataset.candles.filter(b=>b.time>=from&&b.time<to),four=aggregate(dataset.candles),a={id:symbol+"-"+year,name:"Research",platform:"binance",symbol:symbol.slice(0,-4),quoteAsset:"USDT",strategyType:C.ID,tradeMode:"simulation",simulationEnabled:true,simulationBalance:10000,turtleConfig:C.defaults};
 let b=B.initial(a);b.running=true;let peak=10000,drawdown=0,signalCount=0,lastSignal=0,priorTime=from-1;
 for(const hour of rows){
  const analysis=S.analyze(four.filter(v=>v.time+C.BAR<=hour.time).slice(-500),C.defaults,hour.time);
  const prices=b.position?.side==="short"?[hour.open,hour.high,hour.low,hour.close]:[hour.open,hour.low,hour.high,hour.close];
  for(let i=0;i<4;i++){
   const time=hour.time+i*15*60000+1000,price=prices[i],funding=dataset.funding.filter(f=>f.time>priorTime&&f.time<=time).map(f=>({time:f.time,rate:f.rate,price:f.markPrice}));
   const data={quote:{bid:price*(1-.00005),ask:price*(1+.00005),bidQty:1e8,askQty:1e8,time},rules:{step:symbol==="ETHUSDT"?.001:.001,minQty:.001,maxQty:1e8,minNotional:5},funding,fundingFrom:priorTime,fundingComplete:true};
   const event={time,data,analysis,marketOK:!!analysis.closedAt,account:a,permit:()=>({allowed:true})};
   if(analysis.side&&analysis.closedAt!==lastSignal){lastSignal=analysis.closedAt;signalCount++;}
   b=B.advance(b,event,C.defaults);
   if(b.pending){data.quote.time=time+1;b=B.advance(b,{...event,time:time+1},C.defaults);}
   priorTime=b.position?.fundingThrough??time+1;
   const equity=b.balance+(b.position?B.net(b.position,price):0);peak=Math.max(peak,equity);drawdown=Math.max(drawdown,(peak-equity)/peak);
  }
 }
 const wins=b.trades.filter(t=>t.netPnl>0),losses=b.trades.filter(t=>t.netPnl<0),profit=wins.reduce((n,t)=>n+t.netPnl,0),loss=-losses.reduce((n,t)=>n+t.netPnl,0);
 return {symbol,year,from:new Date(from).toISOString(),to:new Date(to).toISOString(),hours:rows.length,signalCount,trades:b.trades.length,netPnl:b.realized,netExpectancy:b.trades.length?b.realized/b.trades.length:null,profitFactor:loss?profit/loss:null,winRate:b.trades.length?wins.length/b.trades.length:null,maxDrawdown:drawdown,worstTrade:b.trades.length?Math.min(...b.trades.map(t=>t.netPnl)):null,fees:b.trades.reduce((n,t)=>n+t.tradingFee,0),funding:b.trades.reduce((n,t)=>n+t.fundingPnl,0),openPosition:b.position?{side:b.position.side,qty:b.position.qty,entry:b.position.entry}:null};
}
if(require.main===module){
 const input=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]||".audit/turtle-research.json"),results=[],sources=[];
 for(const symbol of["ETHUSDT","BTCUSDT"]){const file=path.join(input,symbol+".json"),bytes=fs.readFileSync(file),data=JSON.parse(bytes);sources.push({symbol,source:data.source,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),fundingMarkLimitation:data.fundingMarkLimitation});for(const year of[2024,2025])results.push(replay(data,symbol,year));}
 fs.writeFileSync(output,JSON.stringify({kind:"retrospective_research_previously_seen_history",protocol:"docs/turtle-4h/PROTOCOL.md",config:C.defaults,configHash:C.hash(C.defaults),revision:C.REVISION,sources,results},null,2));console.log(JSON.stringify(results));
}
module.exports={aggregate,replay};
