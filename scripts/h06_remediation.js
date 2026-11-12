"use strict";
const fs=require('fs'),crypto=require('crypto'),zlib=require('zlib'),path=require('path'),{run}=require('./h06_replay'),Review=require('../strategy/macd_scale_in/review');
function roiAudit(r){
 const completed=r.rows, all=[...completed,...(r.activeCycle?[r.activeCycle]:[])],target=r.config.takeProfitRoiPct;
 const opposite=completed.filter(v=>['opposite_profit','opposite_max_adds','reverse_after_partial'].includes(v.closeReason)),early=opposite.filter(v=>v.audit.maximumRoiPct<target);
 return{target,nearDefinition:'maximum observed net ROI >= 80% of target',maximumRoiPct:Math.max(...all.map(v=>v.audit.maximumRoiPct)),nearTargetCycles:all.filter(v=>v.audit.maximumRoiPct>=target*.8).length,nearTargetCompleted:completed.filter(v=>v.audit.maximumRoiPct>=target*.8).length,targetObservedCycles:all.filter(v=>v.audit.targetObserved).length,partialFlagCycles:completed.filter(v=>v.partialTpDone).length,partialExitCycles:completed.filter(v=>v.exits.some(e=>e.reason==='roi_partial')).length,...r.orderAudit,oppositeExitCycles:opposite.length,oppositeEarlyCycles:early.length,oppositeEarlyFraction:completed.length?early.length/completed.length:null,exitReasons:Object.fromEntries([...new Set(completed.map(v=>v.closeReason))].map(k=>[k,completed.filter(v=>v.closeReason===k).length]))};
}
function stages(rows){const totalLoss=rows.reduce((n,r)=>n+r.audit.layerAttribution.reduce((s,a)=>s+Math.max(0,-a.netPnl),0),0);return[0,1,2,3].map(layer=>{const pairs=rows.flatMap(r=>r.audit.stages.filter(s=>s.layer===layer).map(s=>({r,s,a:r.audit.layerAttribution.find(v=>v.layer===layer)}))),sum=f=>pairs.reduce((n,v)=>n+f(v),0),avg=f=>pairs.length?sum(f)/pairs.length:null;return{layer,cycles:pairs.length,averagePositionCost:avg(v=>v.s.averagePrice),averageMargin:avg(v=>v.s.marginUsed),averageEntryFees:avg(v=>v.s.entryFees),maximumFloatingNetLoss:pairs.length?Math.max(...pairs.map(v=>v.s.maximumFloatingNetLoss)):null,averageMaximumFloatingNetLoss:avg(v=>v.s.maximumFloatingNetLoss),minimumGrossFloatingPnl:pairs.length?Math.min(...pairs.map(v=>v.s.minimumGrossFloatingPnl)):null,finalCycleNetPnlSum:sum(v=>v.r.netPnl),attributedLayerNetPnlSum:sum(v=>v.a?.netPnl||0),attributedLayerGrossLoss:sum(v=>Math.max(0,-(v.a?.netPnl||0))),shareOfAttributedGrossLoss:totalLoss?sum(v=>Math.max(0,-(v.a?.netPnl||0)))/totalLoss:null,averageStopRisk:avg(v=>v.s.stopRiskAmount),averageIncrementalStopRisk:avg(v=>v.s.incrementalStopRisk)};});}
function publish(report,out){
 const evidence=report.results.map(r=>({experimentId:r.experimentId,symbol:r.symbol,period:r.period,candidate:r.candidate,cycleEvidence:r.cycleEvidence})),packed=zlib.gzipSync(JSON.stringify(evidence)),evidenceFile='cycle-evidence.json.gz';
 fs.writeFileSync(path.join(path.dirname(out),evidenceFile),packed);
 fs.writeFileSync(out,JSON.stringify({...report,cycleEvidenceFile:evidenceFile,cycleEvidenceSha256:crypto.createHash('sha256').update(packed).digest('hex'),results:report.results.map(({cycleEvidence,...r})=>({...r,researchScopeHash:crypto.createHash('sha256').update(JSON.stringify({config:r.config,policy:r.researchPolicy,engineHashes:report.engineHashes})).digest('hex')}))},null,2));
}
function execute(){
 const baseline=require('../docs/h06/optimization/results.json'),out='docs/h06/remediation/results.json',results=[],hashes=Object.fromEntries(['config.js','signal.js','book.js','audit.js','higher.js'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync('strategy/macd_scale_in/'+f,'utf8').replace(/\r\n/g,'\n')).digest('hex')]));
 const candidates=[{id:'D',config:{maxAdds:3}},{id:'I',config:{maxAdds:3,higherTimeframeFilter:true}},{id:'J',config:{maxAdds:1,higherTimeframeFilter:true}},...[1,3,5].flatMap(leverage=>[20,100].filter(target=>leverage!==1||target!==100).map(target=>({id:'L'+leverage+'T'+target,config:{leverage,takeProfitRoiPct:target}}))),{id:'N0',config:{maxAdds:0}},{id:'N1',config:{maxAdds:1}},{id:'G50',config:{},policy:{maxAddRiskFraction:.5}},{id:'HARD_ONLY',config:{},policy:{hardExitOnly:true}}];
 const save=()=>publish({baseline:'9c6d356a59fe61e6e76f06de491ca5b2a740ec14',classification:'REUSED_HISTORICAL_RESEARCH_NOT_INDEPENDENT_OOS',defaultChanged:false,engineHashes:hashes,candidates,results},out);
 for(const symbol of ['ETHUSDT','BTCUSDT']){const old=JSON.parse(fs.readFileSync('.audit/h06-data/'+symbol+'.json')),fresh=JSON.parse(fs.readFileSync('.audit/h06-holdout-2026/'+symbol+'.json')),data={...old,candles:[...old.candles,...fresh.candles],funding:[...old.funding,...fresh.funding]};
  for(const[period,from,to]of[['development_seen','2024-01-01','2026-01-01'],['reused_2026_prefix','2026-01-01','2026-06-29']])for(const c of candidates){
   const r=run(data,c.config,{from:Date.parse(from),to:Date.parse(to),experimentId:'H06_R3_'+symbol+'_'+period+'_'+c.id,researchPolicy:c.policy}),{rows,curve,...metrics}=r;
   if(rows.some(v=>Math.abs(v.audit.attributionDelta)>1e-6))throw Error('layer attribution mismatch');
   const prior=baseline.results.find(v=>v.symbol===symbol&&v.candidate===c.id&&v.period===(period==='development_seen'?period:'unseen_prefix'));
   const parity=prior?{priorCycles:prior.cycles,cyclesEqual:r.cycles===prior.cycles,netPnlDelta:r.netPnl-prior.netPnl}:null;
   if(parity&&(!parity.cyclesEqual||Math.abs(parity.netPnlDelta)>1e-6))throw Error('baseline parity failed '+symbol+period+c.id);
   results.push({symbol,period,candidate:c.id,...metrics,markedNetPnl:r.netPnl+(r.activeCycle?.netPnl||0),baselineParity:parity,roiAudit:roiAudit(r),stages:stages(rows),review:Review.build(rows),cycleEvidence:rows.map(v=>({cycleId:v.cycleId,netPnl:v.netPnl,closeReason:v.closeReason,partialTpDone:v.partialTpDone,audit:v.audit}))});
   save();console.log(symbol,period,c.id,r.cycles,r.netPnl.toFixed(2),'maxROI',results.at(-1).roiAudit.maximumRoiPct.toFixed(2));
  }
 }
}
if(require.main===module)execute();module.exports={roiAudit,stages,publish};
