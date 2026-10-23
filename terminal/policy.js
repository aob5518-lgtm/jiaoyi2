"use strict";
const LEGACY=new Set(["classic","smart_regime_v1","trend_only_v1","trend_only_v2"]),CORE=new Set(["trend_only_v3","compound_4h_v1"]);
const catalog=()=>[
 {id:"trend_only_v3",name:"Trend V3",mode:"Paper",independentAccount:true,description:"趋势环境、入场质量、成本与风险控制",revision:require("../strategy/trend_v3/scope").REVISION},
 {id:"short_term_v1",name:"Short-Term V1",mode:"Shadow",independentAccount:false,description:"Shadow研究模式，暂不支持实际Paper下单。随V3监控评估的隔离伴随引擎，不是独立账户。",revision:require("../strategy/short_term_v1/engine").REVISION},
 {id:"compound_4h_v1",name:"4H Compound V1",mode:"Paper",independentAccount:true,description:"4H结构、四层限价、分段止盈与逐轮复利。Paper研究版，收益尚未验证。",revision:require("../strategy/compound_4h/config").REVISION}
];
const type=a=>a.strategyType||"classic";
const restricted=a=>!CORE.has(type(a));
function assertEntry(a,reduceOnly=false){if(!reduceOnly&&restricted(a))throw Error(LEGACY.has(type(a))?"LEGACY_RESTRICTED：旧策略只管理已有仓位，禁止新开与补仓":"UNSUPPORTED_STRATEGY：未知策略禁止新开仓");if(!CORE.has(type(a))&&!LEGACY.has(type(a)))throw Error("UNSUPPORTED_STRATEGY：无法推断未知引擎的订单语义");}
function classify(a,st={},runtime={}){
 const id=type(a),legacy=LEGACY.has(id),unsupported=!legacy&&!CORE.has(id),busy=!!st.legacyLedgerBlocked||!!st.tickRunning||Number(st.positionQty)>0||Number(st.realPositionSize)>0||!!st.pendingOrder||!!st.placingOrder||!!runtime.position||!!runtime.pendingOrder||!!st.smartExitPending||Object.values(runtime.shortTermBooks||{}).some(b=>b.position||b.pendingOrder);
 return{status:unsupported?"UNSUPPORTED_STRATEGY":legacy?"LEGACY_RESTRICTED":"SUPPORTED",entryAllowed:!legacy&&!unsupported,busy,migrationEligible:legacy&&!busy&&!st.running&&a.tradeMode==="simulation"&&a.simulationEnabled===true,reason:unsupported?"策略标识不受支持，已禁止交易；保留数据供核对":legacy?busy?"旧策略仍有持仓、订单或执行流程，仅保留安全管理":"旧策略已退出普通入口；需显式迁移，历史与风险状态不清除":""};
}
function ledgerReview(items=[]){const quantities={};let unknown=items.length>=1000;for(const o of items){if(["CANCELLED","EXPIRED"].includes(o.status))continue;if(o.status!=="FILLED"||!Number.isFinite(Number(o.size))||Number(o.size)<=0||!["buy","sell"].includes(String(o.orderSide).toLowerCase())){unknown=true;continue;}const key=[o.symbol,o.positionSide].join(":");quantities[key]=(quantities[key]||0)+Number(o.size)*(String(o.orderSide).toLowerCase()==="buy"?1:-1);}return{unknown,unsettled:unknown||Object.values(quantities).some(v=>Math.abs(v)>1e-8),quantities};}
module.exports={LEGACY,CORE,catalog,type,restricted,assertEntry,classify,ledgerReview};
