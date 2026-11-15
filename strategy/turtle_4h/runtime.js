"use strict";
const fs=require("fs"),path=require("path"),C=require("./config"),S=require("./signal"),B=require("./book"),P=require("./provider");
function create(d){
 const file=path.join(d.directory,"turtle_4h_paper.json"),provider=d.provider||P.create(),now=d.now||Date.now;let books={},failure="";const locks=new Set(),markets=new Map();
 try{if(fs.existsSync(file)){const x=JSON.parse(fs.readFileSync(file,"utf8"));if(x.schema!==1||!x.books||Array.isArray(x.books))throw Error();
  for(const b of Object.values(x.books)){
   if(b.schema!==1||!Number.isFinite(b.balance)||!Number.isFinite(b.realized)||!Array.isArray(b.trades)||!Array.isArray(b.orders)||b.trades.some(t=>!Number.isFinite(t.netPnl))||Math.abs(b.initialEquity+b.trades.reduce((n,t)=>n+t.netPnl,0)-b.balance)>1e-6||Math.abs(b.balance-b.initialEquity-b.realized)>1e-6||b.pending&&!b.orders.some(o=>o.id===b.pending.id))throw Error();
   const ids=b.orders.map(o=>o.id);if(new Set(ids).size!==ids.length||b.orders.some(o=>!["SUBMITTED","FILLED","PARTIAL_FILLED_CANCELLED","CANCELLED"].includes(o.status)||o.status==="SUBMITTED"&&o.id!==b.pending?.id)||b.pending&&b.orders.find(o=>o.id===b.pending.id)?.status!=="SUBMITTED")throw Error();
   if(b.pending?.kind==="open"){C.normalize(b.pending.meta.config);if(!(b.pending.meta.qty>0&&b.pending.meta.budget>0&&b.pending.meta.distance>0))throw Error();}
   if(b.position){C.normalize(b.position.config);if(!(b.position.qty>0&&b.position.entry>0&&b.position.stop>0&&b.position.actualRisk>0&&b.position.cost?.exitFeeRate>=0&&Number.isFinite(b.position.fundingThrough)))throw Error();}
  }books=x.books;
 }}catch{failure="LEDGER_REVIEW：模拟账本异常，保留文件并阻止操作";}
 function get(a){C.assertAccount(a);if(failure)throw Error(failure);const b=books[a.id];if(b&&b.identity!==C.identity(a))throw Error("IDENTITY_MISMATCH：账户身份与独立账本不一致");return b||null;}
 function commit(a,b){C.assertAccount(a);if(failure||b.identity!==C.identity(a))throw Error(failure||"IDENTITY_MISMATCH");const next={...books,[a.id]:b},temp=file+".tmp";const fd=fs.openSync(temp,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,books:next}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);books=next;}
 async function refresh(a) {
  const b=get(a),c=b?.position?.config||b?.pending?.meta.config||C.normalize(a.turtleConfig);
  const since=b?.position?.fundingThrough||now()-24*3600000,data=await provider.load(a,c,since),evaluatedAt=now();
  // Evaluate AFTER network completion; native quote timestamps may be newer than request start.
  P.validate(data,a,evaluatedAt);const analysis=S.analyze(data.candles,c,evaluatedAt);const result={data,analysis,evaluatedAt};markets.set(a.id,result);return result;
 }
 async function tick(a,st,{manual=false}={}) {
  if(locks.has(a.id))throw Error("TICK_BUSY");locks.add(a.id);
  try{
   if(!get(a))return;
   const r=await refresh(a),b=get(a),c=b.position?.config||b.pending?.meta.config||C.normalize(a.turtleConfig);
   let next=B.advance(b,{time:r.evaluatedAt,data:r.data,analysis:r.analysis,marketOK:!["WARMUP","CANDLE_GAP","CANDLE_STALE"].includes(r.analysis.code),manual,account:a,blocker:st.riskLock?"账户风险锁定":st.pendingOrder||st.placingOrder?"外部存在未确认订单":null,permit:(risk,side)=>d.permit?d.permit(a,risk,side):{allowed:false,reason:"组合风险未接入"}},c);
   next.lastAnalysis=r.analysis;next.updatedAt=r.evaluatedAt;next.activeError="";commit(a,next);st.activeError="";st.lastAction=next.decision.reason;st.running=next.running;st.positionQty=next.position?.qty||0;st.currentPrice=(r.data.quote.bid+r.data.quote.ask)/2;
  }catch(e){st.activeError=st.lastError=e.message;st.lastErrorAt=now();throw e;}finally{locks.delete(a.id);}
 }
 function configure(a,c,expectedHash){
  const b=get(a);if(!b)throw Error("BOOK_MISSING");
  if(C.hash(C.normalize(a.turtleConfig))!==expectedHash)throw Error("CONFIG_CONFLICT：参数已在其他页面修改，请重新读取后编辑");
  C.normalize(c);return {nextCycleOnly:!!(b.position||b.pending),activeConfig:b.position?.config||b.pending?.meta.config||null};
 }
 function control(a,st,action){
  const b=structuredClone(get(a));if(!b)throw Error("BOOK_MISSING");
  if(action==="start"){
   const p=preflight(a,st);if(!p.allowed)throw Error(p.blockers.join("；"));
   b.running=true;
   // Never enter an already elapsed signal when the user starts/restarts a monitor.
   if(!b.position&&!b.pending)b.lastSignalAt=Math.max(b.lastSignalAt,markets.get(a.id).analysis.closedAt||0);
  }else if(action==="pause"){
   b.running=false;if(b.pending?.kind==="open"){const o=b.orders.find(o=>o.id===b.pending.id);o.status="CANCELLED";o.finishedAt=now();b.pending=null;}
  }else throw Error("CONTROL_INVALID");
  commit(a,b);st.running=b.running;
 }
 function preflight(a,st={}){
  const b=get(a),r=markets.get(a.id),blockers=[];
  if(!b)blockers.push("模拟账本尚未建立");
  if(b?.riskLock||st.riskLock)blockers.push("风险锁未解除");
  if(b?.day?.date===new Date(now()).toISOString().slice(0,10)&&b.day.net<=-.02*b.day.startingEquity)blockers.push("本日已结算亏损达到 2%，暂停新增风险");
  if(st.pendingOrder||st.placingOrder||b?.pending)blockers.push("存在未完成或未确认委托");
  if(!r||now()-r.evaluatedAt>15000)blockers.push("需要重新检查原生行情");
  else {try{P.validate(r.data,a,now());}catch(e){blockers.push(e.message);}
   if(["WARMUP","CANDLE_GAP","CANDLE_STALE"].includes(r.analysis.code))blockers.push(r.analysis.reason);
  }
  return {allowed:blockers.length===0,blockers,configHash:C.hash(a.turtleConfig),mode:"Paper",realOrderPermission:false,analysis:r?.analysis||null,checkedAt:r?.evaluatedAt||null};
 }
 function view(a,st={}){
  const b=get(a),c=C.normalize(a.turtleConfig),r=markets.get(a.id),fresh=!!r&&now()-r.data.quote.time<=15000&&now()>=r.data.quote.time-2000;
  const price=fresh?(r.data.quote.bid+r.data.quote.ask)/2:null,p=b?.position,exitPrice=fresh?(p?.side==="short"?r.data.quote.ask:r.data.quote.bid):null;
  const floating=p&&exitPrice?B.net(p,exitPrice*(1+(p.side==="long"?-1:1)*p.cost.estimatedExitSlippage)):p?null:0,activeConfig=p?.config||b?.pending?.meta.config||null;
  return {id:a.id,name:a.name,symbol:a.symbol,platform:a.platform,quoteAsset:"USDT",strategyType:C.ID,mode:"Paper",allowLive:false,realOrderPermission:false,revision:C.REVISION,config:c,configHash:C.hash(c),activeConfig,nextCycleOnly:!!activeConfig,configDiffers:!!activeConfig&&C.hash(activeConfig)!==C.hash(c),running:!!b?.running,price,fresh,updatedAt:r?.evaluatedAt||null,analysis:r?.analysis||b?.lastAnalysis||null,preflight:preflight(a,st),decision:st.activeError?{code:"MARKET_UNAVAILABLE",reason:st.activeError}:b?.decision||{code:"MONITOR_STOPPED",reason:"保存参数后检查并启动"},position:p||null,pending:b?.pending||null,balance:b?.balance??a.simulationBalance,equity:floating===null?null:(b?.balance??a.simulationBalance)+floating,floating,realized:b?.realized??0,history:b?.trades.slice(-50).reverse()||[],orders:b?.orders.slice(-20).reverse()||[],riskLock:!!b?.riskLock||!!st.riskLock};
 }
 return {get,commit,refresh,tick,control,configure,preflight,view,failure:()=>failure,busy:id=>locks.has(id)};
}
module.exports={create};
