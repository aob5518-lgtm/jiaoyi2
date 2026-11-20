"use strict";

const fs=require("node:fs"), path=require("node:path");
const C=require("./config"), B=require("./book"), M=require("./market");

function create({directory,now=Date.now,provider=M.create(undefined,now),leverageRules}) {
 const filename=path.join(directory,"funding_carry_paper.json");
 const market=new Map(), errors=new Map(), busy=new Set();
 let books={}, failed=false;
 if (fs.existsSync(filename)) {
  try {
   const saved=JSON.parse(fs.readFileSync(filename,"utf8"));
   if (saved.schema!==1||!saved.books||Array.isArray(saved.books)) throw Error();
   for (const b of Object.values(saved.books)) {
    if (b.schema!==1||typeof b.identity!=="string"||typeof b.running!=="boolean"||
        !Array.isArray(b.trades)||![b.balance,b.realized,b.nextEntryAt].every(Number.isFinite)||
        b.trades.some(t=>!Number.isFinite(t.netPnl))||
        Math.abs(b.trades.reduce((v,t)=>v+t.netPnl,0)-b.realized)>1e-5) throw Error();
    const p=b.position;
    if (!p) continue;
    C.normalize(p.config);
    if (!(p.qty>0&&p.spot?.price>0&&p.openedAt>0&&Number.isFinite(p.funding)&&p.lastActionAt>=p.openedAt)||
        (p.perp&&!(p.perp.price>0&&p.hedgedAt>=p.openedAt&&p.fundingDue>p.hedgedAt&&p.interval>=M.HOUR))||
        (p.exit&&!(p.exit.sell?.price>0&&p.exit.closedAt>=p.openedAt&&(!p.perp||p.exit.cover?.price>0)))) throw Error();
   }
   books=saved.books;
  } catch { failed=true; }
 }
 function get(a) {
  const identity=C.identity(a);
  if (failed) throw Error("LEDGER_REVIEW：对冲账本损坏，已停止写入");
  const b=Object.hasOwn(books,a.id)?books[a.id]:null;
  if (b&&(b.identity!==identity||Math.abs(b.balance-a.simulationBalance-b.realized)>1e-5)) throw Error("LEDGER_REVIEW：对冲账户身份或权益不一致");
  return b;
 }
 function commit(a,book) {
  get(a);
  if (book.identity!==C.identity(a)) throw Error("账本身份不一致");
  const next={...books,[a.id]:book}, temp=filename+".tmp", fd=fs.openSync(temp,"w",0o600);
  try {fs.writeFileSync(fd,JSON.stringify({schema:1,books:next}));fs.fsyncSync(fd);}
  finally {fs.closeSync(fd);}
  fs.renameSync(temp,filename);
  books=next;
 }
 async function refresh(a) {
  const book=get(a), config=book?.position?.config||C.normalize(a[C.configKey]);
  try {
   const [raw,leverageSpec]=await Promise.all([provider.load(a),config.leverage>1&&leverageRules?leverageRules(a):undefined]);
   const data={...raw,leverageSpec};
   M.validate(data,a,now());
   market.set(a.id,data);
   errors.delete(a.id);
   return data;
  } catch(e) {
   market.delete(a.id);
   errors.set(a.id,e.message);
   throw e;
  }
 }
 function guard(st) {
  return st?.riskLock?"账户风险锁定":st?.pendingOrder||st?.placingOrder?"存在外部待确认订单":null;
 }
 function publish(st,b) {
  st.running=b.running;
  st.positionQty=b.position&&!b.position.exit?b.position.qty:0;
  st.lastAction=b.decision?.reason||"对冲模拟已暂停";
 }
 async function tick(a,st,{manual=false}={}) {
  const first=get(a);
  if (!first||(!first.running&&!first.position&&!manual)) return;
  if (busy.has(a.id)) throw Error("账户操作繁忙");
  busy.add(a.id);
  try {
   const data=await refresh(a), b=get(a);
   const next=B.advance(b,data,C.normalize(a[C.configKey]),{blocker:guard(st),manual});
   commit(a,next);publish(st,next);
   st.activeError="";
  } catch(e) {st.activeError=st.lastError=e.message;st.lastErrorAt=now();throw e;}
  finally {busy.delete(a.id);}
 }
 function marketStatus(a) {
  const data=market.get(a.id);
  if (!data) return {data:null,reason:errors.get(a.id)||"等待 Binance 原生双边盘口"};
  try {M.validate(data,a,now());return {data,reason:null};}
  catch(e) {return {data:null,reason:e.message};}
 }
 function preflight(a,st={}) {
  const b=get(a), m=marketStatus(a);
  const blockers=[guard(st),m.reason,!b||b.balance<=0?"模拟权益不足":null,b?.position?.exit?"资金费对账尚未完成":null].filter(Boolean);
  return {allowed:!blockers.length,blockers,configHash:C.hash(a[C.configKey]),checkedAt:m.data?.time??null,mode:"Paper",realOrderPermission:false};
 }
 function configure(a,c,hash) {
  const b=get(a);
  if (!b||C.hash(a[C.configKey])!==hash) throw Error("CONFIG_CONFLICT：保存版本已变更，请刷新后重试");
  C.normalize(c);
  return {nextCycleOnly:!!b.position,activeConfig:b.position?.config||null};
 }
 function control(a,st,action) {
  const b=structuredClone(get(a));
  if (!b) throw Error("模拟账本不存在");
  if (action==="start") {
   if (b.running) return;
   const check=preflight(a,st);
   if (!check.allowed) throw Error(check.blockers.join("；"));
   b.running=true;
   b.decision={code:"MONITORING",reason:"已启动，下一次同步时检查资金费与双腿成本"};
  } else if (action==="pause") {
   b.running=false;
   if (!b.position) b.decision={code:"MONITOR_STOPPED",reason:"已暂停新开仓"};
  } else throw Error("操作不支持");
  commit(a,b);
  publish(st,b);
 }
 function view(a,st={}) {
  const b=get(a), config=C.normalize(a[C.configKey]), m=marketStatus(a), p=b?.position, data=m.data;
  const gain=p&&data?B.mark(p,data):null;
  const balance=b?.balance??a.simulationBalance, floating=p?gain?.netPnl??null:0;
  const plan=data?B.quotePlan(data,config,balance):null;
  const spot=data?(data.spot.bids[0][0]+data.spot.asks[0][0])/2:null;
  const perp=data?(data.perp.bids[0][0]+data.perp.asks[0][0])/2:null;
  const decision=m.reason&&b?.running?{code:"MARKET_UNAVAILABLE",reason:m.reason}:
   b?.decision||{code:"MONITOR_STOPPED",reason:"保存参数后即可启动模拟"};
  return {id:a.id,name:a.name,symbol:a.symbol,config,configHash:C.hash(config),activeConfig:p?C.normalize(p.config):null,
   strategyType:C.ID,revision:C.REVISION,allowLive:false,realOrderPermission:false,running:!!b?.running,riskLock:!!guard(st),
   market:{state:data?"fresh":"unavailable",quoteTime:data?.time??null},fresh:!!data,decision,preflight:preflight(a,st),
   price:spot,carry:{spot,perp,basisBps:spot?(perp/spot-1)*1e4:null,rate:data?.rate??null,nextFundingAt:data?.nextFundingAt??null,
    expected:plan?.expected??null,cost:plan?.cost??null,edge:plan?.edge??null,
    phase:p?.exit?"reconciling":p?.perp?"hedged":p?"spot_only":"flat"},
   position:p,pending:p?.exit?{kind:"close",status:"资金费待核对"}:null,balance,floating,
   equity:floating===null?null:balance+floating,realized:b?.realized??0,history:b?.trades.slice(-50).reverse()||[]};
 }
 return {get,commit,initial:B.initial,refresh,tick,configure,control,preflight,view,busy:id=>busy.has(id)};
}
module.exports={create};
