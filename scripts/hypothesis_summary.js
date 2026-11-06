"use strict";
// Condense real, locally generated reports for a reviewable repository artifact.
const fs=require("fs"),path=require("path"),crypto=require("crypto");
function summarize(root){
 const assets={};
 for(const symbol of ["ETH","BTC"]){const lower=symbol.toLowerCase(),dir=path.join(root,"research-"+lower),files=fs.readdirSync(dir).filter(v=>v.endsWith(".json")).sort(),reportFile=path.join(dir,files.at(-1)),report=JSON.parse(fs.readFileSync(reportFile)),dataFile=path.join(root,"h01-"+lower+"-2024.json"),data=JSON.parse(fs.readFileSync(dataFile));
  const compact=r=>({scope:r.scope,matching:r.matching,metrics:r.metrics,funnel:r.funnel,unfinished:r.unfinished,attribution:r.attribution});
  const curve=xs=>xs.filter((v,k)=>k===0||k===xs.length-1||k%288===0);
  assets[symbol]={source:data.source,marketType:data.marketType,dataSha256:crypto.createHash("sha256").update(fs.readFileSync(dataFile)).digest("hex"),reportSha256:crypto.createHash("sha256").update(fs.readFileSync(reportFile)).digest("hex"),dataHash:report.dataHash,downloadedAt:data.downloadedAt,rows:Object.fromEntries(Object.entries(data.bars).map(([k,v])=>[k,v.length])),fundingRows:data.funding.length,missingFundingMonths:data.missingFundingMonths,zeroVolumeBars:Object.fromEntries(Object.entries(data.bars).map(([k,v])=>[k,v.filter(c=>c.volume===0).length])),evidence:data.evidence,rules:data.rules,ruleCaveat:data.historyRuleCaveat,fundingCaveat:data.fundingCaveat,parameters:report.parameters,preregistration:report.preregistration,results:Object.fromEntries(Object.entries(report.results).map(([k,v])=>[k,{from:v.from,to:v.to,experiments:v.experiments.map(compact),baselineTrades:v.experiments[0].trades,baselineCurveSample:curve(v.experiments[0].curve)}])),walkForward:report.walkForward.map(v=>({...v,result:compact(v.result)})),matchingSensitivity:report.matchingSensitivity.map(compact),gate:report.gate,oosDecay:report.oosDecay,limitations:report.limitations};
 }
 return{schema:1,generatedAt:Date.now(),baselineCommit:"0681f2b78cffd9fbaee316b5c10426c97df99fb1",kind:"HISTORICAL_BACKTEST_NOT_SHADOW_FORWARD",liveAllowed:false,assets,additionalLimitations:["当前年度仅覆盖2024，不能声称已覆盖完整牛熊周期","样本外不是未被研究人员见过的市场历史，仅程序中严格时序留出，后续应新增未使用历史","H05 C与A使用相同底层强制市场/流动性/成本门槛，因此默认规则下等价；未证明独立增益","曲线为抽样展示，完整逐事件点在本地原始报告，指标用完整曲线计算","所有实验均保留，不依据最好样本外结果选择默认参数"]};
}
if(require.main===module)console.log(JSON.stringify(summarize(process.argv[2]||".audit"),null,2));
module.exports={summarize};
