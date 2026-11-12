"use strict";
const fs=require('fs'),path=require('path'),C=require('./config'),S=require('./signal'),B=require('./book'),Provider=require('./provider'),D=require('./diagnostics');
function createRuntime(d){
 const file=path.join(d.directory,'macd_scale_in_runtime.json'),provider=d.provider||Provider.createProvider();let books={},failure='';const locks=new Set();
 try{if(fs.existsSync(file)){const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.schema!==1||!data.books||Array.isArray(data.books))throw Error('schema');books=data.books;for(const b of Object.values(books))if(b.pending){const index=b.orders.findIndex(o=>o.id===b.pending.id);if(index<0)throw Error('pending not journaled');b.orders[index]=b.pending;}for(const [id,b]of Object.entries(books)){if(b.accountId!==id||!Number.isFinite(b.equity)||!Array.isArray(b.history)||!Array.isArray(b.consumed)||b.schema!==1||!Array.isArray(b.orders))throw Error('invalid ledger');const sum=b.history.reduce((n,v)=>{if(!Number.isFinite(v.netPnl)||!v.config||!v.configHash)throw Error('history evidence');return n+v.netPnl;},0);if(Math.abs(b.initialEquity+sum-b.equity)>1e-5||Math.abs(sum-b.realizedNetPnl)>1e-5)throw Error('equity mismatch');if(b.cycle){C.normalize(b.cycle.config);if(!(b.cycle.qty>=0&&b.cycle.averagePrice>0&&b.cycle.marginUsed>0&&b.cycle.riskBudget>0)||!Array.isArray(b.cycle.entries)||!Array.isArray(b.cycle.layers))throw Error('cycle invalid');}if(b.pending&&!(b.pending.qty>0&&b.pending.filledQty>=0&&b.pending.filledQty<=b.pending.qty))throw Error('pending invalid');}}}
 catch(e){failure='H06_LEDGER_CORRUPT：保留原账本并禁止新增交易';books={};}
 function save(next=books){if(failure)throw Error(failure);const temp=file+'.tmp-'+process.pid,fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,books:next}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);books=next;}
 function get(a){C.assertAccount(a);const b=books[a.id]||B.initial(a);if(b.identity!==B.initial(a).identity)throw Error('H06_IDENTITY_MISMATCH');return b;}
 function commit(a,b){C.assertAccount(a);if(b.identity!==B.initial(a).identity)throw Error('H06_IDENTITY_MISMATCH：模拟账本身份或初始权益不一致');save({...books,[a.id]:b});}
 async function tick(a,st,{manualClose=false}={}){
  if(locks.has(a.id))throw Error('H06_TICK_BUSY');locks.add(a.id);
  try{
   C.assertAccount(a);if(failure)throw Error(failure);let b=get(a);if(!st.running&&!b.cycle&&!b.pending)return;
   const beforeOrders=new Map(b.orders.slice(-50).map(o=>[o.id,JSON.stringify(o)]));
   const c=b.cycle?.config||b.pending?.meta?.config||C.normalize(a.h06Config),from=b.cycle?.openedAt||Date.now()-24*S.HOUR;
   let data;try{data=await provider.load(a,c,from);}catch(e){const failed=structuredClone(b);failed.lastError=e.message;failed.marketFresh=false;failed.decision={code:'MARKET_UNAVAILABLE',reason:'原生行情读取失败，禁止新增风险：'+e.message,at:Date.now()};commit(a,failed);throw e;}
   const now=d.now?d.now():Date.now(),problem=Provider.validate(data,a,c,now),analysis=S.analyze(data.candles,c,now,a);
   if(analysis.signal){const structure=data.candles.filter(v=>v.time+S.HOUR<=now).slice(-c.atrPeriod);analysis.signal={...analysis.signal,structureLow:Math.min(...structure.map(v=>v.low)),structureHigh:Math.max(...structure.map(v=>v.high))};}
   const higherDirection=require('./higher').closedDirection(data.higherCandles||[],now);
   const marketOK=!problem&&!['WARMUP','CANDLE_GAP','CANDLE_STALE'].includes(analysis.code),price=problem&&['SOURCE_MISMATCH','QUOTE_INVALID','QUOTE_STALE'].includes(problem[0])?null:data.quote?.price;
   const validFunding=data.funding.filter(v=>Number.isFinite(v.rate)&&v.markPrice>0&&Number.isFinite(v.time));
   if(problem&&['FUNDING_INVALID','FUNDING_INCOMPLETE'].includes(problem[0])&&b.cycle){b=structuredClone(b);b.riskLock=true;b.riskLockReason='FUNDING_REVIEW_REQUIRED：资金费证据不完整，冻结新增风险';b.cycle.costDataIncomplete=true;}
   if(!problem&&b.cycle?.costDataIncomplete){b=structuredClone(b);b.cycle.costDataIncomplete=false;}
   const event={time:now,price,quoteTime:data.quote.timestamp,quoteId:[data.quote.symbol,data.quote.timestamp,data.quote.bid,data.quote.ask].join(':'),signal:analysis.signal,running:!!st.running,marketOK,marketReason:problem?.[1]||analysis.reason,manualClose,account:a,rules:data.rules,funding:validFunding,fundingComplete:data.fundingComplete,externalRiskLock:!!st.riskLock,unknownOrder:!!st.pendingOrder||!!st.placingOrder,higherDirection,permit:(risk,side)=>d.permit?d.permit(a,risk,side):{allowed:false,reason:'组合风险未接入'}};
   // Persist submission first. A crash before fill leaves an auditable pending order, never a duplicate.
   const hadPending=!!b.pending;
   if(b.pending){
    b=B.advance(b,{...event,signal:null,manualClose},c);commit(a,b);
    if(b.pending){
    const p=b.pending,entry=['open','add'].includes(p.kind),side=p.side;
    const liquidity=entry?(side==='long'?data.quote.askQty:data.quote.bidQty):p.qty;
    const participation=entry?Math.min(1,Number(liquidity)*c.maxParticipationPct/p.qty):1;
    // A bounded quote consumes one fill, then cancels any entry remainder.
    if(!(participation>0)&&entry)event.marketOK=false;
    if(entry){const pcheck=d.permit?d.permit(a,b.cycle?.riskBudget||p.meta.riskBudget,side):{allowed:false};if(!pcheck.allowed)event.marketOK=false;}
    b=B.execute(b,event,{fillFraction:participation,price:entry?(side==='long'?data.quote.ask:data.quote.bid):(side==='long'?data.quote.bid:data.quote.ask)});commit(a,b);
    }
   }
   // After a pending order ends flat, evaluate the next configuration on a fresh tick.
   // Never feed indicators calculated from the old snapshot into a new configuration.
   if(!hadPending||b.cycle||b.pending)b=B.advance(b,event,c);
   b.lastAnalysis=analysis;b.lastError=problem?.[1]||'';b.marketFresh=marketOK;b.updatedAt=now;b.lastFundingCoverage={from,to:now,complete:data.fundingComplete};
   const record={...C.scope(c,a),evaluatedAt:now,time:analysis.closedTime||now,signalId:analysis.signal?.id||null,direction:analysis.signal?.side||'none',signalPermission:analysis.signal?'allowed':'blocked',executionDecision:b.decision?.code,reason:b.decision?.reason,indicators:analysis.indicators};
   D.update(b,record,b.orders.slice(-50).filter(o=>beforeOrders.get(o.id)!==JSON.stringify(o)));
   commit(a,b);st.currentPrice=price;st.activeError='';st.updatedAt=new Date(now).toLocaleString('zh-CN');
  }catch(e){st.activeError=st.lastError=e.message;st.lastErrorAt=Date.now();throw e;}finally{publish(a,st);locks.delete(a.id);}
 }
 function report(a){const b=get(a),c=C.normalize(a.h06Config),p=b.cycle,now=d.now?d.now():Date.now(),fresh=b.marketFresh&&Number.isFinite(b.lastQuote?.quoteTime)&&now>=b.lastQuote.quoteTime-2000&&now-b.lastQuote.quoteTime<=(p?.config||b.pending?.meta?.config||c).quoteMaxAgeMs,price=b.lastQuote?.price||null,lastTotal=p?.costDataIncomplete?null:p&&price?B.netAt(p,price):p?null:0,total=p&&!fresh?null:lastTotal;
  const scope=C.scope(c,a),currentSignals=b.signals.filter(v=>v.configHash===scope.configHash&&v.strategyRevision===scope.strategyRevision),currentOrders=b.orders.filter(o=>o.meta?.scope?.configHash===scope.configHash),activeConfig=p?.config||b.pending?.meta?.config||null;
  return{...scope,lastKnown:{price,cycleNetPnl:lastTotal,updatedAt:b.updatedAt||null},signalStats24h:D.stats(currentSignals,now-24*S.HOUR,now,{orders:currentOrders,currentOrders:b.orders}),signalStats72h:D.stats(currentSignals,now-72*S.HOUR,now,{orders:currentOrders,currentOrders:b.orders}),configMetadata:{limits:C.limits,choices:C.choices,bools:C.bools},signalUsed:b.lastAnalysis?.signal?b.consumed.includes(b.lastAnalysis.signal.id):false,config:c,activeConfig,configuration:{activeSource:p?'cycle':b.pending?'pending_order':'next_cycle',different:!!activeConfig&&JSON.stringify(activeConfig)!==JSON.stringify(c),next:c,current:activeConfig},allowLive:false,realOrderPermission:false,mode:a.h06Mode,book:{initialEquity:b.initialEquity,equity:b.equity,realizedNetPnl:b.realizedNetPnl,riskLock:b.riskLock||!!failure,riskLockReason:failure||b.riskLockReason},phase:b.phase,cycle:p,pending:b.pending,decision:b.decision||{code:'WAIT_SIGNAL',reason:'启动后等待新的已收盘 MACD 信号'},market:{fresh:!!fresh,price:fresh?price:null,updatedAt:b.updatedAt||null,error:b.lastError||failure||null},analysis:b.lastAnalysis||null,totalNetPnl:total,roi:p&&total!==null?100*total/p.marginUsed:null,equity:total===null?null:b.equity+total,remainingRisk:p&&total!==null?Math.max(0,p.riskBudget+total):null,history:b.history.slice(-50),signals:b.signals.slice(-50),orders:b.orders.slice(-50),day:b.day};
 }
 function publish(a,st){try{const r=report(a),p=r.cycle;st.h06={phase:r.phase,decision:r.decision,mode:r.mode,market:r.market,allowLive:false};st.balance=r.equity;st.available=r.equity===null?null:r.equity-(p?.marginUsed||0);st.positionQty=p?.qty||0;st.entryPrice=p?.averagePrice||0;st.pnl=r.totalNetPnl;st.roi=r.roi;st.lastAction=r.decision.reason;}catch(e){st.activeError=e.message;}}
 return{get,commit,save,tick,report,publish,busy:a=>!!get(a).cycle||!!get(a).pending,exposure:a=>B.exposure(get(a)),failure:()=>failure};
}
module.exports={createRuntime};
