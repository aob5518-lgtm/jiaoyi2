"use strict";
function protection(price,quote,side,atr,entry,c,cost){
 const sign=side==="long"?1:-1,exit=side==="long"?quote.bid:quote.ask;
 const distance=Math.max(c.stopAtr*atr,sign*(price-entry.stop)),stop=price-sign*distance;
 if(!(atr>0&&stop>0&&distance<=3*atr&&sign*(exit-entry.stop)>0&&sign*(exit-stop)>0))throw Error("STRUCTURE_RISK：结构已失效或风险距离超过 3 ATR");
 const stopFill=stop*(1-sign*cost.estimatedExitSlippage);
 const unitRisk=sign*(price-stopFill)+price*cost.entryFeeRate+stopFill*cost.exitFeeRate;
 if(!(unitRisk>0&&Number.isFinite(unitRisk)))throw Error("STRUCTURE_RISK：实际成本风险无法计算");
 return {distance,stop,unitRisk};
}
// Invoked only for this profile, after hard stop/manual handling. Mutates the cloned position.
function managePosition(p,e){
 const a=e.analysis,c=p.config,sign=p.side==="long"?1:-1;
 if(!e.marketOK||!(a.closedAt>Math.max(p.signalAt,p.lastManagedAt||0)))return {};
 p.lastManagedAt=a.closedAt;
 const elapsed=Math.floor((a.closedAt-p.signalAt)/3600000);
 // The entire signal candle predates the actual fill. Never attribute its high/low to the position.
 if(a.barOpenedAt>=p.openedAt){
  p.closedPeak=p.side==="long"?Math.max(p.closedPeak??p.entry,a.high):Math.min(p.closedPeak??p.entry,a.low);
 }
 const peak=p.closedPeak??p.entry,peakMove=sign*(peak-p.entry),initialDistance=Math.abs(p.entry-p.initialStop);
 const costMove=p.entry*(p.cost.entryFeeRate+p.cost.exitFeeRate+p.cost.estimatedExitSlippage);
 if(elapsed>=c.maxHoldBars)return {exitReason:"time_stop"};
 const fade=p.side==="long"?a.histFalling:a.histRising;
 const microBreak=p.side==="long"?a.close<a.previousLow:a.close>a.previousHigh;
 if(elapsed>=2&&fade&&microBreak&&sign*(peak-a.close)>=a.atr&&peakMove>costMove){
  return {exitReason:"swing_momentum_exit"};
 }
 if(peakMove>=2*initialDistance&&a.atr>0){
  return {stop:peak-sign*c.trailAtr*a.atr};
 }
 return {};
}
module.exports={protection,managePosition};
