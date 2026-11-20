"use strict";
const fs=require("fs"),path=require("path"),C=require("../strategy/hypothesis_v5/config"),D=require("../strategy/hypothesis_v5/data"),H=require("../strategy/hypothesis_v5/research");
async function collect({symbol="ETH",days=365,file,request}){
 if(!["BTC","ETH"].includes(symbol)||!Number.isInteger(days)||days<30||days>1500)throw Error("数据请求范围无效");
 if(fs.existsSync(file))throw Error("禁止覆盖冻结数据");
 const api=D.adapter(request),end=Math.floor(Date.now()/900000)*900000,start=end-days*86400000,bars={},urls=[];
 for(const tf of ["4h","1h","15m"]){const ms={"4h":14400000,"1h":3600000,"15m":900000}[tf],warmup=260*ms;let cursor=Math.floor((start-warmup)/ms)*ms;const rows=[];
  while(cursor<end){urls.push("/fapi/v1/klines?symbol="+symbol+"USDT&interval="+tf+"&startTime="+cursor);const batch=await api.candles(symbol,tf,{startTime:cursor,endTime:end-1,limit:1000});if(!batch.length)throw Error("历史数据未完整返回 "+tf);rows.push(...batch.filter(v=>v.time>=cursor&&v.time+ms<=end));const next=batch.at(-1).time+ms;if(next<=cursor)throw Error("历史分页未前进");cursor=next;}
  bars[tf]=[...new Map(rows.map(v=>[v.time,v])).values()].sort((a,b)=>a.time-b.time);
 }
 const funding=[];let cursor=start-86400000;while(cursor<end){const batch=await api.get("/fapi/v1/fundingRate",{symbol:symbol+"USDT",startTime:cursor,endTime:end-1,limit:1000});if(!Array.isArray(batch))throw Error("资金费无效");if(!batch.length)break;funding.push(...batch.map(v=>({time:Number(v.fundingTime),rate:Number(v.fundingRate),markPrice:Number(v.markPrice)})));const next=Number(batch.at(-1).fundingTime)+1;if(next<=cursor)throw Error("资金费分页未前进");cursor=next;}
 const rules=await api.rules(symbol),dataset={schema:1,source:"BINANCE_USDM_NATIVE",symbol,quoteAsset:"USDT",marketType:"perpetual",downloadedAt:Date.now(),start,end,urls,historyRuleCaveat:"current exchange rules, no historical rule snapshots",bars,funding,rules};
 D.validateDataset(dataset);dataset.contentHash=C.hash({bars,funding});fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,JSON.stringify(dataset),{flag:"wx",mode:0o600});return{file,hash:dataset.contentHash,bars:Object.fromEntries(Object.entries(bars).map(([k,v])=>[k,v.length])),funding:funding.length};
}
async function main(){const[mode,file,arg]=process.argv.slice(2);if(!file)throw Error("--collect FILE [ETH|BTC:days] | --run FILE OUTPUT_DIR");
 if(mode==="--collect"){const[symbol,days]=(arg||"ETH:365").split(":");console.log(JSON.stringify(await collect({symbol,days:Number(days),file})));return;}
 if(mode!=="--run")throw Error("研究命令无效");const dir=path.resolve(arg||".v5-research/reports"),dataset=JSON.parse(fs.readFileSync(file)),at=Date.now();let record={type:"RESEARCH_ATTEMPT",at,dataHash:C.hash(dataset),revision:C.REVISION};
 H.appendExperiment(dir,record);
 try{const report=H.suite(dataset),output=path.join(dir,"H01-"+dataset.symbol+"-"+at+".json");fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});H.appendExperiment(dir,{...record,type:"RESULT",path:path.basename(output),gate:report.gate,resultHash:C.hash(report)});console.log(JSON.stringify({output,gate:report.gate,splits:Object.fromEntries(Object.entries(report.results).map(([k,v])=>[k,v.experiments[0].metrics]))},null,2));}catch(e){H.appendExperiment(dir,{...record,type:"FAILED",error:e.message});throw e;}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={collect};
