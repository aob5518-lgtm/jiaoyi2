"use strict";
// Finite isolated public-data acceptance. No exchange trading adapter is imported.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),C=require('../strategy/macd_scale_in/config'),P=require('../strategy/macd_scale_in/provider'),S=require('../strategy/macd_scale_in/signal'),{createRuntime}=require('../strategy/macd_scale_in/runtime');
const allowedPaths=new Set(['/fapi/v1/klines','/fapi/v1/ticker/bookTicker','/fapi/v1/fundingRate','/fapi/v1/exchangeInfo']);
async function execute(){
 const root=path.resolve('.audit/h06-r3-native-'+Date.now());fs.mkdirSync(root,{recursive:true});const result={startedAt:Date.now(),environment:'isolated local finite process',root,source:P.BASE,realOrderCalls:0,authenticatedCalls:0,accounts:[],completed:false};
 for(const symbol of ['ETH','BTC']){
  const directory=path.join(root,symbol);fs.mkdirSync(directory);const account={id:crypto.randomUUID(),name:'H06-'+symbol+'-NATIVE-ACCEPTANCE',platform:'binance',symbol,quoteAsset:'USDT',strategyType:C.ID,h06Mode:'Shadow',tradeMode:'simulation',simulationEnabled:true,simulationBalance:10000,h06Config:C.normalize({})};
  fs.writeFileSync(path.join(directory,'account.json'),JSON.stringify(account,null,2),{mode:0o600});const requests=[],receipts=[],inflight=new Set();let lastData;
  const request=async url=>{
   const u=new URL(url);if(u.origin!==P.BASE||!allowedPaths.has(u.pathname))throw Error('PUBLIC_NATIVE_ALLOWLIST_BLOCK');
   const record={url,method:'GET',startedAt:Date.now()};requests.push(record);
   const promise=(async()=>{try{const r=await fetch(url,{method:'GET',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});record.status=r.status;if(!r.ok)throw Error('BINANCE_PUBLIC_HTTP_'+r.status);const data=await r.json();record.ok=true;receipts.push({url,receivedAt:Date.now(),data});return data;}catch(e){record.ok=false;record.error=e.message;record.cause=e.cause?.code||null;throw e;}finally{record.elapsedMs=Date.now()-record.startedAt;}})();inflight.add(promise);promise.finally(()=>inflight.delete(promise)).catch(()=>{});return promise;
  };
  const native=P.createProvider(request),provider={load:async(...args)=>{lastData=await native.load(...args);return lastData;}},state={running:true},rounds=[];
  let runtime=createRuntime({directory,provider,permit:()=>({allowed:true})});
  for(let round=0;round<2;round++){
   if(round)runtime=createRuntime({directory,provider,permit:()=>({allowed:true})});
   let error=null;try{await runtime.tick(account,state);}catch(e){error=e.message;}
   await Promise.allSettled([...inflight]);
   const r=runtime.report(account),raw=JSON.parse(fs.readFileSync(path.join(directory,'macd_scale_in_runtime.json'))),closed=(lastData?.candles||[]).filter(v=>v.time+S.HOUR<=Date.now());
   rounds.push({round,afterRestart:round>0,error,marketFresh:r.market.fresh,decision:r.decision,quoteTime:lastData?.quote?.timestamp||null,quoteReceivedAt:lastData?.quote?.receivedAt||null,candleCount:closed.length,continuous:closed.length>1&&closed.every((v,i)=>!i||v.time-closed[i-1].time===S.HOUR),rules:lastData?.rules||null,fundingEvents:lastData?.funding?.length??null,fundingComplete:lastData?.fundingComplete||false,persistedAccountId:raw.books[account.id].accountId,orderCount:raw.books[account.id].orders.length});
  }
  fs.writeFileSync(path.join(directory,'public-receipts.json'),JSON.stringify(receipts));
  result.accounts.push({id:account.id,symbol:symbol+'USDT',mode:'Shadow',hasTradingCredentials:false,directory,requests,rounds,persistenceVerified:rounds.every(v=>v.persistedAccountId===account.id),nativeForwardPassed:rounds.every(v=>!v.error&&v.marketFresh&&v.continuous)});
 }
 result.finishedAt=Date.now();result.completed=result.accounts.every(v=>v.nativeForwardPassed);result.status=result.completed?'NATIVE_PUBLIC_ACCEPTANCE_PASSED':'BLOCKED_NATIVE_PUBLIC_DATA';
 fs.writeFileSync('docs/h06/remediation/native-acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,accounts:result.accounts.map(v=>({symbol:v.symbol,id:v.id,persistence:v.persistenceVerified,rounds:v.rounds.map(r=>({error:r.error,marketFresh:r.marketFresh}))})),realOrderCalls:result.realOrderCalls}));
}
if(require.main===module)execute().catch(e=>{console.error(e.stack);process.exitCode=1;});module.exports={allowedPaths};
