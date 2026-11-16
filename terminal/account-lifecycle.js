"use strict";
const {createHash}=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const {ledgerReview}=require("./legacy-review");
const paper=a=>a.tradeMode==="simulation"&&a.simulationEnabled===true;
const version=a=>createHash("sha256").update(JSON.stringify([a.id,a.name,a.platform,a.symbol,a.quoteAsset,a.strategyType,a.tradeMode,a.simulationEnabled,a.archivedAt||null])).digest("hex");
async function review(a,d){
 const blockers=[],st=d.state(a.id),block=(key,message)=>blockers.push({key,message});
 if(!st)block("state","账户运行状态无法读取");
 if(a.running)block("account.running","账户配置仍标记运行中");
 for(const k of ["running","tickRunning","placingOrder","pendingOrder","smartExitPending","riskLock","legacyLedgerBlocked","smartRiskOff"])
  if(st?.[k])block(k,({running:"请先暂停策略",tickRunning:"本轮正在更新，请稍后重试",placingOrder:"正在提交订单",pendingOrder:"订单尚未确认",
   smartExitPending:"退出流程未完成",riskLock:"风控锁定尚未核对",legacyLedgerBlocked:"历史账本核对未通过",smartRiskOff:"旧风控状态仍锁定"})[k]);
 for(const k of ["positionQty","realPositionSize"]){
  const v=st?.[k];
  // realPositionSize is a legacy formatted display field initialized to "-".
  // It never proves flat: numeric execution fields, books and fresh native proof remain mandatory.
  if(k==="realPositionSize"&&["-","—",""].includes(v))continue;
  if(v!==undefined&&v!==null&&(!Number.isFinite(Number(v))||Math.abs(Number(v))>0))block(k,"仍有持仓或数量未知："+k);
 }
 const classic=d.classicPaper?.get(a.id);
 if(classic?.running)block("classic.running","经典模拟仍在运行");
 if(classic?.position)block("classic.position","请先结清经典模拟持仓");
 if(d.classicPaper?.corrupt())block("classic.ledger","经典模拟账本无法核对");
 if(classic&&d.classicPaper.view?.(a)?.blocked)block("classic.identity","经典账本身份或配置不一致，须先核对");
 let independent=null;
 try{
  const engine=d.independentEngine?.(a);
  if(engine){independent=engine.get(a);if(!independent||engine.failure?.())block("paper.ledger","独立模拟账本缺失或损坏");
   if(engine.busy?.(a.id))block("paper.busy","模拟引擎正在更新");
   for(const k of ["running","position","pending","riskLock"])if(independent?.[k])block("paper."+k,({running:"请先暂停模拟策略",position:"请先结清模拟持仓",pending:"模拟委托尚未终结",riskLock:"模拟账本处于风险锁定"})[k]);
   if(independent?.phase&&independent.phase!=="flat")block("paper.phase","模拟两腿或结算流程尚未完成");
  }
 }catch{block("paper.ledger","独立模拟账本无法读取，保留账户待核对");}
 if(!independent&&!["classic","smart_regime_v1","trend_only_v1","trend_only_v2","trend_only_v3","compound_4h_v1","connection_only"].includes(a.strategyType))block("strategy","未知策略执行状态无法核对");
 const runtime=/^trend_only_v[123]$/.test(a.strategyType||"")?d.trend?.get(a):null;
 for(const k of ["position","pendingOrder","riskLock"])if(runtime?.[k])block("trend."+k,"趋势运行时仍有 "+k);
 if(Object.values(runtime?.shortTermBooks||{}).some(b=>b.position||b.pendingOrder))block("shadow","伴随研究仍有持仓或订单");
 if(a.strategyType==="compound_4h_v1"&&(d.compound?.busy(a)||d.compound?.get(a)?.riskLock))block("compound","4H 轮次或风险核对未完成");
 if(paper(a)&&!classic&&!independent){
  let orders=d.simulationOrders?.(a.id),complete=Array.isArray(orders);
  if(d.directory){
   try{const raw=JSON.parse(fs.readFileSync(path.join(d.directory,"simulation_orders.json"),"utf8"));
    orders=raw[a.id];complete=Array.isArray(orders);
    if(a.strategyType==="connection_only"&&!Object.hasOwn(raw,a.id)){orders=[];complete=true;}
   }catch{complete=false;}
  }
  if(!complete)block("legacy.ledger","原始模拟订单证据缺失，不能证明已结算");
  else {const x=ledgerReview(orders);if(x.unsettled)block("legacy.ledger","历史订单存在未结算、未知状态或数量残差");}
 }
 if(!paper(a)){try{await d.verifyLiveFlat(a);}catch{block("exchange","无法确认交易所全部原生持仓和委托为空，请先核对交易所");}}
 return {allowed:!blockers.length,blockers,version:version(a),preserveHistory:true,readOnly:true};
}
function transition(a,action){
 const copy=structuredClone(a),at=Date.now();
 if(action==="archive")copy.archivedAt=at;else delete copy.archivedAt;
 copy.lifecycleAudit=[...(copy.lifecycleAudit||[]),{at,action,scope:"visibility_only",historyPreserved:true}];
 return copy;
}
module.exports={review,version,transition};
