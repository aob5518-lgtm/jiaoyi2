"use strict";
const C=require("./config"),R=require("./review"),E=require("./experiments"),M=require("../short_term_v1/analytics");
function build(a,x,q,d,from){
 const b=d.compound.get(a),scope=require("../../terminal/analysis").scopeFor(C.scope(a.compoundConfig,a),q),same=v=>["strategyVersion","strategyRevision","experimentId","configHash"].every(k=>v[k]===scope[k]),sampleOK=!q.sample||q.sample==="paper",history=b.history.filter(v=>sampleOK&&same(v)),diagnostics=b.diagnostics.filter(v=>sampleOK&&same(v)),rows=history.filter(v=>v.filledQty>0&&v.exitTime>=from),groups={};
 for(const row of rows){const key=[row.entryMode,row.config?.exitVariant,row.adds,row.prediction?.dailyTrend].join(" / ");(groups[key]||=[]).push(row);}
 const funnelCycles=[...history,...(b.cycle&&sampleOK&&same(b.cycle)?[b.cycle]:[])];
 const now=Date.now(),windows=Object.fromEntries([24,72,168,720,0].map(h=>[h||"all",R.summarize(diagnostics,funnelCycles,h?now-h*3600000:0,now)]));
 return{compoundProfessional:true,mode:"Paper",scope,health:{...x.compound.health,running:!!x.st.running},riskBreakdown:x.compound.riskBreakdown,statistics:{...M.metrics(rows),actualPaperTrades:rows.length,shadowTrades:0,diagnosticFunnel:R.summarize(diagnostics,funnelCycles,from,now)},funnelWindows:windows,coverage:x.compound.coverage,postHoc:(b.postHocReview||[]).filter(v=>sampleOK&&same(v)&&v.windowStart>=from).slice(-100),candidateDiagnostics:diagnostics.filter(v=>(v.evaluatedAt??v.timestamp)>=from).slice(-50),cycles:history.filter(v=>v.exitTime>=from).slice(-50),activeCycle:b.cycle,byRegimeAndMode:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,M.metrics(v)])),equityCurve:rows.map(v=>({time:v.exitTime,equity:v.equityAfter})),researchCatalog:E.REGISTRY.map(v=>({...v,sampleType:"historical_backtest",autoEnabled:false})),scopeNote:"仅当前账户、精确revision/experiment/configHash和Paper前向样本。独立离线研究不并入本账本收益；未运行时段未知。"};
}
module.exports={build};
