"use strict";
// Observations only. This module cannot grant entry or change a stop/target.
function observe(p, price, net) {
 if (!p.audit) return;
 const a=p.audit, roi=100*net/p.marginUsed, stage=a.stages.at(-1);
 a.maximumRoiPct=Math.max(a.maximumRoiPct,roi);
 a.minimumNetPnl=Math.min(a.minimumNetPnl,net);
 if(roi>=p.config.takeProfitRoiPct) a.targetObserved=true;
 if(stage){stage.maxRoiPct=Math.max(stage.maxRoiPct,roi);stage.maximumFloatingNetLoss=Math.max(stage.maximumFloatingNetLoss,-net,0);stage.minimumGrossFloatingPnl=Math.min(stage.minimumGrossFloatingPnl,(price-p.averagePrice)*p.qty*(p.side==='long'?1:-1));stage.lastNetPnl=net;}
}
function entry(p, price, time, net, stopRisk) {
 if(!p.audit) p.audit={version:1,startedAt:time,completeFromEntry:p.entries.length===1,maximumRoiPct:-Infinity,minimumNetPnl:0,targetObserved:false,partialOrderIds:[],stages:[]};
 const stages=p.audit.stages, prior=stages.at(-1);
 if(prior) prior.endedAt=time;
 stages.push({layer:p.entries.at(-1).layer,startedAt:time,qty:p.qty,averagePrice:p.averagePrice,marginUsed:p.marginUsed,entryFees:p.entryFees,exitFees:p.exitFees,fundingPnl:p.fundingPnl,stopPrice:p.stopPrice,stopRiskAmount:stopRisk,incrementalStopRisk:stopRisk-(prior?.stopRiskAmount||0),maximumFloatingNetLoss:0,minimumGrossFloatingPnl:0,maxRoiPct:-Infinity,lastNetPnl:net});
 observe(p,price,net);
}
function finalize(p) {
 if(!p.audit)return;
 const sign=p.side==='long'?1:-1, total=p.entries.reduce((s,e)=>s+e.qty,0);
 p.audit.layerAttribution=p.entries.map(e=>{
  const fraction=e.qty/total, gross=p.exits.reduce((s,x)=>s+(x.price-e.price)*x.qty*fraction*sign,0), exitFee=p.exits.reduce((s,x)=>s+x.fee*fraction,0);
  const funding=p.fundingEvents.reduce((s,f)=>{const eligible=p.entries.filter(v=>v.time<f.time),q=eligible.reduce((n,v)=>n+v.qty,0);return s+(e.time<f.time&&q>0?f.amount*e.qty/q:0);},0);
  return{layer:e.layer,qty:e.qty,entryPrice:e.price,margin:e.margin,entryFee:e.fee,exitFee,grossPnl:gross,fundingPnl:funding,netPnl:gross-e.fee-exitFee+funding};
 });
 const net=p.realizedGross-p.entryFees-p.exitFees+p.fundingPnl;
 p.audit.attributionDelta=p.audit.layerAttribution.reduce((s,v)=>s+v.netPnl,0)-net;
}
module.exports={observe,entry,finalize};
