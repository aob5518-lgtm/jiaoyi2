"use strict";
const ACTIVE=new Set(['SUBMITTED','PARTIALLY_FILLED','UNKNOWN']);
function fact(o){return{id:o.id,kind:o.kind,status:o.status,signalId:o.signalId||o.triggerSignalId||null,submittedAt:o.submittedAt,lastFillTime:o.lastFillTime||null,filledQty:o.filledQty||0};}
function finalDecision(row){const facts=row.orderFacts||[];if(facts.some(o=>o.filledQty>0))return'ORDER_FILLED';if(facts.some(o=>ACTIVE.has(o.status)))return'ORDER_PENDING';if(facts.some(o=>o.status==='REJECTED'))return'ORDER_REJECTED';return row.currentDecision;}
function update(book,record,changed=[]){
 const rows=book.signals||=[],same=row=>row.time===record.time&&row.configHash===record.configHash;let row=rows.find(same);
 if(!row){row={...record,firstEvaluatedAt:record.evaluatedAt,orderFacts:[]};rows.push(row);}
 const previousFacts=row.orderFacts||[],first=row.firstEvaluatedAt||record.evaluatedAt;
 Object.assign(row,record,{firstEvaluatedAt:first,lastEvaluatedAt:record.evaluatedAt,currentDecision:record.executionDecision,orderFacts:previousFacts});
 for(const o of changed){const id=o.signalId||o.triggerSignalId,origin=id?rows.find(v=>v.signalId===id&&(v.configHash===o.meta?.scope?.configHash||!o.meta?.scope?.configHash)):row;if(!origin)continue;
  origin.orderFacts||=[];const index=origin.orderFacts.findIndex(v=>v.id===o.id);if(index>=0)origin.orderFacts[index]=fact(o);else origin.orderFacts.push(fact(o));
  origin.executionDecision=origin.finalDecision=finalDecision(origin);
 }
 row.executionDecision=row.finalDecision=finalDecision(row);book.signals=rows.slice(-5000);return row;
}
function stats(rows,from=0,to=Infinity){const observations=rows.filter(r=>r.time>=from&&r.time<=to),orders=new Map();for(const row of rows)for(const o of row.orderFacts||[])orders.set(o.id,o);
 const result={evaluations:observations.length,strategyOpportunities:new Set(observations.filter(v=>v.signalPermission==='allowed'&&v.signalId).map(v=>v.signalId)).size,submittedEntries:0,filledEntries:0,submittedExits:0,filledExits:0,rejectedOrders:0,pendingOrders:0,byKind:{}};
 for(const o of orders.values()){const submitted=o.submittedAt>=from&&o.submittedAt<=to,filled=o.filledQty>0&&o.lastFillTime>=from&&o.lastFillTime<=to;if(!submitted&&!filled&&!ACTIVE.has(o.status))continue;const entry=['open','add'].includes(o.kind),type=result.byKind[o.kind]||={submitted:0,filled:0,rejected:0};if(submitted){type.submitted++;result[entry?'submittedEntries':'submittedExits']++;}if(filled){type.filled++;result[entry?'filledEntries':'filledExits']++;}if(o.status==='REJECTED'&&submitted){result.rejectedOrders++;type.rejected++;}if(ACTIVE.has(o.status))result.pendingOrders++;}
 result.coverage={first:observations[0]?.time||null,last:observations.at(-1)?.time||null,complete:false,note:'仅统计已留存观察；旧记录缺少orderFacts时不推断成交'};return result;
}
module.exports={update,stats,finalDecision};
