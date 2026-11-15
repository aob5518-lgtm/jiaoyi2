"use strict";
const crypto=require('crypto');
const ID='macd_scale_in_v1',REVISION='H06_MACD_SCALE_IN_V1_20261111';
const defaults=Object.freeze({timeframe:'1h',fastPeriod:12,slowPeriod:26,signalPeriod:9,signalMode:'CROSS',crossConfirmBars:1,momentumConfirmBars:2,tradeDirection:'LONG_ONLY',firstMarginPct:.01,add1MarginPct:.01,add2MarginPct:.02,add3MarginPct:.02,maxAdds:3,maxMarginPct:.06,leverage:1,takeProfitRoiPct:100,partialClosePct:50,exitOnOppositeWhenProfitable:true,partialTakeProfitEnabled:true,maxCycleLossPct:.01,maxDailyLossPct:.02,stopMode:'FIXED_LOSS',atrPeriod:14,atrMultiplier:2,minSignalIntervalBars:1,minAddLossPct:0,minAddPriceDistancePct:0,cooldownBars:1,entryFeeRate:.0005,exitFeeRate:.0005,slippageBps:5,maxSlippageBps:20,maxSpreadBps:10,maxParticipationPct:.01,quoteMaxAgeMs:15000,candleMaxDelayMs:120000,signalMaxAgeMs:120000,allowWeekends:true,sessionStartUtc:0,sessionEndUtc:24,maxPortfolioRiskPct:.025,higherTimeframeFilter:false,executionDelayMs:1000});
const limits={fastPeriod:[2,100,1],slowPeriod:[3,180,1],signalPeriod:[2,100,1],crossConfirmBars:[1,5,1],momentumConfirmBars:[2,6,1],firstMarginPct:[.001,.02],add1MarginPct:[0,.02],add2MarginPct:[0,.02],add3MarginPct:[0,.02],maxAdds:[0,3,1],maxMarginPct:[.001,.06],leverage:[1,5,1],takeProfitRoiPct:[1,500],partialClosePct:[1,99],maxCycleLossPct:[.001,.01],maxDailyLossPct:[.001,.02],atrPeriod:[5,100,1],atrMultiplier:[.5,5],minSignalIntervalBars:[1,48,1],minAddLossPct:[0,.5],minAddPriceDistancePct:[0,.2],cooldownBars:[0,72,1],entryFeeRate:[0,.01],exitFeeRate:[0,.01],slippageBps:[0,100],maxSlippageBps:[1,100],maxSpreadBps:[.1,100],maxParticipationPct:[.0001,.01],quoteMaxAgeMs:[1000,60000,1],candleMaxDelayMs:[1000,300000,1],signalMaxAgeMs:[1000,300000,1],sessionStartUtc:[0,23,1],sessionEndUtc:[1,24,1],maxPortfolioRiskPct:[.001,.025],executionDelayMs:[1,60000,1]};
const choices={timeframe:['1h'],signalMode:['CROSS','MOMENTUM','COMBINED'],tradeDirection:['LONG_ONLY','SHORT_ONLY','BOTH'],stopMode:['FIXED_LOSS','ATR']};
const bools=['exitOnOppositeWhenProfitable','partialTakeProfitEnabled','allowWeekends','higherTimeframeFilter'];
function normalize(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)))throw Error('H06_CONFIG_FIELDS：不支持的参数或 Live 权限字段');
 const c={...defaults,...input};
 for(const [key,[min,max,integer]] of Object.entries(limits))if(typeof c[key]!=='number'||!Number.isFinite(c[key])||c[key]<min||c[key]>max||integer&&!Number.isInteger(c[key]))throw Error('H06_CONFIG_RANGE：'+key+' 范围 '+min+'–'+max);
 for(const [key,values] of Object.entries(choices))if(!values.includes(c[key]))throw Error('H06_CONFIG_ENUM：'+key);
 for(const key of bools)if(typeof c[key]!=='boolean')throw Error('H06_CONFIG_BOOLEAN：'+key);
 if(c.fastPeriod>=c.slowPeriod||c.sessionStartUtc>=c.sessionEndUtc||c.slippageBps>c.maxSlippageBps)throw Error('H06_CONFIG_CONFLICT：周期、时段或滑点配置冲突');
 if(layers(c).reduce((s,v)=>s+v,0)>c.maxMarginPct+1e-12)throw Error('H06_MARGIN_BUDGET：各层保证金之和超过本轮上限');
 return c;
}
function layers(c){return[c.firstMarginPct,c.add1MarginPct,c.add2MarginPct,c.add3MarginPct].slice(0,c.maxAdds+1);}
function scope(config,account={}){const c=normalize(config),configHash=crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');return{strategyVersion:ID,strategyRevision:REVISION,experimentId:'H06_'+c.signalMode+'_V1',configHash,sampleType:account.h06Mode==='Shadow'?'shadow':account.h06Mode==='Research'?'backtest':'paper'};}
function assertAccount(a){if(a.strategyType!==ID||a.platform!=='binance'||a.quoteAsset!=='USDT'||!['ETH','BTC'].includes(a.symbol)||a.tradeMode!=='simulation'||a.simulationEnabled!==true||!['Paper','Shadow','Research'].includes(a.h06Mode))throw Error('H06_PAPER_ONLY：仅 Binance ETH/BTC USDT 永续独立模拟账户，禁止 Live');}
module.exports={ID,REVISION,defaults,limits,choices,bools,normalize,layers,scope,assertAccount};
