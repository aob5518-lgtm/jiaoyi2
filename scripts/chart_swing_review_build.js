"use strict";
const fs=require("node:fs"),crypto=require("node:crypto"),C=require("../strategy/chart_swing_1h/config");
function build(input,report,output){
 const raw=fs.readFileSync(input),data=JSON.parse(raw),r=JSON.parse(fs.readFileSync(report));
 if(r.dataHash!==crypto.createHash("sha256").update(raw).digest("hex")||r.configHash!==C.hash(C.defaults))throw Error("Review evidence/config mismatch");
 const summary=x=>({trades:x.closedTrades,netPnl:x.netPnl,profitFactor:x.profitFactor,maxDrawdown:x.maxDrawdown,
  expectancy:x.expectancy,worstTrade:x.worstTrade,fees:x.fees,openAtEnd:x.openAtEnd,endingEquity:x.endingEquity});
 const sample={revision:r.revision,configHash:r.configHash,dataHash:r.dataHash,from:r.baseline.from,to:r.baseline.to,
  source:r.source,market:r.market,sampleType:r.sampleType,precision:r.comparison.precision,config:r.config,
  counts:{screenshots:46,duplicates:r.comparison.duplicateScreenshots,targets:r.comparison.uniqueTargets,
   signalMatched:r.comparison.signalMatched,entryMatched:r.comparison.entryMatched,pairsMatched:r.comparison.entryAndExitMatched,
   extraSignals:r.comparison.extraSignals,extraTrades:r.comparison.extraTrades},
  baseline:summary(r.baseline),stress:summary(r.stress),earlier:summary(r.earlierUnannotated),rejectedPrototype:summary(r.rejectedPrototype),
  candles:data.bars.filter(b=>b.time>=r.baseline.from-48*C.BAR).map(b=>[b.time,b.open,b.high,b.low,b.close]),
  targets:r.comparison.targets,trades:r.baseline.trades.map(t=>({entryAt:t.entryTime,exitAt:t.time,side:t.side,entry:t.entryPrice,exit:t.exitPrice,
   reason:t.reason,netPnl:t.netPnl,r:t.rMultiple,mode:t.entryMode}))};
 fs.writeFileSync(output,'/* Public historical research only. No user account data. */\nwindow.JustChartSwingSample='+JSON.stringify(sample)+';\n');
 return sample;
}
if(require.main===module){const r=build(...process.argv.slice(2));console.log(r.counts);}
module.exports={build};
