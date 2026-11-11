"use strict";
const fs=require('fs'),path=require('path'),crypto=require('crypto'),C=require('../strategy/macd_scale_in/config'),S=require('../strategy/macd_scale_in/signal'),B=require('../strategy/macd_scale_in/book');
const frozenEngineHashes=Object.fromEntries(['config.js','signal.js','book.js'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../strategy/macd_scale_in',f),'utf8').replace(/\r\n/g,'\n')).digest('hex')]));
const variants=Object.freeze([
 {id:'A',name:'交叉不补仓',config:{maxAdds:0}},
 {id:'B',name:'交叉+一次等额补仓',config:{maxAdds:1}},
 {id:'C',name:'交叉+两次补仓',config:{maxAdds:2}},
 {id:'D',name:'交叉+三次补仓（默认结构）',config:{maxAdds:3}},
 {id:'E',name:'柱体拐点+三次补仓',config:{signalMode:'MOMENTUM'}},
 {id:'F',name:'交叉+三次补仓、不分批止盈',config:{partialTakeProfitEnabled:false}},
 {id:'G',name:'交叉与柱体组合+三次补仓',config:{signalMode:'COMBINED'}},
 {id:'H',name:'交叉+ATR保护实验',config:{stopMode:'ATR'}}
]);
function summary(rows,curve,initial=10000){let peak=initial,maxDrawdown=0,maxDrawdownPct=0,sum=0;for(const v of curve){peak=Math.max(peak,v.equity);maxDrawdown=Math.max(maxDrawdown,peak-v.equity);maxDrawdownPct=Math.max(maxDrawdownPct,100*(peak-v.equity)/peak);}const wins=rows.filter(r=>r.netPnl>0),losses=rows.filter(r=>r.netPnl<0),profit=wins.reduce((s,r)=>s+r.netPnl,0),loss=-losses.reduce((s,r)=>s+r.netPnl,0);sum=rows.reduce((s,r)=>s+r.netPnl,0);const mean=rows.length?sum/rows.length:null,variance=rows.length>1?rows.reduce((s,r)=>s+(r.netPnl-mean)**2,0)/(rows.length-1):null;return{cycles:rows.length,wins:wins.length,losses:losses.length,netPnl:sum,returnPct:sum/initial*100,winRate:rows.length?wins.length/rows.length:null,profitFactor:loss>0?profit/loss:null,avgNetPnl:mean,avgNetPnl95PctApprox:variance===null?null:[mean-1.96*Math.sqrt(variance/rows.length),mean+1.96*Math.sqrt(variance/rows.length)],worstCycle:rows.length?Math.min(...rows.map(r=>r.netPnl)):null,maxDrawdown,maxDrawdownPct,fees:rows.reduce((s,r)=>s+r.tradingFee,0),fundingPnl:rows.reduce((s,r)=>s+r.fundingPnl,0),maxAddsUsed:rows.length?Math.max(...rows.map(r=>r.entries.length-1)):0,partialTpCycles:rows.filter(r=>r.partialTpDone).length,riskStops:rows.filter(r=>['hard_stop','daily_loss','risk_lock'].includes(r.closeReason)).length,settledEquity:initial+sum};}
const analysisCache=new WeakMap(),dataHashes=new WeakMap();
const indicatorCodeHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../strategy/macd_scale_in/signal.js'))).update(fs.readFileSync(path.join(__dirname,'../strategy/macd_scale_in/config.js'))).digest('hex');
function run(data,config,{from,to,stress=false,experimentId='H06_RESEARCH'}={}){
 const c=C.normalize({tradeDirection:'BOTH',...config,...(stress?{entryFeeRate:.001,exitFeeRate:.001}: {})}),account={id:experimentId,platform:'binance',symbol:data.symbol.replace('USDT',''),quoteAsset:'USDT',strategyType:C.ID,tradeMode:'simulation',simulationEnabled:true,simulationBalance:10000,h06Mode:'Research'};
 let book=B.initial(account),fundingIndex=0,closed=[],decisions={},signals=0,gapBars=0,index=0;const curve=[],rows=[],orders=[],rules={qtyStep:account.symbol==='BTC'?.001:.001,minQty:.001,minNotional:5,maxQty:1000};
 const bars=data.candles,funding=data.funding,days=new Set();let evaluatedBars=0;let cache=analysisCache.get(data);if(!cache){cache=new Map();analysisCache.set(data,cache);}const indicatorKey=[c.fastPeriod,c.slowPeriod,c.signalPeriod,c.signalMode,c.crossConfirmBars,c.momentumConfirmBars,c.atrPeriod].join(':');let dataHash=dataHashes.get(data);if(!dataHash){dataHash=crypto.createHash('sha256').update(JSON.stringify(data.candles)).digest('hex');dataHashes.set(data,dataHash);}const cacheDir=path.resolve('.audit/h06-indicators'),cachePath=path.join(cacheDir,crypto.createHash('sha256').update(dataHash+indicatorCodeHash+indicatorKey).digest('hex')+'.json');if(!cache.has(indicatorKey)){cache.set(indicatorKey,fs.existsSync(cachePath)?new Map(JSON.parse(fs.readFileSync(cachePath))):new Map());}const signalsCache=cache.get(indicatorKey);let cacheDirty=false;
 const capture=()=>{if(book.history.length){for(const r of book.history){r.experimentId=experimentId;rows.push(r);curve.push({time:r.exitTime,equity:r.equityAfter});}book.history=[];}if(book.orders.length>20){orders.push(...book.orders.slice(0,-20));book.orders=book.orders.slice(-20);}book.consumed=book.consumed.slice(-100);};
 for(let i=0;i<bars.length;i++){
  const bar=bars[i];if(bar.time>=to)break;closed.push(bar);if(closed.length>500)closed.shift();if(bar.time<from)continue;
  evaluatedBars++;days.add(new Date(bar.time).toISOString().slice(0,10));
  // Only bars ending before this open may contribute to the live signal.
  let analyzed=signalsCache.get(i);if(!analyzed){analyzed=S.analyze(bars.slice(Math.max(0,i-500),i),c,bar.time,account);signalsCache.set(i,analyzed);cacheDirty=true;}let signal=analyzed.signal;if(signal){const structure=bars.slice(Math.max(0,i-c.atrPeriod),i);signal={...signal,structureLow:Math.min(...structure.map(v=>v.low)),structureHigh:Math.max(...structure.map(v=>v.high))};signals++;}
  const periodFunding=[];while(fundingIndex<funding.length&&funding[fundingIndex].time<=bar.time+10){const row=funding[fundingIndex++];if(row.markPrice>0)periodFunding.push(row);else if(book.cycle&&row.time>book.cycle.openedAt){book.riskLock=true;book.riskLockReason='研究资金费标记价缺失，终止该实验';}}
  let fundingCoverage=true;for(let f=fundingIndex-1;f>=0&&funding[f].time>=bar.time-9*S.HOUR;f--)if(!(funding[f].markPrice>0))fundingCoverage=false;
  if(!fundingCoverage)gapBars++;
  const healthy=fundingCoverage&&!['WARMUP','CANDLE_GAP','CANDLE_STALE'].includes(analyzed.code);
  const e={time:bar.time+10,price:bar.open,signal,running:true,marketOK:healthy,marketReason:'研究数据缺口',rules,account,funding:periodFunding,permit:()=>({allowed:true})};
  if(book.pending){book=B.advance(book,{...e,signal:null},c);book=B.execute(book,e,{status:stress&&i%17===0?'REJECTED':undefined,fillFraction:stress?.5:1,slippageBps:stress?10:5});capture();}
  book=B.advance(book,e,c);decisions[book.decision.code]=(decisions[book.decision.code]||0)+1;
  // Filled after the signal is available. Open+1s is an OHLC proxy, never claimed a real quote.
  if(book.pending){book=B.execute(book,{...e,time:e.time+(stress?30000:1000),signal:null},{status:stress&&i%17===0?'REJECTED':undefined,fillFraction:stress&&['open','add'].includes(book.pending.kind)?.5:1,slippageBps:stress?10:5});capture();}
  // Unknown intrabar ordering: stop has priority. This deliberately pessimistic path never opens new risk.
  if(book.cycle){const stop=book.cycle.stopPrice,side=book.cycle.side,worst=side==='long'?bar.low:bar.high,touched=side==='long'?worst<=stop:worst>=stop;
   const adverse={...e,signal:null,running:false,time:bar.time+S.HOUR/2,price:touched?(side==='long'?Math.min(bar.open,stop):Math.max(bar.open,stop)):worst,funding:[]};
   book=B.advance(book,adverse,c);if(book.pending&&['exit','partial'].includes(book.pending.kind)){book=B.execute(book,{...adverse,time:adverse.time+1000},{slippageBps:stress?20:5});capture();}
   if(book.cycle){const favorable={...adverse,time:bar.time+S.HOUR-2000,price:side==='long'?bar.high:bar.low};book=B.advance(book,favorable,c);if(book.pending&&['exit','partial'].includes(book.pending.kind)){book=B.execute(book,{...favorable,time:favorable.time+1000},{slippageBps:stress?20:5});capture();}}
  }
  const equity=book.equity+(book.cycle?B.netAt(book.cycle,bar.close):0);curve.push({time:bar.time+S.HOUR-1,equity});capture();
  if(book.equity<=0||book.riskLock)break;
 }
 if(cacheDirty){fs.mkdirSync(cacheDir,{recursive:true});fs.writeFileSync(cachePath,JSON.stringify([...signalsCache]));}
 return{...C.scope(c,account),experimentId,config:c,scenario:stress?'partial_delayed_rejected_double_cost':'ohlc_conservative',...summary(rows,curve),signals,decisions,coverage:{evaluatedBars,bars:bars.filter(v=>v.time>=from&&v.time<to).length,days:days.size,missingFundingCoverageBars:gapBars,fullFundingMarkCoverage:gapBars===0},activeCycle:book.cycle?{qty:book.cycle.qty,netPnl:B.netAt(book.cycle,bars.filter(v=>v.time<to).at(-1).close)}:null,blocked:book.riskLock?book.riskLockReason:null,rows,curve};
}
if(require.main===module){const root=process.argv[2]||'.audit/h06-data',out=process.argv[3]||'docs/h06/research-results.json',results=[];for(const symbol of ['ETHUSDT','BTCUSDT']){const data=JSON.parse(fs.readFileSync(path.join(root,symbol+'.json')));for(const [split,from,to]of [['train','2020-01-01','2023-01-01'],['validation','2023-01-01','2024-01-01'],['out_of_sample','2024-01-01','2026-01-01']])for(const v of variants){const result=run(data,v.config,{from:Date.parse(from),to:Date.parse(to),experimentId:'H06_'+v.id+'_'+symbol+'_'+split});const {rows,curve,...report}=result;results.push({symbol,split,name:v.name,...report});console.log(symbol,split,v.id,report.cycles,report.netPnl.toFixed(2),report.blocked||'');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({protocol:'Frozen before viewing performance; no automatic best-mode promotion; historical research, not Paper.',dataSource:'Binance USD-M monthly archives with official SHA256 checksums',engineHashes:frozenEngineHashes,engineHashEncoding:'UTF-8 LF',limitations:['1H OHLC execution proxy at next open + 1s; no historical orderbook evidence','Funding actual rates, hourly native mark-price boundary proxy','Stops prioritized over TP when intrabar order unknown','No proof of profitability; results across experiments are never summed'],results},null,2));}}
}
module.exports={variants,run,summary};
