"use strict";
const {ID,REVISION,hash} = require("./config");
const createdAt = "2026-11-06T00:00:00Z";
const hypotheses = Object.freeze([
 {id:"H01",strategyId:ID,version:REVISION,status:"UNVALIDATED",observation:"部分行情方向延续",hypothesis:"收盘突破在高周期趋势与成交需求支持下具有扣费后延续性",mechanism:"分阶段调仓、止损及跟随需求；机制仍待验证",validation:"相同原生永续数据、分割/滚动样本外、成本压力及消融",falsification:"独立样本外净期望非正，或证据不足、收益集中、压力成本不通过"},
 {id:"H05",version:REVISION,status:"UNVALIDATED",observation:"UTC周末流动性可能不同",hypothesis:"周末条件过滤可能改善执行质量",mechanism:"参与度与深度变化，非必然存在",validation:"A全天候/B周末禁开/C流动性条件，相同数据和成本",falsification:"独立样本外未优于A或证据不足"},
 ...["H02","H03","H04"].map((id,n)=>({id,version:REVISION,status:"REGISTERED_ONLY",observation:["假突破","清算冲击","资金费拥挤"][n],hypothesis:"尚待预注册与独立验证",mechanism:"未验证",validation:"仅允许登记研究",falsification:"未通过，不产生订单"}))
].map(v=>Object.freeze({...v,createdAt,dataVersion:null,parameterVersion:REVISION})));
const preregistration = Object.freeze({createdAt,minOutOfSampleTrades:30,minExpectancyR:0,minStressExpectancyR:0,maxProfitConcentration:.5,confidence:.95,livePromotion:"NEVER_AUTOMATIC",dataPolicy:"冻结数据哈希与切分，不用样本外选择参数"});
const experiments = Object.freeze(["H01_BASE","RANDOM","SIMPLE_BREAKOUT","NO_REGIME","NO_WEEKEND","NO_VOLUME","NO_EFFICIENCY","NO_CROSSES","NO_LIQUIDITY","NO_ADX","WEEKEND_A","WEEKEND_B","WEEKEND_C","ADX_20","ADX_24","COST_STRESS"].map(id=>Object.freeze({id,createdAt,revision:REVISION,hash:hash({id,revision:REVISION}),sampleType:"historical_backtest"})));
function variant(base,id) {
 if(!experiments.some(e=>e.id===id))throw Error("实验未预注册");
 const config={...base};
 if(id==="WEEKEND_A"||id==="NO_WEEKEND")config.weekendMode="A";
 if(id==="WEEKEND_B")config.weekendMode="B";if(id==="WEEKEND_C")config.weekendMode="C";
 if(id==="ADX_20")config.adxMin=20;if(id==="ADX_24")config.adxMin=24;
 if(id==="COST_STRESS"){config.feeRate*=2;config.slippageBps*=2;config.stressSlippageBps*=2;config.fundingEstimatePer8h*=2;}
 return {id,config,omitRegime:["NO_REGIME","SIMPLE_BREAKOUT","RANDOM"].includes(id),omitVolume:["NO_VOLUME","SIMPLE_BREAKOUT","RANDOM"].includes(id),omitEfficiency:["NO_EFFICIENCY","SIMPLE_BREAKOUT","RANDOM"].includes(id),omitCrosses:["NO_CROSSES","SIMPLE_BREAKOUT","RANDOM"].includes(id),omitLiquidity:id==="NO_LIQUIDITY",omitAdx:id==="NO_ADX",random:id==="RANDOM",stress:id==="COST_STRESS"};
}
const strategies=Object.freeze({[ID]:{id:ID,label:"H01 假设驱动趋势",modes:["Research","Shadow"],allowLive:false,implemented:true}});
module.exports={hypotheses,preregistration,experiments,variant,strategies};
