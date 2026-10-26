"use strict";
const crypto=require("crypto");
const MATCHING=Object.freeze(["NO_EVIDENCE","CROSS_PARTIAL","DELAYED_STRESS"]);
function marketReview(account,sets,quote,reference,now=Date.now()){
 const expected={binance:"futures",hyperliquid:"hyperliquid",extended:"extended"}[account.platform],sources=sets.map(v=>v.source||"unknown"),policy=account.compoundExecutionPolicy||{},maxBasisBps=Number(policy.maxBasisBps??25),reasons=[];
 if(!Number.isFinite(maxBasisBps)||maxBasisBps<=0||maxBasisBps>100)reasons.push("基差安全上限无效");
 if(!(quote?.price>0)||!quote.timestamp||now-quote.timestamp>60000||quote.timestamp>now)reasons.push("目标平台报价缺失或陈旧");
 if(quote?.platform!==account.platform||quote?.symbol!==account.symbol||quote?.marketType!=="perpetual")reasons.push("执行报价来源或合约类型无法确认");
 if(account.quoteAsset&&quote?.quoteAsset!==account.quoteAsset)reasons.push("配置报价币种与实际执行合约不一致，需核对账户而非自动改写");
 if(sets.some(v=>v.stale)||sources.some(v=>v==="unknown"||["spot","market-reference"].includes(v)))reasons.push("关键K线来源未知、现货回退或数据过期");
 if(sets.some(v=>v.baseAsset&&v.baseAsset!==account.symbol||v.marketType&&v.marketType!=="perpetual"))reasons.push("K线合约标的或现货/永续类型不匹配");
 const cross=sources.some(v=>v!==expected);let basisBps=null;
 if(cross){
  if(reference?.price>0&&reference.source===sources[0]&&sources.every(v=>v===reference.source)&&Math.abs(now-reference.timestamp)<=60000)basisBps=Math.abs(quote.price/reference.price-1)*10000;
  else reasons.push("跨平台信号缺少同时点参考报价，无法核验基差");
  if(policy.allowReferenceSignals!==true)reasons.push("参考平台K线仅作研究，默认禁止创建目标平台执行计划");
  if(basisBps!==null&&basisBps>maxBasisBps)reasons.push("跨平台价格基差超过安全上限");
 }
 return{allowed:!reasons.length,code:reasons.length?"MARKET_BENCHMARK_BLOCK":"MARKET_VERIFIED",reasons,sources,executionQuote:quote,basisBps,maxBasisBps,crossVenue:cross,quality:cross?"CROSS_VENUE_REFERENCE":"NATIVE_PERPETUAL"};
}
function matching(p,o,event,previous){
 const s=p.side==="long"?1:-1,model=p.research?.matching||"CROSS_PARTIAL",time=Number(event.time),price=Number(event.price),lo=Number(event.low??price),hi=Number(event.high??price),submitted=o.submittedAt??p.createdAt;
 const base={allowed:false,model,precision:"ASSUMPTION_NOT_ORDERBOOK",status:"WAITING",liquidity:o.placementType||"UNKNOWN"};
 if(model==="NO_EVIDENCE"&&event.tradeEvidence!==true)return{...base,status:"NO_FILL_EVIDENCE"};
 if(time<=submitted||event.openTime!==undefined&&event.openTime<submitted)return{...base,status:"PRE_SUBMISSION_BAR"};
 if(model==="DELAYED_STRESS"&&time-submitted<3600000)return{...base,status:"DELAYED"};
 const crossed=event.low!==undefined?(s>0?lo<o.price-p.rules.priceTick*.1:hi>o.price+p.rules.priceTick*.1):Number.isFinite(previous)&&(s>0?previous>=o.price&&price<o.price-p.rules.priceTick*.1:previous<=o.price&&price>o.price+p.rules.priceTick*.1);
 if(!crossed)return{...base,status:(s>0?lo<=o.price:hi>=o.price)?"TOUCHED_NOT_FILLED":"WAITING"};
 const key=event.evidenceId|| (event.openTime!==undefined?"bar:"+event.openTime:"cross:"+time+":"+previous+":"+price);
 if((o.consumedEvidence||[]).includes(key))return{...base,status:"EVIDENCE_ALREADY_USED"};
 const gapThrough=Number.isFinite(event.open)&&Number.isFinite(previous)&&s*(previous-o.price)>=0&&s*(event.open-o.price)<0;
 return{...base,allowed:true,key,status:"CROSS_PARTIAL",pathKind:gapThrough?"GAP_THROUGH":event.low!==undefined?"OHLC_PRICE_CROSS":"SAMPLED_CROSS_GAP_UNKNOWN",gapThrough,fraction:model==="DELAYED_STRESS"?Math.min(.25,p.config.fillFraction):p.config.fillFraction};
}
function researchScope(config,account,research){const data={entry:research.entry||"BASELINE",exit:research.exit||"FULL_PLAN_R",matching:research.matching||"CROSS_PARTIAL",costModel:research.costModel||"TIME_WEIGHTED_ESTIMATE"};return{strategyRevision:"COMPOUND_4H_RESEARCH_20261026_"+Object.values(data).join("_"),experimentId:Object.values(data).join("_"),configHash:crypto.createHash("sha256").update(JSON.stringify({config,account:{platform:account.platform,symbol:account.symbol},research:data})).digest("hex"),research:data};}
module.exports={MATCHING,marketReview,matching,researchScope};
