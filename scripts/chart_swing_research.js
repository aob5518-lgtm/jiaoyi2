"use strict";
const fs=require("node:fs"),crypto=require("node:crypto"),C=require("../strategy/chart_swing_1h/config");
const S=require("../strategy/chart_swing_1h/signal"),B=require("../strategy/turtle_4h/book");
const annotations=require("./research/chart_swing_annotations");
const sum=rows=>rows.reduce((n,t)=>n+t.netPnl,0);
function validate(data){
 if(data.source!=="binance_usdm_native"||data.market!=="ETHUSDT"||data.interval!=="1h")throw Error("Source mismatch");
 if(!Array.isArray(data.bars)||data.bars.length<120||!Array.isArray(data.funding))throw Error("Incomplete dataset");
 for(let i=0;i<data.bars.length;i++){const b=data.bars[i];
  if(![b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||b.low<=0||b.volume<0||
   b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||b.time!==data.from+i*C.BAR||b.time+C.BAR>data.end)throw Error("Candle gap/invalid value");
 }
 if(data.bars.at(-1).time+C.BAR!==data.end||data.end>data.fetchedAt)throw Error("Incomplete history");
 if(data.funding.some((f,i)=>![f.time,f.rate,f.price].every(Number.isFinite)||f.price<=0||f.time<data.from||f.time>=data.end||
  i>0&&f.time<=data.funding[i-1].time||i>0&&f.time-data.funding[i-1].time>9*C.BAR)||
  !data.funding.length||data.funding[0].time-data.from>9*C.BAR||data.end-data.funding.at(-1).time>9*C.BAR)throw Error("Incomplete funding");
}
function replay(data,from,to,{stress=false,prototype=false}={}){
 const c=C.defaults,a={id:"chart-research",strategyType:C.ID,platform:"binance",symbol:"ETH",quoteAsset:"USDT",
  simulationBalance:10000,simulationEnabled:true,tradeMode:"simulation",leverage:1,simulationSlippageBps:stress?10:5};
 let b={...B.initial(a,C),running:true},peak=b.balance,drawdown=0;const signals=[],decisions={},equity=[];
 for(let i=120;i<data.bars.length;i++){
  const bar=data.bars[i],t=bar.time;if(t<from||t>=to)continue;
  const analysis=(prototype?S.prototypeAnalyze:S.analyze)(data.bars.slice(Math.max(0,i-240),i),c,t);
  const signal=analysis.side?{at:t,price:bar.open,side:analysis.side,mode:analysis.entryMode,signalAt:analysis.closedAt}:null;
  const event=(time,price)=>({time,account:a,analysis,marketOK:true,permit:()=>({allowed:true}),data:{
   fundingFrom:data.from,funding:data.funding,quote:{bid:price*(1-(stress?.0002:.0001)),ask:price*(1+(stress?.0002:.0001)),
    bidQty:100,askQty:100,time},rules:{step:.001,minQty:.001,maxQty:10000,minNotional:20}}});
  const advance=(time,price)=>{b=B.advance(b,event(time,price),c,C);};
  advance(t,bar.open);advance(t+1000,bar.open);
  if(signal){Object.assign(signal,{execution:b.decision.code,reason:b.decision.reason,hasPosition:!!b.position,pending:!!b.pending});signals.push(signal);}
  decisions[b.decision.code]=(decisions[b.decision.code]||0)+1;
  const p=b.position;
  if(p){
   const adverse=p.side==="long"?bar.low:bar.high;
   if(p.side==="long"?bar.low<=p.stop:bar.high>=p.stop){
    // OHLC cannot reveal the path. Stop first, including gaps at the worse opening price.
    const trigger=p.side==="long"?Math.min(p.stop,bar.open):Math.max(p.stop,bar.open);
    advance(t+C.BAR-3,trigger);advance(t+C.BAR-2,trigger);
   }else{
    const sign=p.side==="long"?1:-1;
    p.mae=Math.min(p.mae,sign*(adverse-p.entry));
    p.mfe=Math.max(p.mfe,sign*((p.side==="long"?bar.high:bar.low)-p.entry));
   }
  }
  advance(t+C.BAR-1,bar.close);
  const net=b.balance+(b.position?B.net(b.position,bar.close):0);
  peak=Math.max(peak,net);drawdown=Math.max(drawdown,(peak-net)/peak);
  equity.push({at:t+C.BAR,net});
 }
 const wins=b.trades.filter(t=>t.netPnl>0),losses=b.trades.filter(t=>t.netPnl<0);
 return {from,to,stress,signalCount:signals.length,signals,decisions,
  trades:b.trades.map(t=>({...t,sampleType:"historical_replay",matchingPrecision:"hourly_proxy"})),closedTrades:b.trades.length,netPnl:b.realized,
  endingEquity:equity.at(-1)?.net??10000,openAtEnd:!!b.position,pendingAtEnd:!!b.pending,winRate:b.trades.length?wins.length/b.trades.length:null,
  profitFactor:losses.length?sum(wins)/-sum(losses):null,expectancy:b.trades.length?b.realized/b.trades.length:null,
  maxDrawdown:drawdown,worstTrade:losses.length?Math.min(...losses.map(t=>t.netPnl)):null,
  fees:b.trades.reduce((n,t)=>n+t.tradingFee,0),funding:b.trades.reduce((n,t)=>n+t.fundingPnl,0)};
}
const inZone=(at,price,z)=>at>=z.from&&at<z.to&&price>=z.low&&price<=z.high;
function compare(run){
 const usedSignals=new Set(),usedTrades=new Set();
 const targets=annotations.targets.map(a=>{
  const signal=run.signals.findIndex((s,i)=>!usedSignals.has(i)&&s.side===a.side&&inZone(s.at,s.price,a.entry));
  if(signal>=0)usedSignals.add(signal);
  const trade=run.trades.findIndex((t,i)=>!usedTrades.has(i)&&t.side===a.side&&inZone(t.entryTime,t.entryPrice,a.entry));
  if(trade>=0)usedTrades.add(trade);
  const t=run.trades[trade];
  return {image:a.image,side:a.side,entryZone:a.entry,exitZone:a.exit,signalMatched:signal>=0,entryMatched:!!t,
   exitMatched:!!t&&inZone(t.time,t.exitPrice,a.exit),actual:t?{entryAt:t.entryTime,entryPrice:t.entryPrice,
    exitAt:t.time,exitPrice:t.exitPrice,netPnl:t.netPnl,reason:t.reason}:null,
   execution:signal>=0?run.signals[signal]:null,
   outcome:t?inZone(t.time,t.exitPrice,a.exit)?"ENTRY_AND_EXIT_ZONE":"ENTRY_ONLY_EXIT_DIFFERS":signal>=0?"SIGNAL_ONLY_NOT_EXECUTED":"NO_MATCH"};
 });
 return {precision:annotations.precision,uniqueTargets:targets.length,screenshots:46,duplicateScreenshots:annotations.duplicates.length,
  signalMatched:targets.filter(t=>t.signalMatched).length,entryMatched:targets.filter(t=>t.entryMatched).length,
  entryAndExitMatched:targets.filter(t=>t.exitMatched).length,extraSignals:run.signals.length-usedSignals.size,
  extraTrades:run.trades.length-usedTrades.size,targets};
}
function main(){
 const [input,output]=process.argv.slice(2),raw=fs.readFileSync(input),data=JSON.parse(raw);validate(data);
 const from=Date.parse("2026-08-18T00:00:00+08:00"),split=Date.parse("2026-08-01T00:00:00Z");
 const baseline=replay(data,from,data.end),stress=replay(data,from,data.end,{stress:true});
 const earlier=replay(data,data.from+120*C.BAR,split);
 const prototype=replay(data,from,data.end,{prototype:true});
 const report={revision:C.REVISION,config:C.defaults,configHash:C.hash(C.defaults),sampleType:"retrospective_research_not_paper_forward",
  source:data.source,market:data.market,dataHash:crypto.createHash("sha256").update(raw).digest("hex"),fetchedAt:data.fetchedAt,
  bars:data.bars.length,fundingEvents:data.funding.length,assumptions:{fill:"1h open proxy, 1s simulated submission latency, fixed generous depth; not historical book evidence",
   feePerSide:.0005,slippageBps:5,stressSlippageBps:10,spreadBps:2,stressSpreadBps:4,stop:"adverse-first OHLC stop; gaps at worse open; no liquidation reconstruction",
   annotation:"approximate hand-transcribed price/date zones; duplicates excluded; all labeled history is seen",
   comparison:"earlier unannotated history, not independent OOS; single symbol; no parameter search"},
  baseline,stress,earlierUnannotated:earlier,rejectedPrototype:prototype,comparison:compare(baseline)};
 fs.writeFileSync(output,JSON.stringify(report,null,2));
 const compact=r=>({trades:r.closedTrades,netPnl:r.netPnl,endingEquity:r.endingEquity,profitFactor:r.profitFactor,maxDrawdown:r.maxDrawdown,
  expectancy:r.expectancy,worstTrade:r.worstTrade,fees:r.fees,signals:r.signalCount,openAtEnd:r.openAtEnd});
 console.log(JSON.stringify({configHash:report.configHash,baseline:compact(baseline),stress:compact(stress),earlier:compact(earlier),
  comparison:{...report.comparison,targets:undefined}},null,2));
}
if(require.main===module)main();
module.exports={replay,compare,validate,inZone};
