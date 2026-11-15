"use strict";

const C = require("./config");
const SPOT = "https://data-api.binance.vision";
const PERP = "https://fapi.binance.com";
const HOUR = 3600000;
const MAX_AGE = 12000;

async function request(url) {
 const response = await fetch(url,{signal:AbortSignal.timeout(8000)});
 if (!response.ok) throw Error("Binance 原生行情 HTTP "+response.status+" "+new URL(url).pathname);
 return response.json();
}
function depth(raw) {
 const levels = (values,sign) => {
  if (!Array.isArray(values)||!values.length) throw Error("盘口缺少买卖报价");
  const result = values.map(([p,q])=>[Number(p),Number(q)]);
  if (result.some(([p,q],i)=>!(Number.isFinite(p)&&p>0&&Number.isFinite(q)&&q>0)||
      (i>0&&sign*(p-result[i-1][0])<=0))) throw Error("盘口档位异常");
  return result;
 };
 const bids=levels(raw?.bids,-1), asks=levels(raw?.asks,1);
 if (bids[0][0]>=asks[0][0] || !Number.isSafeInteger(raw.lastUpdateId) || raw.lastUpdateId<=0) throw Error("原生盘口版本或价差无效");
 return {bids,asks,updateId:raw.lastUpdateId};
}
function rules(raw, base, contract) {
 if (raw?.symbol!==base+"USDT" || raw.baseAsset!==base || raw.quoteAsset!=="USDT" ||
     raw.status!=="TRADING" || (contract ? raw.contractType!=="PERPETUAL"||raw.marginAsset!=="USDT":raw.isSpotTradingAllowed!==true)) {
  throw Error("交易规格不匹配或市场暂停");
 }
 const lot=raw.filters.find(f=>f.filterType==="LOT_SIZE");
 const marketLot=raw.filters.find(f=>f.filterType==="MARKET_LOT_SIZE")||{};
 const steps=[Number(lot?.stepSize),Number(marketLot.stepSize)||0].filter(step=>step>0);
 const minQty=Math.max(Number(lot?.minQty),Number(marketLot.minQty)||0);
 const maxQty=Math.min(Number(lot?.maxQty),Number(marketLot.maxQty)||Infinity);
 const minimum=raw.filters.find(f=>f.filterType==="NOTIONAL")||raw.filters.find(f=>f.filterType==="MIN_NOTIONAL");
 const minNotional=Number(minimum?.minNotional??minimum?.notional);
 const maxNotional=Number(minimum?.maxNotional)||Infinity;
 if (!steps.length || !(minQty>0 && maxQty>=minQty && minNotional>0 && maxNotional>=minNotional)) throw Error("缺少可验证的数量或名义金额规则");
 return {steps,minQty,maxQty,minNotional,maxNotional};
}
function validate(data,a,time) {
 if (data?.source!=="binance_spot_usdm" || data.symbol!==a.symbol+"USDT") throw Error("行情来源或标的不匹配");
 if (![data.time,data.spotRequestedAt,data.perpTime,data.markTime].every(t=>Number.isFinite(t)&&t>0&&time-t<=MAX_AGE&&t<=time+2000) ||
     data.time-data.spotRequestedAt>4000 || Math.abs(data.perpTime-data.spotRequestedAt)>5000) {
  throw Error("现货与永续报价过期或不同步");
 }
}
function create(get=request,clock=Date.now) {
 const cache=new Map(), inFlight=new Map();
 let perpInfo, perpInfoAt=0;
 function load(a) {
  C.assertAccount(a);
  const symbol=a.symbol+"USDT";
  if (inFlight.has(symbol)) return inFlight.get(symbol);
  const job=read(a,symbol).finally(()=>inFlight.delete(symbol));
  inFlight.set(symbol,job);
  return job;
 }
 async function read(a,symbol) {
  const prior=cache.get(symbol), start=clock();
  const useSpecs=prior&&start-prior.specTime<3600000;
  const useFunding=prior&&start-prior.fundingTime<30000&&start<prior.nextFundingAt;
  const [spotRaw,perpRaw,mark,spotInfo,futuresInfo,fundingRaw]=await Promise.all([
   get(SPOT+"/api/v3/depth?symbol="+symbol+"&limit=20"),
   get(PERP+"/fapi/v1/depth?symbol="+symbol+"&limit=20"),
   get(PERP+"/fapi/v1/premiumIndex?symbol="+symbol),
   useSpecs?prior.spotInfo:get(SPOT+"/api/v3/exchangeInfo?symbol="+symbol),
   perpInfo&&start-perpInfoAt<3600000?perpInfo:get(PERP+"/fapi/v1/exchangeInfo"),
   useFunding?prior.fundingRaw:get(PERP+"/fapi/v1/fundingRate?symbol="+symbol+"&startTime="+(start-14*24*HOUR)+"&limit=1000")
  ]);
  const time=clock(),rate=Number(mark.lastFundingRate),nextFundingAt=Number(mark.nextFundingTime);
  if (mark.symbol!==symbol || mark.lastFundingRate==="" || !Number.isFinite(rate) || !(Number(mark.markPrice)>0) ||
      !(nextFundingAt>time-120000&&nextFundingAt<=time+24*HOUR)) throw Error("资金费预估或结算时钟无效");
  if (!Array.isArray(fundingRaw) || fundingRaw.length>=1000) throw Error("历史资金费数据不完整");
  const funding=fundingRaw.map(row=>({time:Number(row.fundingTime),rate:Number(row.fundingRate),mark:Number(row.markPrice),symbol:row.symbol})).sort((a,b)=>a.time-b.time);
  if (funding.some((r,i)=>r.symbol!==symbol || !(r.time>0&&r.time<=time+2000&&r.mark>0&&Number.isFinite(r.rate)) ||
      i>0&&r.time-funding[i-1].time<60000)) throw Error("原生资金费历史存在无效或重复事件");
  const data={source:"binance_spot_usdm",symbol,time,spotRequestedAt:start,perpTime:Number(perpRaw.T??perpRaw.E),markTime:Number(mark.time),rate,nextFundingAt,
   markPrice:Number(mark.markPrice),spot:depth(spotRaw),perp:depth(perpRaw),funding,
   spotRules:rules(spotInfo.symbols?.find(row=>row.symbol===symbol),a.symbol,false),
   perpRules:rules(futuresInfo.symbols?.find(row=>row.symbol===symbol),a.symbol,true)};
  validate(data,a,time);
  cache.set(symbol,{spotInfo,specTime:useSpecs?prior.specTime:time,fundingRaw,fundingTime:useFunding?prior.fundingTime:time,nextFundingAt});
  if (futuresInfo!==perpInfo){perpInfo=futuresInfo;perpInfoAt=time;}
  return data;
 }
 return {load};
}
module.exports={create,validate,HOUR};
