"use strict";
const {scopeFor,matches}=require("./scope");
const STAGES=["data","direction","environment","candidate","trigger","cost","risk","execution","entered"];
const GUARDS=/SYSTEM_ERROR|RISK_LOCK|POST_FILL|UNKNOWN_ORDER|PENDING_ORDER|ACCOUNT_CONFLICT|OPEN_ORDER_BLOCK|PLATFORM_UNSUPPORTED|MONITOR_STOPPED|STRATEGY_VERSION_MISMATCH|PORTFOLIO_RISK_BLOCK|WAIT_LIVE_CONFIRM|REENTRY_COOLDOWN|WEEKEND/;
const numeric=value=>value===null||value===undefined||!Number.isFinite(Number(value))?null:Number(value);

function buildDecision({account,config,state,execution={},now=Date.now(),previous}){
 const s=state.signal||{},e=state.executionEvaluation||{},ind=state.indicators||{},item=(state.signalJournal||[]).findLast(x=>x.time===s.signalTime);
 const guard=GUARDS.test(execution.state||""),pending=!!state.pendingOrder,filled=!!item?.orderFilled;
 const direction=s.directionRaw||"none",candidates=(s.entryCandidates||[]).filter(c=>c.enabled);
 let finalDecision=pending?"ORDER_PENDING":state.position||filled?"ENTERED":guard?"BLOCKED":s.entryPermission==="allowed"?(e.execution==="PASS"?["READY","READY_TO_OPEN"].includes(execution.state)?"READY":"BLOCKED":"BLOCKED"):String(s.entryPermission).startsWith("wait_")||direction!=="none"&&s.setupState!=="BLOCKED"?"WAIT":"NO_SIGNAL";
 if((s.hardBlockers||[]).length&&!guard&&!pending&&!state.position&&!filled)finalDecision="BLOCKED";
 const reasons=[...(guard?[execution.reason]:[]),...(e.blocker&&s.entryPermission==="allowed"?[e.blocker]:[]),...(s.blockers||[])].filter(Boolean);
 if(finalDecision==="READY"||finalDecision==="ENTERED")reasons.length=0;
 const primaryBlocker=reasons[0]||(finalDecision==="WAIT"?"等待已收盘入场确认":finalDecision==="NO_SIGNAL"?"尚无可交易方向":finalDecision==="ORDER_PENDING"?"订单尚未确认":finalDecision==="BLOCKED"?execution.reason||"执行检查未通过":null);
 const candidateId=[account.id,account.symbol,scopeFor(config).configHash,s.signalTime||0].join(":");
 const stages={data:state.marketData?.status==="healthy"||state.marketData?.status==="degraded",direction:direction!=="none",environment:!(s.hardBlockers||[]).length&&e.environment!=="BLOCK",candidate:candidates.some(c=>c.score>0),trigger:candidates.some(c=>c.triggered)&&s.entryPermission==="allowed",cost:e.cost==="PASS"||e.cost==="CONDITIONAL",risk:e.risk==="PASS",execution:!guard&&(e.execution==="PASS"||!!item?.orderSubmitted),entered:filled};
 if(filled||item?.orderSubmitted)for(const k of STAGES.slice(0,8))stages[k]=true;
 const firstBlockedAt=previous?.candidateId===candidateId?{...previous.firstBlockedAt}:{};
 let reachable=true;for(const k of STAGES){if(reachable&&!stages[k]){firstBlockedAt[k]??=now;reachable=false;}}
 return{candidateId,timestamp:s.signalTime||now,evaluatedAt:now,accountId:account.id,symbol:account.symbol,...scopeFor(config),dataStatus:state.marketData?.status||"waiting",trendDirection:direction,trendScore:numeric(s.trendScore),setupType:s.entryMode||null,setupScore:numeric(s.entryQualityScore),grade:s.grade||null,chopValue:numeric(ind.chop),adxValue:numeric(ind.adx),higherTimeframeStatus:ind.higherDirection||"none",entryTriggerStatus:s.entryPermission||"blocked",potentialR:numeric(state.preview?.potentialR),estimatedCostR:numeric(state.preview?.costR??s.costR),riskStatus:e.risk||"WAITING",portfolioRiskStatus:state.portfolioRisk?.allowed===false?"BLOCK":"PASS",executionStatus:execution.state||"NO_SIGNAL",finalDecision,primaryBlocker,secondaryBlockers:[...new Set(reasons.slice(1))].filter(x=>x!==primaryBlocker),nextAction:finalDecision==="READY"?"等待 Paper 提交":finalDecision==="ENTERED"?"管理已有仓位":primaryBlocker,stages,firstBlockedAt};
}
function recordDecision(state,decision){
 state.decisionJournal||=[];
 const index=state.decisionJournal.findIndex(x=>x.candidateId===decision.candidateId);
 if(index<0)state.decisionJournal.push(decision);else state.decisionJournal[index]=decision;
 state.unifiedDecision=decision;
 const cutoff=Date.now()-14*86400000;state.decisionJournal=state.decisionJournal.filter(x=>x.timestamp>=cutoff);
}
function decisionStats(rows,scope,hours,now=Date.now()){
 const unique=new Map((rows||[]).filter(x=>matches(x,scope)&&x.timestamp>=now-hours*3600000&&x.timestamp<=now).map(x=>[x.candidateId,x]));
 let eligible=[...unique.values()];
 return{hours,total:eligible.length,from:eligible.length?Math.min(...eligible.map(x=>x.timestamp)):null,to:eligible.length?Math.max(...eligible.map(x=>x.timestamp)):null,stages:STAGES.map(stage=>{const input=eligible,passed=input.filter(x=>x.stages[stage]),blocked=input.filter(x=>!x.stages[stage]),reasons={};for(const r of blocked){const why=r.primaryBlocker||"等待";reasons[why]=(reasons[why]||0)+1;}eligible=passed;return{stage,candidates:input.length,passed:passed.length,blocked:blocked.length,blockRatio:input.length?blocked.length/input.length:null,primaryBlocker:Object.entries(reasons).sort((a,b)=>b[1]-a[1])[0]?.[0]||null,firstBlockedAt:blocked.length?Math.min(...blocked.map(x=>x.firstBlockedAt[stage]||x.timestamp)):null};})};
}
module.exports={buildDecision,recordDecision,decisionStats,STAGES};
