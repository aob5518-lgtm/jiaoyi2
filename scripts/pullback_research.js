"use strict";

const fs=require("node:fs"), C=require("../strategy/pullback_15m/config"), S=require("../strategy/pullback_15m/signal");
const B=require("../strategy/turtle_4h/book"), {BASE}=require("../strategy/turtle_4h/provider");
const MINUTE=60000, DAY=1440*MINUTE;

async function json(path) {
 const response=await fetch(BASE+path,{signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error("Binance "+response.status+" "+path);
 return response.json();
}
async function download(symbol,from,to) {
 const warmup=from-2*DAY, minutes=[];
 for(let time=warmup;time<to;time+=1500*MINUTE) {
  const end=Math.min(time+1500*MINUTE,to);
  const rows=await json("/fapi/v1/klines?symbol="+symbol+"&interval=1m&startTime="+time+"&endTime="+(end-1)+"&limit=1500");
  if(rows.length!==(end-time)/MINUTE)throw Error(symbol+" missing native minute candles at "+new Date(time).toISOString());
  for(const row of rows){
   const [t,o,h,l,c,v]=row.map(Number);
   if(t!==warmup+minutes.length*MINUTE||![o,h,l,c,v].every(Number.isFinite)||l<=0||l>Math.min(o,c)||h<Math.max(o,c)||v<0)throw Error(symbol+" invalid minute candle");
   minutes.push({time:t,open:o,high:h,low:l,close:c,volume:v});
  }
 }
 const raw=await json("/fapi/v1/fundingRate?symbol="+symbol+"&startTime="+from+"&endTime="+(to-1)+"&limit=1000");
 if(!Array.isArray(raw)||!raw.length||raw.length>=1000)throw Error(symbol+" funding coverage incomplete");
 const funding=raw.map(v=>({time:+v.fundingTime,rate:+v.fundingRate,price:+v.markPrice}));
 if(raw.some(v=>v.symbol!==symbol)||funding.some((v,i)=>!(v.time>=from&&v.time<to&&v.price>0&&Number.isFinite(v.rate))||
    i>0&&v.time<=funding[i-1].time))throw Error(symbol+" invalid funding data");
 return {minutes,funding};
}
function aggregate(minutes) {
 const bars=[];
 for(let i=0;i+14<minutes.length;i+=15) {
  const group=minutes.slice(i,i+15);
  bars.push({time:group[0].time,open:group[0].open,close:group[14].close,
   high:Math.max(...group.map(row=>row.high)),low:Math.min(...group.map(row=>row.low))});
 }
 return bars;
}
function run(dataset,base,from,rules,{direct=false,stress=false}={}) {
 const {minutes,funding}=dataset, bars=aggregate(minutes);
 const account={id:base+"-research",strategyType:C.ID,platform:"binance",symbol:base,quoteAsset:"USDT",
  simulationEnabled:true,tradeMode:"simulation",simulationBalance:10000,leverage:1,simulationSlippageBps:stress?10:5};
 const config=C.defaults;
 let book={...B.initial(account,C),running:true}, high=book.balance, maxDrawdown=0, signals=0;
 const decisions={};
 for(let i=1;i<minutes.length;i++) {
  const minute=minutes[i], previous=minutes[i-1], time=minute.time;
  if(time<from)continue;
  const closes15=time%C.BAR===0;
  if(!book.position&&!book.pending&&!closes15)continue;
  const closedCount=Math.floor(i/15);
  const analysis=closes15?S.analyze(bars.slice(Math.max(0,closedCount-160),closedCount),config,time,{direct}):{closedAt:0};
  if(closes15&&analysis.side)signals++;
  const event=(t,price)=>({time:t,account,analysis,marketOK:true,permit:()=>({allowed:true}),data:{
   quote:{bid:price*(1-(stress?.0002:.0001)),ask:price*(1+(stress?.0002:.0001)),bidQty:previous.volume*.2,askQty:previous.volume*.2,time:t},
   rules,funding,fundingFrom:from}});
  book=B.advance(book,event(time,minute.open),config,C);
  if(closes15&&analysis.side)decisions[book.decision.code]=(decisions[book.decision.code]||0)+1;
  const p=book.position;
  if(p&&!book.pending) {
   const stop=p.side==="long"?minute.low<=p.stop:minute.high>=p.stop;
   const target=p.side==="long"?minute.high>=p.target:minute.low<=p.target;
   if(stop||target) {
    const evidence=stop?(p.side==="long"?minute.low:minute.high):(p.side==="long"?minute.high:minute.low);
    // The minute range is available at its end. If both levels were in it, submit the stop.
    book=B.advance(book,event(time+MINUTE-1,evidence),config,C);
   }
  }
  const equity=book.balance+(book.position?B.net(book.position,minute.close):0);
  high=Math.max(high,equity);
  maxDrawdown=Math.max(maxDrawdown,(high-equity)/high);
 }
 const wins=book.trades.filter(row=>row.netPnl>0), losses=book.trades.filter(row=>row.netPnl<0);
 const sum=rows=>rows.reduce((total,row)=>total+row.netPnl,0);
 return {strategy:direct?"direct_breakout":"confirmed_pullback",stress,signals,decisions,
  trades:book.trades.length,netPnl:book.realized,openAtEnd:!!book.position,
  expectancy:book.trades.length?book.realized/book.trades.length:null,maxDrawdown,
  worstTrade:losses.length?Math.min(...losses.map(row=>row.netPnl)):null,
  profitFactor:losses.length?sum(wins)/-sum(losses):null};
}
async function main() {
 const [start,end,output]=process.argv.slice(2),from=Date.parse(start),to=Date.parse(end);
 if(!output||from%DAY!==0||to%DAY!==0||!(to>from&&to<=Date.now()&&to-from<=60*DAY))throw Error("Provide UTC dates (up to 60 days) and an output path");
 const info=await json("/fapi/v1/exchangeInfo");
 const markets=await Promise.all(["BTC","ETH"].map(async base=>{
  const symbol=base+"USDT", contract=info.symbols.find(row=>row.symbol===symbol);
  if(contract?.contractType!=="PERPETUAL"||contract.quoteAsset!=="USDT")throw Error("Contract mismatch "+symbol);
  const lot=contract.filters.find(row=>row.filterType==="MARKET_LOT_SIZE"), min=contract.filters.find(row=>row.filterType==="MIN_NOTIONAL");
  const rules={step:+lot.stepSize,minQty:+lot.minQty,maxQty:+lot.maxQty,minNotional:+min.notional};
  const data=await download(symbol,from,to);
  const results=[false,true].flatMap(stress=>[false,true].map(direct=>run(data,base,from,rules,{direct,stress})));
  return {symbol,bars1m:data.minutes.length,fundingEvents:data.funding.length,results};
 }));
 const report={sample:"retrospective_research",source:"binance_usdm_native_1m",revision:C.REVISION,config:C.defaults,
  configHash:C.hash(C.defaults),from:start,to:end,assumptions:"Fresh 1m open proxy; 2/4 bps quote width; 5/10 bps slippage per execution; 5 bps fee per side; stop precedence; no live book evidence.",markets};
 fs.writeFileSync(output,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
