"use strict";
// Public Binance USD-M only. Explicit UTC boundaries, continuous bars and funding evidence.
const fs=require("node:fs"),{validate}=require("./chart_swing_research");
const H=3600000,BASE="https://fapi.binance.com";
async function json(route){
 const r=await fetch(BASE+route,{signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error("BINANCE_NATIVE_UNAVAILABLE HTTP "+r.status);
 return r.json();
}
async function download(start,end){
 const from=Date.parse(start),server=await json("/fapi/v1/time"),to=end?Date.parse(end):Math.floor(server.serverTime/H)*H;
 if(!Number.isFinite(from)||!Number.isFinite(to)||from%H||to%H||to<=from||to>server.serverTime||to-from>366*24*H)throw Error("Use closed UTC hour boundaries, up to one year");
 const bars=[],funding=[];
 for(let time=from;time<to;time+=1000*H){
  const until=Math.min(to,time+1000*H);
  const rows=await json("/fapi/v1/klines?symbol=ETHUSDT&interval=1h&startTime="+time+"&endTime="+(until-1)+"&limit=1000");
  if(!Array.isArray(rows)||rows.length!==(until-time)/H)throw Error("Native history missing at "+new Date(time).toISOString());
  bars.push(...rows.map(r=>({time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5]})));
 }
 for(let time=from;time<to;){
  const rows=await json("/fapi/v1/fundingRate?symbol=ETHUSDT&startTime="+time+"&endTime="+(to-1)+"&limit=1000");
  if(!Array.isArray(rows)||!rows.length)throw Error("Native funding history missing");
  funding.push(...rows.map(r=>({time:+r.fundingTime,rate:+r.fundingRate,price:+r.markPrice})));
  time=+rows.at(-1).fundingTime+1;if(rows.length<1000)break;
 }
 const data={source:"binance_usdm_native",market:"ETHUSDT",interval:"1h",from,end:to,fetchedAt:server.serverTime,bars,funding};
 validate(data);return data;
}
if(require.main===module){
 const [from,to,file]=process.argv.slice(2);
 if(!file)throw Error("Usage: node scripts/chart_swing_download.js UTC_START UTC_END output.json");
 download(from,to).then(data=>{fs.writeFileSync(file,JSON.stringify(data));console.log({bars:data.bars.length,funding:data.funding.length});}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={download};
