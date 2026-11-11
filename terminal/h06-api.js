"use strict";
const crypto=require('crypto'),C=require('../strategy/macd_scale_in/config'),B=require('../strategy/macd_scale_in/book');
function overview(a,st,r){const p=r.cycle,fresh=r.market.fresh,float=p?r.totalNetPnl:0;
 return{policy:{status:'SUPPORTED',entryAllowed:!r.book.riskLock,migrationEligible:false},kind:C.ID,mode:a.h06Mode,equity:r.equity,realized:r.book.realizedNetPnl,netFloating:float,
 position:p?{side:p.side,qty:p.qty,entry:p.averagePrice,price:r.market.price,stop:p.stopPrice,target:null,netFloating:float,risk:p.riskBudget}:null,orders:r.pending?[r.pending]:[],status:r.phase,
 decision:{direction:r.analysis?.signal?.side||p?.side||'none',allowed:!!st.running&&fresh&&!r.book.riskLock&&r.decision?.code==='ORDER_SUBMITTED',reason:r.decision.reason,next:r.phase==='WAIT_REVERSE_EXIT'?'已部分止盈，等待反向 MACD 全平':p?'亏损且出现新同向 MACD 信号才允许补仓；强制止损持续有效':'等待新的已收盘 1H MACD 信号',signalTime:r.analysis?.signal?.closedTime||null},health:{system:'online',running:!!st.running,market:fresh?'正常':'数据不足或陈旧',riskLocked:r.book.riskLock,error:st.activeError||r.market.error,lastError:st.lastError||null,lastErrorAt:st.lastErrorAt||null}};
}
function terminal(a,d){const st=d.state(a.id),reported=d.h06.report(a),r={...reported,book:{...reported.book,riskLock:reported.book.riskLock||!!st.riskLock,riskLockReason:reported.book.riskLockReason||st.riskLockReason||''}};return{ok:true,currentAccountId:a.id,account:{...d.sanitize(a,st),h06Mode:a.h06Mode},catalog:require('./policy').catalog(),overview:overview(a,st,r),h06:r,config:r.config,accounts:d.accounts().map(v=>{const s=d.state(v.id),h=v.strategyType===C.ID?d.h06.report(v):null;return{id:v.id,name:v.name,platform:v.platform,symbol:v.symbol,quoteAsset:v.quoteAsset,strategyType:v.strategyType,running:!!s.running,netPnl:h?.book.realizedNetPnl??null,policy:require('./policy').classify(v,s,{})};}),operations:{start:true,pause:true,close:true,migrate:false,configurationLocked:false}};}
function allowed(input,fields){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw Error('H06_REQUEST_FIELDS：不允许修改账户身份、模式或资金');}
function body(req){return new Promise((resolve,reject)=>{let data='',large=false;req.on('data',v=>{if(!large){data+=v;if(Buffer.byteLength(data)>32768){large=true;data='';}}});req.on('end',()=>{try{if(large)throw Error();resolve(JSON.parse(data||'{}'));}catch{reject(Error('H06 请求格式无效或超过限制'));}});req.on('error',reject);});}
async function handle(req,res,parsed,d){let lock=null,st,ownsMutation=false;const q=parsed.query||{},route=parsed.pathname,send=(code,data)=>d.json(res,code,require('./model').redact(data));
 try{
  if(req.method==='GET'){
   const a=d.getAccountById(q.id||d.getCurrentAccount()?.id);C.assertAccount(a||{});
   if(route==='/api/v4/terminal'||route==='/api/v4/h06/status')return send(200,terminal(a,d));
   if(route==='/api/v4/history'||route==='/api/v4/h06/history'){
    let rows=d.h06.get(a).history.map(v=>({...v,original:v}));const HM=require('../public/history-model');rows=HM.filter(rows,{...q,from:q.from?Number(q.from):null,to:q.to?Number(q.to):null,strategy:q.strategy||'all',revision:q.revision||'all',sample:q.sample||'all',hash:q.hash||''});rows.sort((a,b)=>b.exitTime-a.exitTime);const offset=Math.max(0,Number(q.offset)||0),limit=Math.min(100,Math.max(1,Number(q.limit)||50));return send(200,{ok:true,items:q.export==='true'?rows:rows.slice(offset,offset+limit),total:rows.length,summary:HM.summary(rows),offset,limit});
   }
   if(route==='/api/v4/analysis'){const r=d.h06.report(a),scope=require('./analysis').scopeFor(C.scope(a.h06Config,a),q),hours=q.hours==='all'?0:Math.min(720,Math.max(1,Number(q.hours)||72)),from=hours?Date.now()-hours*3600000:0,match=v=>['experimentId','strategyRevision','configHash'].every(k=>v[k]===scope[k])&&(!q.sample||v.sampleType===q.sample);const rows=d.h06.get(a).history.filter(v=>v.exitTime>=from&&match(v));return send(200,{ok:true,hours,data:{mode:a.h06Mode,scope,statistics:require('../strategy/short_term_v1/analytics').metrics(rows),signalJournal:d.h06.get(a).signals.filter(v=>v.time>=from&&match(v)).slice(-50),signalStats:require('../strategy/macd_scale_in/diagnostics').stats(d.h06.get(a).signals.filter(match),from,Date.now()),tradeReview:require('../strategy/macd_scale_in/review').build(rows),h06:r}});}
   throw Error('H06 接口不存在');
  }
  if(req.method!=='POST')return send(405,{ok:false,error:'方法不允许'});
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return send(403,{ok:false,error:'请在本站操作'});
  const input=await body(req);
  if(route==='/api/v4/h06/accounts'){
   allowed(input,['name','symbol','initialEquity','mode','config']);
   const symbol=input.symbol||'ETH',mode=input.mode||'Paper',equity=input.initialEquity??10000;
   if(!['ETH','BTC'].includes(symbol)||!['Paper','Shadow','Research'].includes(mode)||typeof equity!=='number'||equity<100||equity>1e7||!String(input.name||'').trim()||String(input.name).length>60)throw Error('H06 新账户参数无效');
   const config=C.normalize(input.config||{}),account={id:crypto.randomUUID(),name:input.name.trim(),platform:'binance',symbol,quoteAsset:'USDT',strategyType:C.ID,strategyMode:'H06 MACD Scale-In V1',h06Mode:mode,h06Config:config,tradeMode:'simulation',simulationEnabled:true,simulationBalance:equity,running:false,interval:15000,leverage:config.leverage,side:'long',maxAdds:config.maxAdds,baseAmount:1,addAmount:1,takeProfit:.01,addTrigger:.01};
   const before=d.configuration(),cfg=structuredClone(before);cfg.accounts.push(account);try{d.save(cfg);d.h06.commit(account,B.initial(account));}catch(e){d.save(before);throw e;}return send(200,{ok:true,id:account.id,mode,allowLive:false});
  }
  const a=d.getAccountById(input.id||d.getCurrentAccount()?.id);C.assertAccount(a||{});st=d.state(a.id);if(st.tickRunning||st.terminalMutating)throw Error('账户正在执行，请稍后重试');lock=d.lock(a.id);if(!lock)throw Error('账户执行锁忙');st.terminalMutating=true;ownsMutation=true;
  if(route==='/api/v4/config'||route==='/api/v4/h06/config'){
   allowed(input,['id','config','name']);const c=C.normalize(input.config||{}),cfg=d.configuration(),target=cfg.accounts.find(v=>v.id===a.id);target.h06Config=c;if(input.name!==undefined){if(typeof input.name!=='string'||!input.name.trim()||input.name.length>60)throw Error('账户名称无效');target.name=input.name.trim();}d.save(cfg);return send(200,{ok:true,nextCycleOnly:!!d.h06.get(a).cycle,message:'参数保存；已有轮次继续使用锁定快照，不自动启动'});
  }
  if(route==='/api/v4/control'||route==='/api/v4/h06/control'){
   allowed(input,['id','action','confirm','expectedStrategy']);if(input.expectedStrategy&&input.expectedStrategy!==C.ID)throw Error('引擎不一致');
   if(input.action==='start'){const r=d.h06.report(a);if(r.book.riskLock||st.riskLock||st.pendingOrder||st.placingOrder)throw Error('H06 风控或未知订单阻断，不能启动');d.running(a.id,true);st.running=true;return send(200,{ok:true,mode:a.h06Mode,allowLive:false});}
   if(input.action==='pause'){d.running(a.id,false);st.running=false;return send(200,{ok:true,message:'仅暂停新增仓位，已有仓位继续止损及信号退出'});}
   if(input.action==='close'){if(input.confirm!==true)throw Error('手动退出需要明确确认');d.running(a.id,false);st.running=false;await d.h06.tick(a,st,{manualClose:true});return send(200,{ok:true,message:'安全退出已提交，待模拟报价成交确认'});}
  }
  throw Error('H06 操作不允许');
 }catch(e){return send(400,{ok:false,error:e.message});}finally{if(st&&ownsMutation)st.terminalMutating=false;if(lock)d.unlock(lock);}
}
module.exports={handle,terminal,overview};
