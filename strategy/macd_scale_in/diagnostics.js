"use strict";
const ACTIVE=new Set(['SUBMITTED','PARTIALLY_FILLED','UNKNOWN']);
function fact(o){return{id:o.id,kind:o.kind,status:o.status,qty:o.qty,signalId:o.signalId||o.triggerSignalId||null,submittedAt:o.submittedAt,lastFillTime:o.lastFillTime||null,terminalAt:o.terminalAt||null,filledQty:o.filledQty||0,fills:structuredClone(o.fills||[])};}
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
function stats(rows,from=0,to=Infinity,{orders:sourceOrders=[],currentOrders=null}={}){
 const observations=rows.filter(r=>r.time>=from&&r.time<=to),orders=new Map();
 for(const row of rows)for(const o of row.orderFacts||[])orders.set(o.id,o);
 // Durable orders survive a crash before the corresponding signal row is saved.
 for(const order of sourceOrders)orders.set(order.id,fact(order));
 const result={evaluations:observations.length,strategyOpportunities:new Set(observations.filter(v=>v.signalPermission==='allowed'&&v.signalId).map(v=>v.signalId)).size,submittedEntries:0,filledEntries:0,submittedExits:0,filledExits:0,rejectedOrders:0,pendingOrders:0,activeOrdersNow:0,newOrdersInWindow:0,ordersWithFillInWindow:0,ordersWithPartialFillInWindow:0,ordersCompletedInWindow:0,fillEventsInWindow:0,partialTpFilledOrders:0,legacyFillOrders:0,byKind:{}};
 const within=t=>Number.isFinite(t)&&t>=from&&t<=to;
 for(const o of orders.values()){
  const submitted=within(o.submittedAt),fills=[...new Map((o.fills||[]).map(f=>[f.id,f])).values()].filter(f=>within(f.time)),legacy=!(o.fills||[]).length&&o.filledQty>0&&within(o.lastFillTime),filled=fills.length>0||legacy,active=ACTIVE.has(o.status);
  const complete=o.status==='FILLED'&&within(o.terminalAt||o.lastFillTime),partial=fills.some(f=>f.cumulativeQty<o.qty-1e-10),entry=['open','add'].includes(o.kind);
  if(active)result.activeOrdersNow++;
  if(!submitted&&!filled&&!complete&&!active)continue;
  const type=result.byKind[o.kind]||={submitted:0,filled:0,partial:0,completed:0,rejected:0,active:0};
  if(submitted){type.submitted++;result.newOrdersInWindow++;result[entry?'submittedEntries':'submittedExits']++;}
  if(filled){type.filled++;result.ordersWithFillInWindow++;result[entry?'filledEntries':'filledExits']++;if(o.kind==='partial')result.partialTpFilledOrders++;}
  if(partial){type.partial++;result.ordersWithPartialFillInWindow++;}
  if(complete){type.completed++;result.ordersCompletedInWindow++;}
  if(legacy)result.legacyFillOrders++;
  result.fillEventsInWindow+=fills.length;
  if(o.status==='REJECTED'&&submitted){result.rejectedOrders++;type.rejected++;}
  if(active)type.active++;
 }
 result.activeOrdersInScope=result.activeOrdersNow;
 if(currentOrders)result.activeOrdersNow=new Set(currentOrders.filter(o=>ACTIVE.has(o.status)).map(o=>o.id)).size;
 result.activeOrderScope=currentOrders?'current_account':'selected_scope';
 result.pendingOrders=result.activeOrdersNow;
 result.coverage={first:observations[0]?.time||null,last:observations.at(-1)?.time||null,complete:false,note:'活动委托为当前快照；其他按窗口内事件。部分和完成可属于同一委托，不可相加；旧记录不推断成交事件。'};
 return result;
}
module.exports={update,stats,finalDecision,fact};
