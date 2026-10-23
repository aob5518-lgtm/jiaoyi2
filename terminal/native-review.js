"use strict";
// Only explicit native arrays can prove flat. Check ALL markets, not the selected symbol.
function verifyFlat(platform,positions,orders){
 const fail=message=>{const error=Error(message);error.nativeReviewReason=message;throw error;};
 if(!Array.isArray(positions)||!Array.isArray(orders))fail("交易所返回缺失原生持仓/委托数组");
 for(const row of positions){const p=row?.position||row,qty=p?.[platform==="hyperliquid"?"szi":platform==="binance"?"positionAmt":"size"];
  if(qty===null||qty===undefined||qty===""||!Number.isFinite(Number(qty)))fail("原生持仓数量未知，不能证明空仓");
  if(Math.abs(Number(qty))>0)fail("交易所存在非零原生持仓（包括其他交易对）");
 }
 if(orders.length)fail("交易所存在原生委托或未知委托状态");
 return{verified:true,positionCount:positions.length,openOrders:0};
}
module.exports={verifyFlat};
