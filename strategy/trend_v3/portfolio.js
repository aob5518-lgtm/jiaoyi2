"use strict";
const crypto=require("crypto");
function portfolioRiskKey(a){const identity=a.trendOnlyConfig?.portfolioRiskKey||a.vault||a.address||a.wallet||a.apiKey||`account:${a.id}`,canonical=identity===a.address||identity===a.wallet?String(identity).toLowerCase():String(identity);return crypto.createHash("sha256").update(`${a.platform}:${a.paper?"paper":"live"}:${canonical}`).digest("hex").slice(0,24);}
function snapshot(target,entries,side,newRisk=0){
 const key=portfolioRiskKey(target),group=entries.filter(e=>portfolioRiskKey(e.account)===key),equities=group.map(e=>Number(e.equity)).filter(v=>v>0);
 const equity=equities.length?Math.min(...equities):0;let open=0,pending=0,same=0,count=0,unknown=false;
 for(const e of group){const p=e.state.position,o=e.state.pendingOrder;const r=p?Number(p.initialEffectiveRiskU??p.actualRiskAmount??p.riskAmount)*Math.min(1,Number(p.positionSize)/Number(p.filledQty||p.positionSize)):0;
  const q=o&&o.kind==="open"?Number(o.plan?.initialEffectiveRiskU??o.plan?.riskAmount):0;
  if(p&&!(r>0)||o?.kind==="open"&&!(q>0)||(p||o?.kind==="open")&&!(Number(e.equity)>0))unknown=true;
  open+=Number.isFinite(r)?r:0;pending+=Number.isFinite(q)?q:0;
  if(p?.side===side){count++;same+=Number.isFinite(r)?r:0;}
  if(o?.kind==="open"&&o.side===side)same+=Number.isFinite(q)?q:0;
 }
 const limit=Number(target.trendOnlyConfig?.maxPortfolioRiskPct??.025),pct=equity>0?(open+pending+newRisk)/equity:null;
 return{portfolioRiskKey:key,openEffectiveRiskU:open,pendingEffectiveRiskU:pending,proposedEffectiveRiskU:newRisk,portfolioEffectiveRiskPct:pct,maxPortfolioRiskPct:limit,equityBasis:equity,equityPolicy:"minimum_observed_shared_equity_not_sum",sameDirectionOpenCount:count,sameDirectionRiskPct:equity>0?same/equity:null,allowed:!unknown&&pct!==null&&pct<=limit,unknownRisk:unknown,reason:unknown?"组合待确认风险金额未知":pct===null?"组合权益不足":pct>limit?"组合有效风险超过上限":""};
}
module.exports={portfolioRiskKey,snapshot};
