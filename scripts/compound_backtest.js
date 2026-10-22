"use strict";
// Public historical data only. This process has no exchange order client or production configuration.
const fs=require("fs"),C=require("../strategy/compound_4h/config"),S=require("../strategy/compound_4h/signal"),B=require("../strategy/compound_4h/book"),{metrics}=require("../strategy/short_term_v1/analytics");
async function download(output){
 const end=Date.now(),start=end-730*86400000,bars={};
 for(const tf of ["1d","4h","1h"]){const list=[];let cursor=start;while(cursor<end){const u="https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval="+tf+"&limit=1000&startTime="+cursor+"&endTime="+end;const r=await fetch(u,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error("公开历史数据HTTP "+r.status);const chunk=await r.json();if(!Array.isArray(chunk)||!chunk.length)break;for(const v of chunk)list.push({time:Number(v[0]),open:Number(v[1]),high:Number(v[2]),low:Number(v[3]),close:Number(v[4]),volume:Number(v[5])});const next=Number(chunk.at(-1)[0])+S.MS[tf];if(next<=cursor)throw Error("历史分页未推进");cursor=next;}bars[tf]=list;}
 fs.writeFileSync(output,JSON.stringify({source:"Binance public ETHUSDT SPOT reference, not USDC perpetual fills",downloadedAt:end,bars}));
}
function run(dataset,options={}){
 const config=C.normalize(options),account={id:"isolated-backtest",platform:"binance",symbol:"ETH",tradeMode:"simulation",simulationEnabled:true},book=B.initial(config),bars=dataset.bars,rules={qtyStep:.0001,minQty:.0001,minNotional:5,priceTick:.01},start=(bars["1d"][209]?.time||Infinity)+86400000;
 let lastSignal=null,lastSignalTime=0;const blockers={},regimes={};
 for(const candle of bars["1h"]||[]){const time=candle.time+3600000,decisionTime=candle.time;if(decisionTime<start||time>Number(dataset.downloadedAt||Infinity))continue;const close4=Math.floor(decisionTime/14400000)*14400000;
  if(decisionTime!==lastSignalTime){lastSignal=S.analyze({bars:Object.fromEntries(Object.keys(S.MS).map(tf=>[tf,bars[tf].filter(v=>v.time+S.MS[tf]<=decisionTime).slice(-300)])),now:decisionTime,account,config});lastSignalTime=decisionTime;blockers[lastSignal.primaryBlocker||lastSignal.decision]=(blockers[lastSignal.primaryBlocker||lastSignal.decision]||0)+1;}
  // The just-completed 1H OHLC can only match previously placed orders. New plans use its close for future bars.
  B.step(book,{event:{time,price:candle.close,low:candle.low,high:candle.high},signal:lastSignal,config,account,rules,running:true,permit:()=>({allowed:true})});
 }
 const rows=book.history.filter(v=>v.filledQty>0);for(const r of rows){const key=r.prediction.dailyTrend;regimes[key]||=[];regimes[key].push(r);}
 return{config:C.scope(config,account),start,end:bars["1h"].at(-1)?.time,metrics:metrics(rows),addDistribution:Object.fromEntries([0,1,2,3].map(n=>[n,rows.filter(v=>v.adds===n).length])),extremeLosses:rows.slice().sort((a,b)=>a.netPnl-b.netPnl).slice(0,3).map(v=>({cycleId:v.cycleId,netPnl:v.netPnl,netR:v.netR,reason:v.closeReason})),byRegime:Object.fromEntries(Object.entries(regimes).map(([k,v])=>[k,metrics(v)])),blockers,unfinished:book.cycle?1:0,endingSettledEquity:book.equity};
}
async function main(){const [mode,file]=process.argv.slice(2);if(mode==="--download"){await download(file);console.log("Public historical data saved");return;}if(!file)throw Error("Usage: node scripts/compound_backtest.js --download DATA.json | --run DATA.json");const data=JSON.parse(fs.readFileSync(file,"utf8"));const groups={A_standard:{},B_first_only:{maxAdds:0},C_four_equal:{maxAdds:3},D_fixed_target:{exitVariant:"FIXED_TARGET"},D_trail_only:{exitVariant:"TRAIL_ONLY"},E_fixed_base:{compoundMode:"FIXED_BASE"},sensitivity_zone_small:{zoneAtr:.5},sensitivity_zone_large:{zoneAtr:.8}};console.log(JSON.stringify({source:data.source,limitations:["1H OHLC非逐笔，无订单簿，限价部分成交仅保守假设","现货ETHUSDT参考，非ETHUSDC永续真实成交；资金费采用估算预留","未进行样本外优化，不允许将本结果宣传为已验证盈利"],results:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,run(data,v)]))},null,2));}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
