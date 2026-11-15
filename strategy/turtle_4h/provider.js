"use strict";
const C=require("./config"),BASE="https://fapi.binance.com";
async function json(url){let r;try{r=await fetch(url,{signal:AbortSignal.timeout(12000)});}catch(e){throw Error("BINANCE_PUBLIC_UNAVAILABLE："+(e.cause?.code||e.name||"连接失败"));}if(!r.ok)throw Error("BINANCE_PUBLIC_HTTP_"+r.status);return r.json();}
function create(request=json,clock=Date.now){let specs,checked=0;const caches=new Map();
 return {async load(a,c,since) {
  C.assertAccount(a);const symbol=a.symbol+"USDT",now=clock(),cache=caches.get(symbol),fresh=cache&&now-cache.at<60000;
  const jobs=[request(BASE+"/fapi/v1/ticker/bookTicker?symbol="+symbol),fresh?Promise.resolve(cache.rows):request(BASE+"/fapi/v1/klines?symbol="+symbol+"&interval=4h&limit=500"),request(BASE+"/fapi/v1/fundingRate?symbol="+symbol+"&startTime="+Math.max(0,since)+"&limit=1000"),!specs||now-checked>3600000?request(BASE+"/fapi/v1/exchangeInfo"):Promise.resolve(specs)];
  const [q,rows,funding,info]=await Promise.all(jobs);specs=info;checked=clock();if(!fresh)caches.set(symbol,{at:clock(),rows});
  const meta=info.symbols?.find(v=>v.symbol===symbol),lot=meta?.filters.find(v=>v.filterType==="MARKET_LOT_SIZE"),minimum=meta?.filters.find(v=>v.filterType==="MIN_NOTIONAL");
  if(meta?.contractType!=="PERPETUAL"||meta.quoteAsset!=="USDT"||meta.status!=="TRADING")throw Error("CONTRACT_MISMATCH：不是 Binance USDT 永续");
  if(!Array.isArray(funding)||funding.length>=1000)throw Error("FUNDING_INCOMPLETE：资金费覆盖范围不足");
  return {source:"binance_usdm_native",symbol,quoteAsset:"USDT",marketType:"perpetual",receivedAt:clock(),
   quote:{bid:+q.bidPrice,ask:+q.askPrice,bidQty:+q.bidQty,askQty:+q.askQty,time:+q.time},
   candles:rows.map(r=>({time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4]})),
   rules:{step:+lot?.stepSize,minQty:+lot?.minQty,maxQty:+lot?.maxQty,minNotional:+minimum?.notional},
   funding:funding.map(v=>({time:+v.fundingTime,rate:+v.fundingRate,price:+v.markPrice})),fundingFrom:since,fundingComplete:true};
 }};
}
function validate(d,a,now){
 if(d?.source!=="binance_usdm_native"||d.symbol!==a.symbol+"USDT"||d.quoteAsset!=="USDT"||d.marketType!=="perpetual")throw Error("SOURCE_MISMATCH：必须使用 Binance USDT 永续原生行情");
 const q=d.quote,r=d.rules;if(!(q?.bid>0&&q.ask>=q.bid&&q.bidQty>0&&q.askQty>0))throw Error("QUOTE_INVALID：原生盘口无效");
 if(!Number.isFinite(q.time)||now-q.time>15000||q.time>now+2000)throw Error("QUOTE_STALE：报价时间失效，等待原生行情恢复");
 if((q.ask-q.bid)/q.bid*10000>20)throw Error("SPREAD_BLOCK：盘口价差过大");
 if(!(r?.step>0&&r.minQty>0&&r.maxQty>=r.minQty&&r.minNotional>0))throw Error("SPEC_INVALID：原生交易规格不完整");
 if(!d.fundingComplete||!Number.isFinite(d.fundingFrom)||!Array.isArray(d.funding)||d.funding.some(f=>!Number.isFinite(f.time)||!Number.isFinite(f.rate)||!(f.price>0)))throw Error("FUNDING_INCOMPLETE：资金费证据不足");
}
module.exports={create,validate,BASE};
