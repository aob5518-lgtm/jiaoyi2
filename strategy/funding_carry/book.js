"use strict";

const {randomUUID} = require("node:crypto");
const C=require("./config");
const {HOUR}=require("./market");
const SLIPPAGE=.0005, SPOT_FEE=.001, PERP_FEE=.0005; // Paper assumptions, per execution.
const SETTLEMENT_TOLERANCE=60000, HEDGE_TIMEOUT=45000;
const round = n => Math.round(n*1e8)/1e8;
const mid = book => (book.bids[0][0]+book.asks[0][0])/2;
const depth = (book,buy) => (buy?book.asks:book.bids).reduce((total,[,qty])=>total+qty,0);
function gcd(a,b) { while(b) [a,b]=[b,a%b]; return a; }
function commonStep(steps) {
 const units=steps.map(step=>Math.round(step*1e8));
 if (units.some((unit,i)=>unit<1||Math.abs(unit/1e8-steps[i])>1e-12)) throw Error("不可核对的共同数量精度");
 return units.reduce((a,b)=>a/gcd(a,b)*b,1)/1e8;
}
function fill(book,buy,qty,feeRate,participation) {
 let remaining=qty, notional=0;
 for (const [price,size] of buy?book.asks:book.bids) {
  const part=Math.min(remaining,size*participation);
  notional+=part*price;
  remaining-=part;
  if (remaining<=1e-10) break;
 }
 if (remaining>1e-10) return null;
 const ref=mid(book), price=notional/qty*(1+(buy?1:-1)*SLIPPAGE);
 return {price,ref,fee:price*qty*feeRate,slippage:(buy?price-ref:ref-price)*qty};
}
function estimate(data,config) {
 const recent=data.funding.filter(row=>row.time<=data.time).slice(-6);
 if (recent.length<6 || data.rate<=0) return null;
 const last=recent.at(-1).time;
 const interval=Math.round((recent.at(-1).time-recent.at(-2).time)/HOUR)*HOUR;
 if (!(interval>=HOUR&&interval<=24*HOUR) ||
     recent.slice(1).some((row,i)=>Math.abs(row.time-recent[i].time-interval)>SETTLEMENT_TOLERANCE) ||
     Math.abs(data.nextFundingAt-last-interval)>SETTLEMENT_TOLERANCE) return null;
 const rate=Math.min(data.rate,recent.reduce((sum,row)=>sum+row.rate,0)/recent.length)*.5;
 const window=config.maxHoldHours*HOUR-(data.nextFundingAt-data.time);
 const events=window>=0?Math.min(1+Math.floor(window/interval),9):0;
 return {interval,rate,events};
}
function compliant(qty,price,rules) {
 return qty>=rules.minQty&&qty<=rules.maxQty&&qty*price>=rules.minNotional&&qty*price<=rules.maxNotional&&
  rules.steps.every(step=>Math.abs(qty/step-Math.round(qty/step))<1e-6);
}
function quotePlan(data,config,balance,lockedSpot) {
 const forecast=estimate(data,config);
 if (data.rate<=0) return {code:"RATE_BLOCK",reason:"当前预估资金费率非正"};
 if (!forecast) return {code:"FUNDING_BLOCK",reason:"近期结算记录或资金费周期无法核对"};
 if (data.nextFundingAt-data.time<60000) return {code:"FUNDING_BLOCK",reason:"临近资金费结算，等待下一个完整周期"};
 const spotRef=mid(data.spot),perpRef=mid(data.perp);
 if (Math.abs(perpRef/spotRef-1)>.005) return {code:"BASIS_BLOCK",reason:"现货与永续基差超过 50 个基点"};
 const step=commonStep([...data.spotRules.steps,...data.perpRules.steps]);
 const max=Math.min(balance*config.allocationPct/(Math.max(data.spot.asks[0][0],data.perp.bids[0][0])*(1+SLIPPAGE)),
  depth(data.spot,true)*.1,depth(data.perp,false)*.1,depth(data.spot,false)*.1,depth(data.perp,true)*.1,
  data.spotRules.maxQty,data.perpRules.maxQty);
 const qty=lockedSpot?.qty??round(Math.floor(max/step+1e-9)*step);
 if (!(qty>0) || qty>max+1e-9) return {code:"SIZE_BLOCK",reason:"两边可撮合数量不足"};
 const spot=lockedSpot?.spot??fill(data.spot,true,qty,SPOT_FEE,.1);
 const perp=fill(data.perp,false,qty,PERP_FEE,.1);
 const sell=fill(data.spot,false,qty,SPOT_FEE,.1),cover=fill(data.perp,true,qty,PERP_FEE,.1);
 if (!spot||!perp||!sell||!cover||!compliant(qty,spot.price,data.spotRules)||!compliant(qty,perp.price,data.perpRules)) {
  return {code:"SIZE_BLOCK",reason:"盘口深度或交易规格不足"};
 }
 const notional=Math.max(spot.price,perp.price)*qty;
 if (notional>balance*config.allocationPct+1e-8 || (spot.price+perp.price)*qty+spot.fee+perp.fee>balance*.65) {
  return {code:"SIZE_BLOCK",reason:"两腿所需本金与保证金超过预算"};
 }
 const cost=(spot.price-sell.price+cover.price-perp.price)*qty+spot.fee+perp.fee+sell.fee+cover.fee;
 const expected=forecast.rate*forecast.events*qty*data.markPrice;
 const edge=expected-cost;
 const metrics={expected,cost,edge,basisBps:(perpRef/spotRef-1)*1e4};
 if (!(edge>=notional*config.minEdgeBps/1e4)) return {code:"COST_BLOCK",reason:"保守预计资金费不足以覆盖双腿往返成本与基差余量",...metrics};
 return {code:"ENTRY_READY",reason:"两边盘口与净收益空间通过",qty,spot,perp,forecast,...metrics};
}
function initial(a) {
 return {schema:1,identity:C.identity(a),balance:a.simulationBalance,realized:0,running:false,position:null,trades:[],nextEntryAt:0};
}
function decision(b,code,reason,time) {
 b.decision={code,reason,time};
}
function funding(p,data,cutoff) {
 if (!p.perp) return true;
 while (p.fundingDue<=cutoff) {
  const row=data.funding.find(row=>row.time>p.lastFundingAt&&row.time>p.hedgedAt&&
    row.time<=data.time&&Math.abs(row.time-p.fundingDue)<=SETTLEMENT_TOLERANCE);
  if (!row) return false;
  if (row.time<=cutoff) p.funding+=p.qty*row.mark*row.rate;
  p.lastFundingAt=row.time;
  p.fundingDue+=p.interval;
 }
 return true;
}
function pnl(p,sell,cover) {
 const unhedgedPnl=((p.spotAtHedge??sell.ref)-p.spot.ref)*p.qty;
 const basisPnl=p.perp?((sell.ref-p.spotAtHedge)+(p.perp.ref-cover.ref))*p.qty:0;
 const tradingFee=p.spot.fee+sell.fee+(p.perp?.fee??0)+(cover?.fee??0);
 const slippageAmount=p.spot.slippage+sell.slippage+(p.perp?.slippage??0)+(cover?.slippage??0);
 const grossPnl=unhedgedPnl+basisPnl-slippageAmount;
 return {unhedgedPnl,basisPnl,tradingFee,slippageAmount,grossPnl,fundingPnl:p.funding,
  netPnl:grossPnl-tradingFee+p.funding};
}
function finish(b,p,time) {
 const {sell,cover,reason,closedAt}=p.exit;
 const result=pnl(p,sell,cover);
 b.trades.push({id:p.id,time:closedAt,entryTime:p.openedAt,side:p.perp?"hedged":"spot_only",qty:p.qty,
  spotEntry:p.spot.price,spotExit:sell.price,perpEntry:p.perp?.price??null,perpExit:cover?.price??null,
  ...result,reason,strategyRevision:C.REVISION,configHash:C.hash(p.config),sampleType:"paper_forward"});
 b.balance=round(b.balance+result.netPnl);
 b.realized=round(b.realized+result.netPnl);
 b.nextEntryAt=time+HOUR;
 b.position=null;
 if (b.balance<=0) b.running=false;
 decision(b,"SETTLED","本轮已平仓并结算",time);
}
function mark(p,data) {
 if (p.exit) return pnl(p,p.exit.sell,p.exit.cover);
 const sell=fill(data.spot,false,p.qty,SPOT_FEE,1);
 const cover=p.perp?fill(data.perp,true,p.qty,PERP_FEE,1):null;
 if (!sell||p.perp&&!cover) return null;
 return pnl(p,sell,cover);
}
function advance(before,data,config,{blocker,manual=false}={}) {
 const b=structuredClone(before), time=data.time, p=b.position;
 if (p?.exit) {
  if (funding(p,data,p.exit.closedAt)) finish(b,p,time);
  else decision(b,"RECONCILING","两腿已退出，等待原生资金费补齐后结算",time);
  return b;
 }
 if (p && time<=p.lastActionAt) return b;
 if (p && !p.perp) {
  const hedge=b.running&&!p.abort&&!manual&&!blocker&&time-p.openedAt<HEDGE_TIMEOUT?
   quotePlan(data,p.config,b.balance,p):null;
  // A future leg requires a newer futures snapshot; REST spot has only a local receipt time.
  if (hedge?.code==="ENTRY_READY"&&data.perpTime>p.firstPerpTime) {
   Object.assign(p,{perp:hedge.perp,hedgedAt:time,spotAtHedge:mid(data.spot),fundingDue:data.nextFundingAt,
    interval:hedge.forecast.interval,lastFundingAt:0,lastActionAt:time});
   decision(b,"HEDGED","已模拟做空等币量永续，两腿对冲成立",time);
   return b;
  }
  if (hedge?.code==="ENTRY_READY"&&time-p.openedAt<HEDGE_TIMEOUT) return b;
  const sell=fill(data.spot,false,p.qty,SPOT_FEE,1);
  if (!sell) {
   p.abort=true;
   decision(b,"UNHEDGED","永续腿未成交，现货退出盘口深度不足，等待原生盘口",time);
   return b;
  }
  p.exit={sell,cover:null,closedAt:time,reason:"hedge_failed"};
  finish(b,p,time);
  return b;
 }
 if (p) {
  const settled=funding(p,data,time);
  const value=mark(p,data);
  const perpNotional=p.qty*data.markPrice;
  const collateral=b.balance-p.qty*p.spot.price-p.spot.fee-p.perp.fee+p.funding+p.qty*(p.perp.price-data.markPrice);
  const reason=p.closeReason||(manual?"manual_close":blocker?"risk_exit":
   collateral<.20*perpNotional||value?.netPnl<=-.005*b.balance?"risk_exit":
   !settled&&time-p.fundingDue>90000?"funding_gap":data.rate<=0?"rate_reversed":
   time-p.hedgedAt>=p.config.maxHoldHours*HOUR?"time_stop":null);
  if (!reason) {
   decision(b,"HEDGED",settled?"等量对冲持有，按原生结算记录入账":"等量对冲持有，等待本次原生资金费确认",time);
   return b;
  }
  p.closeReason=reason;
  const sell=fill(data.spot,false,p.qty,SPOT_FEE,1),cover=fill(data.perp,true,p.qty,PERP_FEE,1);
  if (!sell||!cover) {
   decision(b,"EXIT_WAIT","退出需要两边足量盘口，仍保留配对仓位",time);
   return b;
  }
  p.exit={sell,cover,closedAt:time,reason};
  if (settled) finish(b,p,time);
  else decision(b,"RECONCILING","两腿已退出，等待资金费核对",time);
  return b;
 }
 if (!b.running||manual) return b;
 if (blocker||b.balance<=0) {decision(b,"RISK_BLOCK",blocker||"权益不足",time);return b;}
 if (time<b.nextEntryAt) {decision(b,"COOLDOWN","上一轮已结束，等待冷却",time);return b;}
 const plan=quotePlan(data,config,b.balance);
 if (plan.code!=="ENTRY_READY") {decision(b,plan.code,plan.reason,time);return b;}
 b.position={id:randomUUID(),qty:plan.qty,openedAt:time,firstPerpTime:data.perpTime,lastActionAt:time,config:{...config},
  spot:plan.spot,perp:null,funding:0};
 decision(b,"UNHEDGED","现货腿已模拟成交，等下一笔永续盘口完成对冲",time);
 return b;
}
module.exports={initial,advance,quotePlan,mark};
