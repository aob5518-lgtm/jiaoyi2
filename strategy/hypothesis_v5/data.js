"use strict";
// Public Binance USD-M GET-only adapter. No signing, SDK, account endpoints or secrets.
const M=require("./market");
const PATHS=new Set(["/fapi/v1/klines","/fapi/v1/depth","/fapi/v1/exchangeInfo","/fapi/v1/fundingRate"]);
function adapter(request=fetch){
 async function get(route,params={}){if(!PATHS.has(route))throw Error("PUBLIC_DATA_ONLY");const u=new URL(route,"https://fapi.binance.com");for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);const r=await request(u,{method:"GET",signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error("BINANCE_PUBLIC_HTTP_"+r.status);return r.json();}
 let exchange=null,exchangeAt=0;
 async function rules(symbol){if(!exchange||Date.now()-exchangeAt>3600000){exchange=await get("/fapi/v1/exchangeInfo");exchangeAt=Date.now();}const s=exchange.symbols.find(s=>s.symbol===symbol+"USDT"&&s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT"&&s.status==="TRADING");if(!s)throw Error("UNSUPPORTED_PERPETUAL");const find=t=>s.filters.find(f=>f.filterType===t),lot=find("LOT_SIZE"),px=find("PRICE_FILTER");return{qtyStep:+lot.stepSize,minQty:+lot.minQty,maxQty:+lot.maxQty,priceTick:+px.tickSize,minNotional:+find("MIN_NOTIONAL").notional};}
 async function candles(symbol,tf,params={}){const rows=await get("/fapi/v1/klines",{symbol:symbol+"USDT",interval:tf,limit:300,...params});if(!Array.isArray(rows))throw Error("CANDLES_INVALID");return rows.map(v=>({time:+v[0],open:+v[1],high:+v[2],low:+v[3],close:+v[4],volume:+v[5]}));}
 async function snapshot(symbol){if(!["ETH","BTC"].includes(symbol))throw Error("SYMBOL_NOT_APPROVED");const [h4,h1,m15,book,r]=await Promise.all([candles(symbol,"4h"),candles(symbol,"1h"),candles(symbol,"15m"),get("/fapi/v1/depth",{symbol:symbol+"USDT",limit:20}),rules(symbol)]),now=Date.now();
  if(!Array.isArray(book.bids)||!Array.isArray(book.asks)||!book.bids.length||!book.asks.length)throw Error("DEPTH_MISSING");
  const bid=+book.bids[0][0],ask=+book.asks[0][0],depthNotional=Math.min(...[book.bids,book.asks].map(v=>v.slice(0,10).reduce((n,[p,q])=>n+Number(p)*Number(q),0))),time=Number(book.T??book.E);
  if(!Number.isFinite(time))throw Error("NATIVE_BOOK_TIMESTAMP_MISSING");
  return{time:now,bars:{"4h":h4,"1h":h1,"15m":m15},quote:{bid,ask,time,receivedAt:now,depthNotional,symbol:symbol+"USDT",quoteAsset:"USDT",platform:"binance",marketType:"perpetual",source:"native_binance",quality:"L2_SNAPSHOT_NOT_QUEUE_PROOF"},rules:r};
 }
 return{get,rules,candles,snapshot};
}
function validateDataset(d){
 if(d?.source!=="BINANCE_USDM_NATIVE"||d.marketType!=="perpetual"||!["ETH","BTC"].includes(d.symbol)||!d.bars||!Array.isArray(d.funding))throw Error("DATASET_PROVENANCE_INVALID");
 for(const tf of Object.keys(M.MS)){const rows=d.bars[tf];if(!Array.isArray(rows)||!rows.length)throw Error("DATASET_MISSING_"+tf);const end=rows.at(-1).time+M.MS[tf];M.closed(rows,tf,end);}
 return true;
}
module.exports={adapter,validateDataset,PATHS};
