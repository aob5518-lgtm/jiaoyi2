(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.HistoryModel=api;})(typeof globalThis!=="undefined"?globalThis:this,function(){
 "use strict";
 const number=x=>x===null||x===undefined||x===""||!Number.isFinite(Number(x))?null:Number(x);
 const time=x=>number(x)??(Number.isFinite(Date.parse(x))?Date.parse(x):0);
 const net=v=>number(v.netPnl)??number(v.pnl);
 const r=v=>number(v.netR)??number(v.rMultiple);
 const sample=v=>v.sampleType==="shadow"?"shadow":v.simulation===true||v.paper===true||v.tradeMode==="simulation"?"paper":"legacy";
 function filter(rows,f={}){return(rows||[]).filter(v=>(!f.from||time(v.exitTime||v.time)>=f.from)&&(!f.to||time(v.exitTime||v.time)<=f.to)&&(!f.strategy||f.strategy==="all"||v.strategyVersion===f.strategy)&&(!f.sample||f.sample==="all"||sample(v)===f.sample)&&(!f.experiment||v.experimentId===f.experiment)&&(!f.revision||f.revision==="all"||(f.revision==="unknown"?!v.strategyRevision:v.strategyRevision===f.revision))&&(!f.hash||String(v.configHash||"").startsWith(f.hash))&&(!f.side||f.side==="all"||v.side===f.side)&&(!f.setup||f.setup==="all"||v.entryMode===f.setup)&&(!f.exit||f.exit==="all"||(f.exit==="stop"?["hard_sl","structure_sl","post_fill_risk_invalid"].includes(v.closeReason):v.closeReason===f.exit))&&(!f.result||f.result==="all"||(f.result==="win"?net(v)>0:net(v)<0))&&(f.minCost==null||number(v.costR)!==null&&number(v.costR)>=f.minCost)&&(f.maxCost==null||number(v.costR)!==null&&number(v.costR)<=f.maxCost)&&(f.minR==null||r(v)!==null&&r(v)>=f.minR)&&(f.maxR==null||r(v)!==null&&r(v)<=f.maxR));}
 function summary(rows){
  const known=rows.filter(v=>net(v)!==null),rRows=rows.filter(v=>r(v)!==null),scopes=new Set(rows.map(v=>[v.strategyVersion,v.strategyRevision,v.experimentId,v.configHash,sample(v)].join(":")));
  let equity=0,peak=0,drawdown=0;for(const v of [...known].sort((a,b)=>time(a.exitTime)-time(b.exitTime))){equity+=net(v);peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);}
  const wins=known.filter(v=>net(v)>0),loss=Math.abs(known.filter(v=>net(v)<0).reduce((s,v)=>s+net(v),0));
  return{samples:known.length,rSamples:rRows.length,comparable:scopes.size<=1,netPnl:known.length?known.reduce((s,v)=>s+net(v),0):null,expectancy:rRows.length?rRows.reduce((s,v)=>s+r(v),0)/rRows.length:null,profitFactor:loss>0?wins.reduce((s,v)=>s+net(v),0)/loss:null,maxDrawdown:known.length?drawdown:null,winRate:known.length?wins.length/known.length:null};
 }
 function csv(rows){const columns=["exitTime","symbol","side","strategyVersion","entryMode","sampleType","entryPrice","exitPrice","netPnl","netR","grossPnl","tradingFee","fundingPnl","costR","closeReason","experimentId","strategyRevision","configHash"];
 const quote=x=>'"'+(typeof x==="string"?x.replace(/^[=+@\-\t\r]/,x=>"'"+x):String(x??"")).replace(/"/g,'""')+'"';return[columns,...rows.map(v=>columns.map(k=>v[k]??""))].map(row=>row.map(quote).join(",")).join("\n");}
 return{number,time,net,r,sample,filter,summary,csv};
});
