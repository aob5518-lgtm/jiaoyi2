"use strict";
const {HOUR}=require('./signal');
const BASE='https://fapi.binance.com';
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('BINANCE_PUBLIC_HTTP_'+r.status);return r.json();}
function createProvider(request=json){let specs=null,checkedAt=0;return{async load(account,config,since=Date.now()-16*HOUR){
 const symbol=account.symbol+'USDT',now=Date.now();
 const jobs=[request(BASE+'/fapi/v1/klines?symbol='+symbol+'&interval=1h&limit='+Math.min(1500,Math.max(500,config.slowPeriod*8+20))),request(BASE+'/fapi/v1/ticker/bookTicker?symbol='+symbol),request(BASE+'/fapi/v1/fundingRate?symbol='+symbol+'&startTime='+Math.max(0,since)+'&limit=1000')];
 if(!specs||now-checkedAt>3600000)jobs.push(request(BASE+'/fapi/v1/exchangeInfo'));
 if(config.higherTimeframeFilter)jobs.push(request(BASE+'/fapi/v1/klines?symbol='+symbol+'&interval=4h&limit=300'));
 const values=await Promise.all(jobs);if(values[3]?.symbols){specs=values[3];checkedAt=Date.now();}
 const meta=specs?.symbols.find(v=>v.symbol===symbol),lot=meta?.filters.find(v=>v.filterType==='MARKET_LOT_SIZE'),fallback=meta?.filters.find(v=>v.filterType==='LOT_SIZE'),notional=meta?.filters.find(v=>v.filterType==='MIN_NOTIONAL');
 if(meta?.status!=='TRADING'||meta.contractType!=='PERPETUAL'||meta.quoteAsset!=='USDT')throw Error('BINANCE_CONTRACT_MISMATCH');
 const candles=rows=>rows.map(r=>({time:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])}));
 const q=values[1],bid=Number(q.bidPrice),ask=Number(q.askPrice),receivedAt=Date.now();
 const rules={priceTick:Number(meta.filters.find(v=>v.filterType==='PRICE_FILTER')?.tickSize),qtyStep:Number(lot?.stepSize||fallback?.stepSize),minQty:Number(lot?.minQty||fallback?.minQty),maxQty:Number(lot?.maxQty||fallback?.maxQty),minNotional:Number(notional?.notional)};
 if(!Array.isArray(values[2])||values[2].length>=1000)throw Error('FUNDING_HISTORY_INCOMPLETE');
 return{source:'binance_usdm_native',symbol,quoteAsset:'USDT',marketType:'perpetual',receivedAt,candles:candles(values[0]),higherCandles:config.higherTimeframeFilter?candles(values.at(-1)):null,
 quote:{bid,ask,price:(bid+ask)/2,bidQty:Number(q.bidQty),askQty:Number(q.askQty),timestamp:Number(q.time),receivedAt,source:'binance_usdm_native',symbol},rules,
 funding:values[2].map(v=>({time:Number(v.fundingTime),rate:Number(v.fundingRate),markPrice:Number(v.markPrice)})),fundingComplete:true,fundingFrom:since};
 }};}
function validate(data,account,c,now){
 if(data.source!=='binance_usdm_native'||data.symbol!==account.symbol+'USDT'||data.quoteAsset!=='USDT'||data.marketType!=='perpetual')return['SOURCE_MISMATCH','不是目标 Binance USDT 永续原生行情'];
 const q=data.quote;if(!(q?.bid>0&&q.ask>=q.bid&&q.price>0&&q.symbol===account.symbol+'USDT'))return['QUOTE_INVALID','买卖报价无效'];
 if(!Number.isFinite(q.timestamp)||now-q.timestamp>c.quoteMaxAgeMs||q.timestamp>now+2000)return['QUOTE_STALE','报价时间失效'];
 if((q.ask-q.bid)/q.price*10000>c.maxSpreadBps)return['SPREAD_BLOCK','盘口价差超过限制'];
 if(!data.fundingComplete)return['FUNDING_INCOMPLETE','资金费历史未确认完整'];
 if(!data.funding.every(v=>Number.isFinite(v.rate)&&v.markPrice>0&&Number.isFinite(v.time)))return['FUNDING_INVALID','资金费率或结算标记价格缺失'];
 if(!(data.rules?.qtyStep>0&&data.rules.minQty>0&&data.rules.minNotional>0))return['SPEC_INVALID','合约规格不完整'];
 return null;
}
module.exports={BASE,createProvider,validate};
