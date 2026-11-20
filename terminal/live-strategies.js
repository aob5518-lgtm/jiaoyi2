"use strict";
const Classic=require("./classic-paper");
const Book=require("../strategy/turtle_4h/book");
const configurations=[
  ["classic","经典补仓",Classic,null],
  ["turtle_4h_v1","海龟趋势 4H",require("../strategy/turtle_4h/config"),require("../strategy/turtle_4h/signal")],
  ["reversal_4h_v1","找底摸顶 4H",require("../strategy/reversal_4h/config"),require("../strategy/reversal_4h/signal")],
  ["pullback_15m_v1","短线顺势回踩",require("../strategy/pullback_15m/config"),require("../strategy/pullback_15m/signal")],
  ["chart_swing_1h_v1","图示波段 1H",require("../strategy/chart_swing_1h/config"),require("../strategy/chart_swing_1h/signal")]
];
const profiles=new Map(configurations.map(([id,label,config,signal])=>[id,{id,label,config,signal}]));
const labels={side:"交易方向",direction:"允许方向",leverage:"杠杆倍数",baseAmount:"首仓名义金额",
  addAmount:"每次补仓名义金额",maxAdds:"最多补仓次数",addTrigger:"补仓价格间隔",takeProfit:"保证金止盈目标",
  entryBars:"入场通道根数",exitBars:"退出通道根数",atrPeriod:"ATR 周期",stopAtr:"止损 ATR 倍数",
  riskPerTrade:"每笔计划风险",bandBars:"布林带周期",bandWidth:"布林带宽度",maxAdx:"最高 ADX",
  minNetR:"最低净收益风险比",maxHoldBars:"最长持仓根数",lookback:"结构观察周期",
  pullbackAtr:"回踩 ATR 幅度",confirmBars:"收盘确认根数",channelBars:"通道周期",trailAtr:"移动保护 ATR 倍数",
  breakoutBars:"突破观察周期",setupBars:"回踩结构有效根数"};
const percentages=new Set(["addTrigger","takeProfit","riskPerTrade"]);
function profile(id) {
  const p=profiles.get(id);
  if(!p)throw Error("此策略尚无实盘执行器");
  return p;
}
function normalize(id,input) {
  const p=profile(id);
  return id==="classic"?Classic.normalize(input,Infinity):p.config.normalize(input);
}
function catalog() {
  return configurations.map(([id,label,C])=>({id,label,defaults:C.defaults,
    fields:Object.keys(C.defaults).map(key=>({key,label:labels[key]||key,percent:percentages.has(key),
      options:key==="side"?["long","short"]:key==="direction"?["both","long","short"]:null}))}));
}
async function analyze(account,book,snapshot,exchange,now) {
  const p=profile(book.strategy||"classic");
  if(!p.signal)return null;
  const interval=p.config.interval||"4h",bar=p.config.BAR;
  const rows=await exchange.candles(account,interval,bar);
  const analysis=p.signal.analyze(rows,book.position?.config||book.settings,now);
  return {analysis,rows};
}
function decide(account,book,snapshot,research,time,manual,permit=()=>({allowed:true})) {
  const p=profile(book.strategy),C=p.config,position=book.position,c=position?.config||book.settings;
  const quote={bid:snapshot.bid,ask:snapshot.ask,bidQty:snapshot.bidSize*snapshot.spec.unit,
    askQty:snapshot.askSize*snapshot.spec.unit,time:snapshot.at};
  const cost={entryFeeRate:snapshot.feeRate,exitFeeRate:snapshot.feeRate,estimatedEntrySlippage:0,estimatedExitSlippage:0};
  const active=position?{...position,entryFee:Number.isFinite(position.fee)?position.fee:0,cost,funding:0,fundingThrough:time,
    config:position.config,configHash:position.configHash,signalAt:position.signalAt,mae:0,mfe:0}:null;
  const shell={schema:1,balance:snapshot.balance,realized:0,running:book.running,riskLock:false,
    position:active,pending:null,orders:[],trades:[],lastSignalAt:book.lastSignalAt||0,lastQuoteTime:0,
    lastSetupAt:book.lastSetupAt||0,day:book.day||null};
  const data={quote,executionCost:cost,candles:research.rows,funding:[],fundingFrom:0,rules:{
    step:snapshot.spec.step*snapshot.spec.unit,minQty:(snapshot.spec.minQty||snapshot.spec.step)*snapshot.spec.unit,
    maxQty:Math.max(snapshot.limits.long||0,snapshot.limits.short||0)*snapshot.spec.unit,
    minNotional:snapshot.spec.minNotional||0}};
  const result=Book.advance(shell,{time,data,analysis:research.analysis,marketOK:
    !["WARMUP","CANDLE_GAP","CANDLE_STALE"].includes(research.analysis.code),account,manual,permit},c,C);
  return {intent:result.pending,position:result.position,lastSignalAt:result.lastSignalAt,lastSetupAt:result.lastSetupAt,
    day:result.day,decision:result.decision};
}
module.exports={profile,normalize,catalog,analyze,decide};
