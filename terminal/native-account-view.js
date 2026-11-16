"use strict";
const n=v=>!["number","string"].includes(typeof v)||typeof v==="string"&&!v.trim()||!Number.isFinite(Number(v))?null:Number(v);
const completeNumbers=values=>values.every(v=>n(v)!==null);
const positive=v=>n(v)>0?n(v):null;
function summarize(account,result){
 if(result.nativeEvidenceValid===false)throw Error("原生账户数据不完整");
 if(!Array.isArray(result.positions))throw Error("原生持仓数组缺失");
 const positions=[];
 for(const row of result.positions){
  const p=row.position||row,qty=n(p.positionAmt??p.szi??p.size);
  if(qty===null)throw Error("原生持仓数量未知");
  if(qty===0)continue;
  const raw=p.coin||p.symbol||p.market||"",symbol=String(raw).toUpperCase().replace(/(?:USDT|USDC|-USD)$/,"");
  if(!raw)throw Error("原生合约字段未知");
  const side=p.positionSide==="SHORT"||["SHORT","SELL"].includes(String(p.side).toUpperCase())||qty<0?"short":"long";
  const market=String(raw).toUpperCase(),quoteAsset=market.endsWith("USDT")?"USDT":market.endsWith("USDC")?"USDC":market.endsWith("-USD")?"USD":account.quoteAsset||null;
  positions.push({symbol,market,quoteAsset,side,qty:Math.abs(qty),entry:positive(p.entryPrice??p.entryPx??p.openPrice??p.averagePrice),
   leverage:positive(typeof p.leverage==="object"?p.leverage?.value:p.leverage),leverageSource:"native_exchange",
   unrealizedPnl:n(p.unrealizedProfit??p.unrealizedPnl??p.unrealisedPnl),
   margin:n(p.marginUsed??p.positionInitialMargin??p.margin),mark:n(p.markPrice)});
 }
 return {balance:n(result.balance??result.totalWalletBalance),available:n(result.available),positionCount:positions.length,positions,
  checkedAt:Date.now(),source:"native_exchange",pnlBasis:"unrealized_before_exit_cost"};
}
module.exports={summarize,completeNumbers};
