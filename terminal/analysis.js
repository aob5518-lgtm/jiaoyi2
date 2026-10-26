"use strict";
const V3=require("../trend_only_v3"),S=require("../strategy/short_term_v1/engine"),A=require("../strategy/short_term_v1/analytics"),HM=require("../public/history-model");
function scopeFor(current,q){const scope={...current};for(const [key,param]of [["experimentId","experiment"],["strategyRevision","revision"],["configHash","hash"]])if(q[param]){if(q[param]==="all")throw Error("分析必须使用单一实验/修订/配置；跨范围记录请在交易记录查看且不混算");scope[key]=q[param];}return scope;}
const matches=(v,s)=>["strategyVersion","strategyRevision","experimentId","configHash"].every(k=>!s[k]||v[k]===s[k]);
function build(a,x,q,d){const hours=x.compound?(q.hours==="all"||q.hours==="0"?0:Math.min(720,Math.max(24,Number(q.hours)||72))):Math.min(168,Math.max(24,Number(q.hours)||72)),from=hours?Date.now()-hours*3600000:0;let data;
 if(q.view==="short_term_v1"){
  if(!x.short)throw Error("Short-Term当前仅作为V3的Shadow伴随引擎");const b=(q.hash?x.t.shortTermBooks?.[q.hash]:x.short.book)||{},scope=scopeFor(S.scopeFor(x.short.config,a),q),sampleOK=!q.sample||q.sample==="shadow",rows=(b.journal||[]).filter(v=>sampleOK&&v.exitTime>=from&&matches(v,scope)),signals=(b.signals||[]).filter(v=>sampleOK&&v.timestamp>=from&&matches(v,scope));
  data={mode:"Shadow",scope,statistics:A.metrics(rows,signals),setups:Object.fromEntries(S.SETUPS.map(k=>[k,{...A.metrics(rows.filter(v=>v.entryMode===k),signals.map(s=>({...s,candidates:(s.candidates||[]).filter(c=>c.type===k)}))),candidates:signals.filter(s=>(s.candidates||[]).some(c=>c.type===k)).length,triggered:signals.filter(s=>(s.candidates||[]).some(c=>c.type===k&&c.triggered)).length}])),signals:signals.slice(-50)};
 }else if(x.compound){
  data=require("../strategy/compound_4h/professional").build(a,x,q,d,from);
 }else if(x.type==="trend_only_v3"){
  const scope=scopeFor(V3.scopeFor(V3.normalizeConfig(a.trendOnlyConfig)),q),sampleOK=!q.sample||q.sample==="paper",rows=(x.st.profitHistory||[]).filter(v=>sampleOK&&HM.time(v.exitTime||v.time)>=from),signals=(x.t.signalJournal||[]).filter(v=>sampleOK&&v.time>=from);data={...require("../strategy/trend_v3/analytics").buildStrategyAnalytics(rows,scope,signals),scope,decisions24h:require("../strategy/trend_v3/decision").decisionStats(sampleOK?x.t.decisionJournal:[],scope,24),decisions72h:hours>=72?require("../strategy/trend_v3/decision").decisionStats(sampleOK?x.t.decisionJournal:[],scope,72):null,signalJournal:signals.filter(v=>matches(v,scope)).slice(-50),lastDecision:x.t.unifiedDecision&&matches(x.t.unifiedDecision,scope)&&x.t.unifiedDecision.timestamp>=from?x.t.unifiedDecision:null,marketData:x.t.marketData};
 }else data={legacy:true,note:"旧历史保留原策略归属，不并入V3或Shadow统计"};return{hours,data};
}
module.exports={build,scopeFor,matches};
