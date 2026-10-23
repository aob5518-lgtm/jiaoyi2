"use strict";
const crypto=require("crypto");
const LEGACY=new Set(["classic","smart_regime_v1","trend_only_v1","trend_only_v2"]);
const finite=v=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(Number(v));
// Historical FILLED records are executions, not working orders. Never discard unknown evidence.
function ledgerReview(items=[]){
 const quantities={},rounding={},issues=[];let filled=0,terminal=0;
 if(!Array.isArray(items))return{unknown:true,unsettled:true,quantities,issues:[{code:"LEDGER_INVALID",reason:"模拟订单账本不是数组"}],recordCount:null,archivedRecordCount:0};
 if(items.length>=1000)issues.push({code:"LEDGER_TRUNCATED",reason:"记录达到旧版1000条保留上限，无法证明截断前的仓位已结算"});
 const ids=new Set();
 for(const [index,o]of items.entries()){
  if(!o||typeof o!=="object"){issues.push({code:"ORDER_INVALID",index,reason:"订单记录格式无效"});continue;}
  if(o.id){if(ids.has(o.id)){issues.push({code:"DUPLICATE_ORDER",index,reason:"重复订单ID，不能重复计入成交"});continue;}ids.add(o.id);}
  const status=String(o.status||"").toUpperCase();
  if(["CANCELLED","CANCELED","EXPIRED","REJECTED"].includes(status)){
   if(Number(o.executedQty||o.filledQty||0)!==0)issues.push({code:"PARTIAL_TERMINAL_ORDER",index,reason:"终态委托有部分成交，需核对独立成交明细"});else terminal++;continue;
  }
  if(status!=="FILLED"){issues.push({code:"ORDER_UNCONFIRMED",index,status:status||"MISSING",reason:"非已成交终态或缺失状态，不能证明订单已结算"});continue;}
  const side=String(o.orderSide||"").toLowerCase();
  if(!finite(o.size)||Number(o.size)<=0||!["buy","sell"].includes(side)||!o.symbol||!["long","short"].includes(o.positionSide)){
   issues.push({code:"FILL_FIELDS_MISSING",index,reason:"成交缺少有效size/orderSide/symbol/positionSide，不能推断仓位"});continue;
  }
  const key=[o.symbol,o.positionSide].join(":")+(o.platform||o.quoteAsset?"@"+(o.platform||"unknown")+"/"+(o.quoteAsset||"unknown"):""),n=Number(o.size);
  quantities[key]=(quantities[key]||0)+n*(side==="buy"?1:-1);
  // Old add/close quantities were rounded to 8 decimal places in server.js.
  rounding[key]=(rounding[key]||0)+5e-9;filled++;
 }
 const residuals=Object.entries(quantities).filter(([k,n])=>Math.abs(n)>(rounding[k]||0)+Number.EPSILON*Math.max(1,Math.abs(n))*items.length);
 const unknown=issues.length>0;
 return{unknown,unsettled:unknown||residuals.length>0,quantities,residuals:Object.fromEntries(residuals),roundingTolerance:rounding,issues,recordCount:items.length,filledRecordCount:filled,archivedRecordCount:!unknown&&!residuals.length?filled+terminal:0,archiveMode:"logical_only_original_records_preserved"};
}
function diagnose(a,st={},runtime={},orders=[],options={}){
 const checks=[],paper=a.tradeMode==="simulation"&&a.simulationEnabled===true,now=Date.now();
 const check=(field,value,blocked,reason,advice)=>checks.push({field,value:value===undefined?null:value,status:blocked?"BLOCK":"PASS",reason:blocked?reason:"核对通过",advice:blocked?advice:"无需处理"});
 check("strategyType",a.strategyType||"classic",!LEGACY.has(a.strategyType||"classic"),"不是可迁移的旧策略","请使用当前策略的账户管理入口");
 for(const field of ["running","tickRunning","placingOrder","pendingOrder","smartExitPending"]){const value=st[field];check(field,typeof value==="object"?!!value:value,field==="tickRunning"&&options.ownsTick?false:!!value,field+" 尚未结束","暂停新交易并等待执行完成；未知订单需核对成交回执，不能清空状态");}
 for(const field of ["positionQty","realPositionSize"]){const v=st[field],displayOnly=field==="realPositionSize"&&(v==="-"||v===undefined);check(field,v,(!displayOnly&&!finite(v))||(finite(v)&&Math.abs(Number(v))>0),field+" 非零或无法确认","核对实际持仓；本地为零不代表账本或交易所已空仓");}
 for(const field of ["position","pendingOrder"])check("trendRuntime."+field,!!runtime[field],!!runtime[field],"趋势运行时仍存在"+field,"保留恢复与安全退出流程，等待确认结束");
 check("shadowBooks",Object.values(runtime.shortTermBooks||{}).filter(b=>b.position||b.pendingOrder).length,Object.values(runtime.shortTermBooks||{}).some(b=>b.position||b.pendingOrder),"伴随账本仍有仓位或订单","完成伴随账本结算后再迁移");
 for(const field of ["smartExitSignalCount","smartExitSignalTime"])check(field,st[field]||0,!!st[field],field+" 仍有退出确认状态","只读核对退出流程及历史回执，不自动删除确认状态");
 for(const [field,value,blocked]of [["activeError",st.activeError,!!st.activeError],["riskLock",st.riskLock||runtime.riskLock,!!st.riskLock||!!runtime.riskLock],["smartRiskOff",st.smartRiskOff,!!st.smartRiskOff],["pauseUntil",runtime.pauseUntil,Number(runtime.pauseUntil)>now],["smartPauseUntil",st.smartPauseUntil,Number(st.smartPauseUntil)>now],["smartLossLockedUntil",st.smartLossLockedUntil,Number(st.smartLossLockedUntil)>now]])check(field,value,blocked,field+" 当前生效","按原风控流程核对并解除；迁移不能绕过风险锁或冷却");
 checks.push({field:"historicalRisk",status:"INFO",value:{lastError:st.lastError||null,lastErrorAt:st.lastErrorAt||null,riskLockReason:runtime.riskLockReason||st.riskLockReason||null,consecutiveLosses:runtime.consecutiveLosses??st.smartConsecutiveLosses??null,dailyLoss:runtime.dailyLoss??null},reason:"历史风险仅供审计；不自动清除，也不把已恢复错误当成当前风险锁",advice:"保留原始风险记录"});
 const ledger=paper?ledgerReview(orders):null;
 check("legacyLedgerBlocked",st.legacyLedgerBlocked??null,false,"","");checks.at(-1).status="INFO";checks.at(-1).reason="旧缓存标记仅供对照，迁移使用本次原始账本重新核验";
 if(paper){
  if(options.directory){let source=false;try{const fs=require("fs"),path=require("path"),data=JSON.parse(fs.readFileSync(path.join(options.directory,"simulation_orders.json"),"utf8"));source=!!data&&typeof data==="object"&&!Array.isArray(data)&&Array.isArray(data[a.id]);}catch{/* Missing/corrupt storage is not proof of an empty account. */}
   check("simulationLedgerSource",source,!source,"模拟订单源文件缺失、损坏或缺少此账户账本，不能用空数组代替证明","从备份及原始回执补齐可验证账本；不得清空或伪造记录");}
  check("simulationLedger",ledger.recordCount,ledger.unsettled,ledger.issues.map(v=>v.reason).concat(Object.entries(ledger.residuals||{}).map(([k,n])=>k+" 历史成交净数量="+n)).join("；"),"导出核验报告，关联开平仓成交ID与时间；截断/缺失记录须补齐原始证据，不能强制解除");
  const balance=["classic","smart_regime_v1"].includes(a.strategyType||"classic")?st.simBalance:runtime.simBalance;
  check("paperEquity",balance,!finite(balance)||Number(balance)<0,"Paper权益缺失或无效","人工核对模拟资金权益，禁止重置为初始资金");
  const history=st.profitHistory||[],known=history.every(h=>finite(h.netPnl)),net=history.reduce((n,h)=>n+(finite(h.netPnl)?Number(h.netPnl):0),0);
  // Classic balances were not persisted across restart. A nonempty history must reconcile,
  // not silently migrate a freshly initialized initial balance and erase past profit/loss.
  if(["classic","smart_regime_v1"].includes(a.strategyType||"classic")&&history.length)check("paperEquityReconciliation",{balance,initial:a.simulationBalance,historyNetPnl:known?net:null,records:history.length},!known||history.length>=10000||!finite(a.simulationBalance)||!finite(balance)||Math.abs(Number(balance)-Number(a.simulationBalance)-net)>.001+history.length*.00005,"历史净收益与Paper权益无法完整勾稽","保留原资金与历史，人工补齐费用/净收益及资金变更凭证；不能以初始资金覆盖");
 }else{
  check("nativeExchangeVerification",options.native||"NOT_VERIFIED",options.native?.verified!==true,"尚未只读核验交易所全部原生持仓及挂单","使用只读交易所核验；本地缓存不能证明Live空仓");
  check("livePermissionPreserved",a.tradeMode,true,"旧Live账户不在自动迁移范围，保持原实盘权限","完成原生仓位及挂单核验后走人工审计；另建独立Paper账户，不自动转换Live账户");
 }
 const blockers=checks.filter(c=>c.status==="BLOCK");
 const evidenceHash=crypto.createHash("sha256").update(JSON.stringify({accountId:a.id,strategyType:a.strategyType,checks,orders})).digest("hex");
 return{accountId:a.id,at:now,paper,migrationEligible:!blockers.length,checks,blockers,ledger,evidenceHash,manualReview:{required:!!blockers.length,procedure:"保存本报告及证据哈希；逐项关联原始成交/撤单/资金凭证，由管理员复核；仅在原始状态可证明结算后重新核验。不提供强制解锁。"}};
}
module.exports={ledgerReview,diagnose};
