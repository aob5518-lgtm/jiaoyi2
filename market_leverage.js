"use strict";

const BINANCE="https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets";
const HYPER="https://api.hyperliquid.xyz/info";
const EXTENDED="https://api.starknet.extended.exchange/api/v1/info/markets";
const ttl=5*60000, retryDelay=15000;
const valid=(value,step=1)=>value>=1&&(step===.1?
 Number.isSafeInteger(Math.round(value*10))&&Math.round(value*10)/10===value:Number.isSafeInteger(value));
const noSpec="暂未取得交易所杠杆档位，请稍后重试";

function table(tiers, market, source, checkedAt, step=1, capInclusive=false) {
 if (!tiers.length||tiers[0].floor!==0||tiers.some((t,i)=>
  !Number.isFinite(t.floor)||t.floor<0||t.cap!==null&&!(Number.isFinite(t.cap)&&t.cap>t.floor)||!valid(t.maxLeverage,step)||
  i>0&&(tiers[i-1].cap!==t.floor||tiers[i-1].maxLeverage<t.maxLeverage))) {
  throw Error("交易所杠杆表格式或分档无效");
 }
 return {market,source,checkedAt,maxLeverage:tiers[0].maxLeverage,tiers,step,capInclusive};
}
function parseBinance(payload,symbol,time) {
 const market=symbol+"USDT", row=payload?.success===true&&payload.data?.brackets?.find?.(v=>v.symbol===market);
 const tiers=row?.riskBrackets?.map(v=>({floor:Number(v.bracketNotionalFloor),cap:Number(v.bracketNotionalCap),
  maxLeverage:Number(v.maxOpenPosLeverage)}))||[];
 return table(tiers,market,"Binance 官网公开 USDⓈ-M 档位",time);
}
function parseHyper(payload,symbol,time) {
 const row=payload?.universe?.find(v=>v.name===symbol&&!v.isDelisted);
 if (!valid(row?.maxLeverage)) throw Error("Hyperliquid 市场杠杆规格不可用");
 const levels=payload.marginTables?.find(([id])=>id===row.marginTableId)?.[1]?.marginTiers;
 if (!levels?.length&&row.marginTableId>50) throw Error("Hyperliquid 市场分档缺失");
 const tiers=levels?.map((v,i)=>({floor:Number(v.lowerBound),
  cap:i+1<levels.length?Number(levels[i+1].lowerBound):null,maxLeverage:Math.min(row.maxLeverage,Number(v.maxLeverage))}))||
  [{floor:0,cap:null,maxLeverage:row.maxLeverage}];
 return table(tiers,symbol,"Hyperliquid 原生 meta",time);
}
function parseExtended(payload,symbol,time) {
 const market=symbol+"-USD", row=payload?.status==="OK"&&payload.data?.find?.(v=>v.name===market&&v.active&&
  (!v.type||v.type==="PERPETUAL")&&(!v.status||v.status==="ACTIVE"));
 const info=row?.tradingConfig, max=Number(info?.maxLeverage),cap=Number(info?.maxPositionValue);
 if (!valid(max,.1)||!Number.isFinite(cap)||cap<=0) throw Error("Extended 市场杠杆规格不可用");
 let floor=0;
 const tiers=[];
 for (const v of info.riskFactorConfig||[]) {
  if (v.isAvailableForUsers===false||floor>=cap) break;
  const upper=Math.min(cap,Number(v.upperBound));
  const leverage=Math.min(max,Math.round(10/Number(v.riskFactor)+1e-8)/10);
  tiers.push({floor,cap:upper,maxLeverage:leverage});
  floor=upper;
 }
 if (!tiers.length) throw Error("Extended 市场分档缺失");
 return table(tiers,market,"Extended 原生市场规格",time,.1,true);
}
function maxAt(spec,notional=0) {
 return spec?.tiers.find(t=>notional>=t.floor&&(t.cap===null||notional<t.cap||spec.capInclusive&&notional===t.cap))?.maxLeverage||0;
}
function leverageError(value,spec,notional) {
 if (!spec) return noSpec;
 if (!valid(value,spec.step)) return spec.step===.1?"杠杆须大于或等于 1，最多一位小数":"杠杆须为大于或等于 1 的整数";
 const max=maxAt(spec,notional);
 if (!max) return spec.market+" 名义仓位超出交易所分档范围";
 return value>max?spec.market+" 当前仓位档位最高 "+max+" 倍":"";
}
function assertAllowed(value,spec,notional) {
 const error=leverageError(value,spec,notional);
 if (error) throw Error(error);
}
async function request(url, options) {
 const r=await fetch(url,{...options,signal:AbortSignal.timeout(5000)});
 if (!r.ok) throw Error(noSpec);
 return r.json();
}
function create(get=request, now=Date.now) {
 const cache=new Map(), inFlight=new Map(), failures=new Map();
 const sources={
  binance:[BINANCE,parseBinance,p=>p?.success===true&&Array.isArray(p.data?.brackets)],
  hyperliquid:[HYPER,parseHyper,p=>Array.isArray(p?.universe),{method:"POST",headers:{"content-type":"application/json"},body:'{"type":"meta"}'}],
  extended:[EXTENDED,parseExtended,p=>p?.status==="OK"&&Array.isArray(p.data)]
 };
 async function load(a) {
  const platform=a.platform, source=Object.hasOwn(sources,platform)?sources[platform]:null;
  const symbol=String(a.symbol||"").toUpperCase();
  if (!source||!symbol) throw Error(noSpec);
  const [url,parse,usable,options]=source;
  const saved=cache.get(platform);
  if (saved&&now()-saved.time<ttl) return parse(saved.payload,symbol,saved.time);
  if (now()<(failures.get(platform)||0)) throw Error(noSpec);
  if (!inFlight.has(platform)) {
   const pending=Promise.resolve().then(()=>get(url,options)).then(payload=>{
    const record={payload,time:now()};
    if(!usable(payload))throw Error(noSpec);
    cache.set(platform,record);
    return record;
   }).catch(()=>{failures.set(platform,now()+retryDelay);throw Error(noSpec);}).finally(()=>inFlight.delete(platform));
   inFlight.set(platform,pending);
  }
  const record=await inFlight.get(platform);
  return parse(record.payload,symbol,record.time);
 }
 return {load};
}
module.exports={create,valid,maxAt,leverageError,assertAllowed,parseBinance,parseHyper,parseExtended};
