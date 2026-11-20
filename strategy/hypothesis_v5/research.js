"use strict";
const fs=require("fs"),path=require("path"),C=require("./config"),M=require("./market"),B=require("./book"),A=require("./analytics"),R=require("./registry"),D=require("./data");
const copy=v=>JSON.parse(JSON.stringify(v));
function before(rows,time,ms,count=260){let lo=0,hi=rows.length;while(lo<hi){const k=(lo+hi)>>1;if(rows[k].time+ms<=time)lo=k+1;else hi=k;}return rows.slice(Math.max(0,lo-count),lo);}
function prepared(dataset,config={}){
 D.validateDataset(dataset);const c=C.normalize(config),output=[],bars=dataset.bars;let previousKey="",previousSignal=null;
 for(const bar of bars["15m"]){const time=bar.time+900000,sets=Object.fromEntries(Object.keys(M.MS).map(tf=>[tf,before(bars[tf],time,M.MS[tf])]));
  if(Object.values(sets).some(v=>v.length<210))continue;
  // Signal is evaluated at this bar's CLOSE, but pending orders only use this
  // bar's OPEN quote. Never fill at the already-observed breakout close.
  const previous=before(bars["15m"],bar.time,900000,1)[0];if(!previous)continue;
  const quote={bid:bar.open*(1-.0001),ask:bar.open*(1+.0001),time:bar.time,symbol:dataset.symbol+"USDT",platform:"binance",marketType:"perpetual",quoteAsset:"USDT",source:"native_binance",depthNotional:Math.min(100000,previous.volume*previous.close*.01),quality:"OHLC_PROXY_ASSUMPTION_NOT_NATIVE_L2"};
  const signalQuote={...quote,time,bid:bar.close*(1-.0001),ask:bar.close*(1+.0001),depthNotional:Math.min(100000,bar.volume*bar.close*.01)};
  const key=sets["1h"].at(-1).time;const signal=key===previousKey?{...previousSignal,evaluatedAt:time}:M.evaluate({bars:sets,symbol:dataset.symbol,now:time,quote:signalQuote,config:c});previousKey=key;previousSignal=signal;
  output.push({bar,time,sets,quote,signalQuote,signal});
 }
 return output;
}
function run(dataset,{experimentId="H01_BASE",config={},from=0,to=Infinity,matching="PARTIAL"},events=prepared(dataset,config)){
 if(!["PARTIAL","NO_FILL","DELAYED"].includes(matching))throw Error("MATCHING_NOT_REGISTERED");
 const v=R.variant(C.normalize(config),experimentId),b=B.create({id:"offline-"+experimentId,symbol:dataset.symbol,mode:"Research",config:v.config,experimentId:experimentId+"_"+matching});b.running=true;b.diagnosticLimit=events.length*3+1;b.curveLimit=events.length*3+1;
 let signal=null,previousKey="",previousSignal=null;const funding=dataset.funding;
 for(const e of events){if(e.time<from||e.time>=to)continue;
  // Manage and execute at current OPEN using ONLY prior closed signals.
  const at=e.bar.time+2,quote={...e.quote,time:at},previousClose=before(dataset.bars["15m"],at,900000,1)[0]?.close??e.bar.open,rates=funding.filter(f=>f.time>=(at-900000)&&f.time<=at).map(f=>({...f,markPrice:f.markPrice||previousClose,rate:f.rate*(v.stress?2:1)}));
  B.step(b,{time:at,quote,rules:dataset.rules,signal:null,funding:rates,variant:v,noFill:matching==="NO_FILL"||matching==="DELAYED"&&b.pending&&at-b.pending.submittedAt<900000,fillFraction:matching==="PARTIAL"?.5:1},[b]);
  // Then evaluate at CLOSE and manage old positions with the completed bar.
  const key=e.sets["1h"].at(-1).time;signal=experimentId==="H01_BASE"?e.signal:key===previousKey?{...previousSignal,evaluatedAt:e.time}:M.evaluate({bars:e.sets,symbol:dataset.symbol,now:e.time,quote:e.signalQuote,config:v.config,variant:v});previousKey=key;previousSignal=signal;
  const endQuote={...e.signalQuote};
  // Do not fill an existing pending order with its already observed close.
  B.step(b,{time:e.time,quote:endQuote,bar:e.bar,rules:dataset.rules,signal:{...signal,signalPermission:"blocked"},funding:[],variant:v,noFill:true},[b]);
  B.step(b,{time:e.time+1,quote:endQuote,rules:dataset.rules,signal,funding:[],variant:v,noFill:true},[b]);
 }
 return{scope:C.scope(v.config,dataset.symbol,"Research",b.experimentId),matching,metrics:A.metrics(b),funnel:{evaluations:b.decisions.length,signals:b.decisions.filter(d=>d.signalPermission==="allowed").length,submitted:b.orders.length,filled:b.orders.filter(o=>o.filledQty>0).length,completed:b.history.length,blockers:b.decisions.reduce((m,d)=>{for(const k of d.blockers)m[k]=(m[k]||0)+1;return m;},{})},trades:b.history,curve:b.equityCurve,unfinished:b.position||b.pending?true:false,finalDecision:b.lastSnapshot?.decision,attribution:"historical_backtest_not_forward"};
}
function suite(dataset,config={}){
 if(!dataset.funding?.length||dataset.missingFundingMonths?.length)throw Error("资金费历史覆盖不足，不生成收益认证报告");
 const events=prepared(dataset,config);if(events.length<1000)throw Error("预热后历史不足，不能伪造样本外");
 const start=events[0].time,end=events.at(-1).time+1,cut1=events[Math.floor(events.length*.6)].time,cut2=events[Math.floor(events.length*.8)].time,segments={train:[start,cut1],validation:[cut1,cut2],outOfSample:[cut2,end]},results={};
 for(const[name,[from,to]]of Object.entries(segments)){results[name]={from,to,experiments:R.experiments.map(x=>run(dataset,{experimentId:x.id,config,from,to},events))};}
 const oos=results.outOfSample.experiments,base=oos.find(v=>v.scope.experimentId==="H01_BASE_PARTIAL"),stress=oos.find(v=>v.scope.experimentId==="COST_STRESS_PARTIAL"),walkForward=[];
 for(let i=0;i<3;i++){const from=events[Math.floor(events.length*(.4+i*.2))].time,to=i===2?end:events[Math.floor(events.length*(.6+i*.2))].time;walkForward.push({trainUntil:from,parameterSelection:"none; frozen preregistered defaults",result:run(dataset,{from,to,config},events)});}
 const quoteStress=["NO_FILL","DELAYED"].map(matching=>run(dataset,{config,from:cut2,to:end,matching},events));
 return{createdAt:Date.now(),dataHash:C.hash(dataset),source:dataset.source,symbol:dataset.symbol,downloadedAt:dataset.downloadedAt,parameters:C.normalize(config),preregistration:R.preregistration,results,walkForward,matchingSensitivity:quoteStress,gate:A.verdict(base.metrics,stress.metrics),oosDecay:{train:results.train.experiments[0].metrics.expectancyR,oos:base.metrics.expectancyR},limitations:["OHLC代理盘口，不证明排队、真实深度或成交","历史交易规格采用采集时规则，非历史快照","置信区间近似，不校正全部自相关与多重比较","单币分割研究不替代BTC/ETH联合组合前向验证","所有实验含失败结果，不以样本外调参","尚未批准Live"],allowLive:false};
}
function appendExperiment(directory,record){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,"experiments.jsonl"),text=fs.existsSync(file)?fs.readFileSync(file,"utf8"):"",rows=text.trim()?text.trim().split("\n").map(JSON.parse):[],previous=rows.at(-1)?.hash||null;
 let prev=null;for(const row of rows){if(row.previous!==prev||row.hash!==C.hash({previous:row.previous,record:row.record}))throw Error("研究审计链损坏");prev=row.hash;}
 const item={previous,record:copy(record)};item.hash=C.hash(item);const fd=fs.openSync(file,"a",0o600);try{fs.writeSync(fd,JSON.stringify(item)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return item.hash;
}
module.exports={before,prepared,run,suite,appendExperiment};
