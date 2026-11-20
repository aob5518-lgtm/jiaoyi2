"use strict";
// Public market data only. Temporary independent Paper books; no production config or credentials.
const fs=require("fs"),os=require("os"),path=require("path"),C=require("../strategy/turtle_4h/config"),B=require("../strategy/turtle_4h/book"),R=require("../strategy/turtle_4h/runtime");
async function check(directory){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const engine=R.create({directory,permit:()=>({allowed:true})}),results=[];
 for(const symbol of ["ETH","BTC"]){
  const a={id:"native-check-"+symbol,name:"Native market acceptance",symbol,quoteAsset:"USDT",platform:"binance",strategyType:C.ID,tradeMode:"simulation",simulationEnabled:true,simulationBalance:10000,turtleConfig:C.defaults},st={};
  try{
   if(!engine.get(a))engine.commit(a,B.initial(a));const market=await engine.refresh(a),p=engine.preflight(a,st);
   if(!p.allowed)throw Error(p.blockers.join("；"));engine.control(a,st,"start");await engine.tick(a,st);engine.control(a,st,"pause");
   const restored=R.create({directory,permit:()=>({allowed:true})}),b=restored.get(a);
   results.push({symbol:symbol+"USDT",verified:true,source:market.data.source,quoteAsset:market.data.quoteAsset,marketType:market.data.marketType,quoteTime:market.data.quote.time,evaluatedAt:market.evaluatedAt,closed4hBars:market.data.candles.filter(v=>v.time+C.BAR<=market.evaluatedAt).length,signal:market.analysis.code,reason:market.analysis.reason,atr:market.analysis.atr,upper:market.analysis.upper,lower:market.analysis.lower,persistenceRestored:!!b,runningAfterCheck:b.running,orders:b.orders.length,positions:b.position?1:0});
  }catch(e){try{if(engine.get(a)?.running)engine.control(a,st,"pause");}catch{}results.push({symbol:symbol+"USDT",verified:false,blocker:e.message,fallbackUsed:false});}
 }
 const report={at:new Date().toISOString(),revision:C.REVISION,configHash:C.hash(C.defaults),kind:"public_native_connectivity_and_stopped_paper_lifecycle_check",realOrderCalls:0,productionModified:false,profitabilityVerified:false,results};
 fs.writeFileSync(path.join(directory,"native-check.json"),JSON.stringify(report,null,2));return report;
}
if(require.main===module)check(path.resolve(process.argv[2]||fs.mkdtempSync(path.join(os.tmpdir(),"turtle-native-")))).then(r=>{console.log(JSON.stringify(r));if(r.results.some(x=>!x.verified))process.exitCode=2;}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={check};
