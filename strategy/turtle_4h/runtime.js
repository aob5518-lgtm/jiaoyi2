"use strict";
const fs=require("fs"),path=require("path"),Turtle=require("./config"),S=require("./signal"),B=require("./book"),P=require("./provider");
function create(d){
 const C=d.profile||Turtle,analyze=d.analyze||S.analyze,configKey=C.configKey||"turtleConfig";
 const file=path.join(d.directory,C.ledgerName||"turtle_4h_paper.json"),provider=d.provider||P.create(undefined,undefined,C),now=d.now||Date.now;let books={},failure="";const locks=new Set(),markets=new Map(),marketErrors=new Map();
 try{if(fs.existsSync(file)){const x=JSON.parse(fs.readFileSync(file,"utf8"));if(x.schema!==1||!x.books||Array.isArray(x.books))throw Error();
  for(const b of Object.values(x.books)){
   if(b.schema!==1||!Number.isFinite(b.balance)||!Number.isFinite(b.realized)||!Array.isArray(b.trades)||!Array.isArray(b.orders)||b.trades.some(t=>!Number.isFinite(t.netPnl))||Math.abs(b.initialEquity+b.trades.reduce((n,t)=>n+t.netPnl,0)-b.balance)>1e-6||Math.abs(b.balance-b.initialEquity-b.realized)>1e-6||b.pending&&!b.orders.some(o=>o.id===b.pending.id))throw Error();
   const ids=b.orders.map(o=>o.id);if(new Set(ids).size!==ids.length||b.orders.some(o=>!["SUBMITTED","FILLED","PARTIAL_FILLED_CANCELLED","CANCELLED"].includes(o.status)||o.status==="SUBMITTED"&&o.id!==b.pending?.id)||b.pending&&b.orders.find(o=>o.id===b.pending.id)?.status!=="SUBMITTED")throw Error();
   if(b.pending?.kind==="open"){C.normalize(b.pending.meta.config);if(!(b.pending.meta.qty>0&&b.pending.meta.budget>0&&b.pending.meta.distance>0))throw Error();}
   if(b.position){C.normalize(b.position.config);if(!(b.position.qty>0&&b.position.entry>0&&b.position.stop>0&&b.position.actualRisk>0&&b.position.cost?.exitFeeRate>=0&&Number.isFinite(b.position.fundingThrough)))throw Error();}
   if(C.waitCode&&b.pending?.kind==="open"&&!(b.pending.meta.entry?.stop>0&&b.pending.meta.entry?.target>0))throw Error();
   if(C.waitCode&&b.position&&!(b.position.target>0&&b.position.plannedNetR>=b.position.config.minNetR&&
      (b.position.side==="long"?b.position.stop<b.position.entry&&b.position.entry<b.position.target:
       b.position.side==="short"&&b.position.target<b.position.entry&&b.position.entry<b.position.stop)))throw Error();
  }books=x.books;
 }}catch{failure="LEDGER_REVIEW：模拟账本异常，保留文件并阻止操作";}
 function get(a){C.assertAccount(a);if(failure)throw Error(failure);const b=books[a.id];if(b&&b.identity!==C.identity(a))throw Error("IDENTITY_MISMATCH：账户身份与独立账本不一致");return b||null;}
 function commit(a,b){C.assertAccount(a);if(failure||b.identity!==C.identity(a))throw Error(failure||"IDENTITY_MISMATCH");const next={...books,[a.id]:b},temp=file+".tmp";const fd=fs.openSync(temp,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,books:next}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);books=next;}
 async function refresh(a) {
  const b=get(a),c=b?.position?.config||b?.pending?.meta.config||C.normalize(a[configKey]);
  try {
   const since=b?.position?.fundingThrough||now()-24*3600000;
   const [snapshot,leverageSpec]=await Promise.all([provider.load(a,c,since),
    c.leverage>1&&d.leverageRules?d.leverageRules(a):undefined]);
   const data={...snapshot,leverageSpec},evaluatedAt=now();
   // Evaluate after network completion, against the exchange timestamp.
   P.validate(data,a,evaluatedAt);
   const result={data,analysis:analyze(data.candles,c,evaluatedAt),evaluatedAt,configHash:C.hash(c)};
   markets.set(a.id,result);
   marketErrors.delete(a.id);
   return result;
  } catch(error) {
   marketErrors.set(a.id,error.message);
   throw error;
  }
 }
 async function tick(a,st,{manual=false}={}) {
  if(locks.has(a.id))throw Error("TICK_BUSY");locks.add(a.id);
  try{
   if(!get(a))return;
   const r=await refresh(a),b=get(a),c=b.position?.config||b.pending?.meta.config||C.normalize(a[configKey]);
   let next=B.advance(b,{time:r.evaluatedAt,data:r.data,analysis:r.analysis,marketOK:!["WARMUP","CANDLE_GAP","CANDLE_STALE"].includes(r.analysis.code),manual,account:a,blocker:st.riskLock?"账户风险锁定":st.pendingOrder||st.placingOrder?"外部存在未确认订单":null,permit:(risk,side)=>d.permit?d.permit(a,risk,side):{allowed:false,reason:"组合风险未接入"}},c,C);
   next.lastAnalysis=r.analysis;next.updatedAt=r.evaluatedAt;next.activeError="";commit(a,next);st.activeError="";st.lastAction=next.decision.reason;st.running=next.running;st.positionQty=next.position?.qty||0;st.currentPrice=(r.data.quote.bid+r.data.quote.ask)/2;
  }catch(e){st.activeError=st.lastError=e.message;st.lastErrorAt=now();throw e;}finally{locks.delete(a.id);}
 }
 function configure(a,c,expectedHash){
  const b=get(a);if(!b)throw Error("BOOK_MISSING");
  if(C.hash(C.normalize(a[configKey]))!==expectedHash)throw Error("CONFIG_CONFLICT：参数已在其他页面修改，请重新读取后编辑");
  C.normalize(c);return {nextCycleOnly:!!(b.position||b.pending),activeConfig:b.position?.config||b.pending?.meta.config||null};
 }
 function control(a,st,action){
  const b=structuredClone(get(a));if(!b)throw Error("BOOK_MISSING");
  if(action==="start"){
   if(b.running)return;
   const p=preflight(a,st);if(!p.allowed)throw Error(p.blockers.join("；"));
   b.running=true;
   // Never enter an already elapsed signal when the user starts/restarts a monitor.
   if(!b.position&&!b.pending)b.lastSignalAt=Math.max(b.lastSignalAt,markets.get(a.id).analysis.closedAt||0);
   b.decision=b.position
    ?{code:"POSITION_MANAGED",reason:"已恢复模拟监控，当前仓位继续按锁定参数管理",time:now()}
    :{code:C.waitCode||"WAIT_BREAKOUT",reason:"模拟已启动，"+(C.waitReason||"等待下一根已收盘 4H 突破信号"),time:now()};
  }else if(action==="pause"){
   b.running=false;if(b.pending?.kind==="open"){const o=b.orders.find(o=>o.id===b.pending.id);o.status="CANCELLED";o.finishedAt=now();b.pending=null;}
   if(!b.pending)b.decision=b.position
    ?{code:"POSITION_MANAGED",reason:"已暂停新开仓，当前仓位的退出保护继续",time:now()}
    :{code:"MONITOR_STOPPED",reason:"已暂停新开仓",time:now()};
  }else throw Error("CONTROL_INVALID");
  commit(a,b);st.running=b.running;
 }
 function market(a,time) {
  const record=markets.get(a.id),error=marketErrors.get(a.id);
  if(error)return {state:"unavailable",reason:error,record};
  if(!record)return {state:"unchecked",reason:"尚未收到原生行情",record};
  try {P.validate(record.data,a,time);}
  catch(error){return {state:"stale",reason:error.message,record};}
  return {state:"fresh",reason:null,record};
 }
 function preflight(a,st={}){
  const b=get(a),time=now(),m=market(a,time),r=m.record,blockers=[];
  if(!b)blockers.push("模拟账本尚未建立");
  if(b?.riskLock||st.riskLock)blockers.push("风险锁未解除");
  if(b?.day?.date===new Date(now()).toISOString().slice(0,10)&&b.day.net<=-.02*b.day.startingEquity)blockers.push("本日已结算亏损达到 2%，暂停新增风险");
  if(st.pendingOrder||st.placingOrder||b?.pending)blockers.push("存在未完成或未确认委托");
  if(m.state!=="fresh")blockers.push(m.reason);
  else {
   const c=b?.position?.config||b?.pending?.meta.config||a[configKey];
   if(r.configHash!==C.hash(c))blockers.push("参数刚更新，请重新检查行情");
   else if(["WARMUP","CANDLE_GAP","CANDLE_STALE"].includes(r.analysis.code))blockers.push(r.analysis.reason);
   else if(r.analysis.closedAt+C.BAR<=time)blockers.push("等待最新 "+(C.interval||"4H")+" 收盘 K 线");
  }
  return {allowed:blockers.length===0,blockers,configHash:C.hash(a[configKey]),mode:"Paper",realOrderPermission:false,analysis:r?.analysis||null,checkedAt:m.state==="fresh"?r.evaluatedAt:null};
 }
 function view(a,st={}){
  const b=get(a),c=C.normalize(a[configKey]),time=now(),m=market(a,time),r=m.record,fresh=m.state==="fresh";
  const price=fresh?(r.data.quote.bid+r.data.quote.ask)/2:null,p=b?.position,exitPrice=fresh?(p?.side==="short"?r.data.quote.ask:r.data.quote.bid):null;
  const floating=p&&exitPrice?B.net(p,exitPrice*(1+(p.side==="long"?-1:1)*p.cost.estimatedExitSlippage)):p?null:0;
  const locked=p?.config||b?.pending?.meta.config,activeConfig=locked?C.normalize(locked):null;
  const hash=C.hash(c),preview=fresh&&(r.configHash===hash?r.analysis:analyze(r.data.candles,c,time));
  const nextEntry=preview?.next?.closesAt>time?{...preview.next,direction:c.direction}:null;
  const decision=m.reason&&m.state!=="unchecked"?{code:"MARKET_UNAVAILABLE",reason:m.reason}:st.activeError?{code:"RUNTIME_ERROR",reason:st.activeError}:b?.decision||{code:"MONITOR_STOPPED",reason:"保存参数后检查并启动"};
  return {id:a.id,name:a.name,symbol:a.symbol,platform:a.platform,quoteAsset:"USDT",strategyType:C.ID,mode:"Paper",allowLive:false,realOrderPermission:false,revision:C.REVISION,config:c,configHash:hash,activeConfig,nextCycleOnly:!!activeConfig,configDiffers:!!activeConfig&&C.hash(activeConfig)!==hash,running:!!b?.running,price,fresh,
   market:{state:m.state,reason:m.reason,quoteTime:r?.data.quote.time??null},nextEntry,updatedAt:r?.evaluatedAt||null,analysis:r?.analysis||b?.lastAnalysis||null,preflight:preflight(a,st),decision,
   position:p||null,pending:b?.pending||null,balance:b?.balance??a.simulationBalance,equity:floating===null?null:(b?.balance??a.simulationBalance)+floating,floating,realized:b?.realized??0,history:b?.trades.slice(-50).reverse()||[],orders:b?.orders.slice(-20).reverse()||[],riskLock:!!b?.riskLock||!!st.riskLock};
 }
 return {get,commit,refresh,tick,control,configure,preflight,view,failure:()=>failure,busy:id=>locks.has(id)};
}
module.exports={create};
