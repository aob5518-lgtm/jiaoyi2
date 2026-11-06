"use strict";
const crypto = require("crypto");
const ID = "hypothesis_trend_h01", REVISION = "H01_20261106_RESEARCH_V1";
const DEFAULTS = Object.freeze({
  riskPerTrade: .003, dailyLossLimit: .02, portfolioRiskLimit: .015, maxPositions: 2,
  maxLeverage: 10, marginFraction: .5, stopAtr: 2, trailActivationR: 1.5, trailAtr: 3,
  adxMin: 22, volumeMultiplier: 1.2, breakoutLookback: 20, cooldownHours: 8,
  weekendMode: "B", maxSpreadBps: 10, maxQuoteAgeMs: 5000, maxEntryAgeMs: 1800000,
  maxEntryExtensionAtr: .5, highVolAtrRatio: 3, maxAtrPct: .05,
  minEfficiency: .2, maxCrosses: 4, minDepthNotional: 10000,
  feeRate: .0005, slippageBps: 5, stressSlippageBps: 25, maxCostR: .2,
  fundingReserveRate: .0003, fundingEstimatePer8h: .0001,
  timeStopHours: 0, reversalExit: false
});
function normalize(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("配置必须为对象");
  for (const k of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, k)) throw Error("不支持的配置字段: " + k);
  const c = {...DEFAULTS, ...input};
  for (const [k,v] of Object.entries(c)) if (typeof DEFAULTS[k] === "number" && (!Number.isFinite(v) || v < 0)) throw Error("配置数值无效: " + k);
  if (!["A","B","C"].includes(c.weekendMode)) throw Error("周末模式无效");
  if (typeof c.reversalExit !== "boolean") throw Error("反转退出配置无效");
  if (!(c.riskPerTrade > 0 && c.riskPerTrade <= .003 && c.dailyLossLimit > 0 && c.dailyLossLimit <= .02 && c.portfolioRiskLimit > 0 && c.portfolioRiskLimit <= .015)) throw Error("风险上限不可放宽");
  if (!(Number.isInteger(c.maxPositions) && c.maxPositions >= 1 && c.maxPositions <= 2 && c.maxLeverage >= 1 && c.maxLeverage <= 10 && c.marginFraction > 0 && c.marginFraction <= .5)) throw Error("持仓/杠杆上限无效");
  if (!(c.stopAtr > 0 && c.trailAtr > 0 && c.trailActivationR > 0 && c.adxMin >= 0 && c.adxMin <= 100 && c.volumeMultiplier > 0 && c.breakoutLookback >= 2 && Number.isInteger(c.breakoutLookback) && c.breakoutLookback <= 100 && c.maxQuoteAgeMs > 0 && c.maxEntryAgeMs >= 900000 && c.maxEntryAgeMs <= 3600000 && c.maxEntryExtensionAtr > 0 && c.maxSpreadBps > 0 && c.minDepthNotional > 0 && c.feeRate > 0 && c.feeRate < .01 && c.maxCostR > 0 && c.minEfficiency <= 1)) throw Error("研究参数范围无效");
  return c;
}
function canonical(v) { if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v; }
const hash = v => crypto.createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
function scope(config, symbol, mode = "Shadow", experimentId = "H01_H05_PREREG_20261106") {
  if (!["Research","Shadow"].includes(mode)) throw Error("H01 尚未批准真实交易");
  if (!["BTC","ETH"].includes(symbol)) throw Error("仅批准 BTC/ETH 独立验证");
  return {strategyId:ID,strategyRevision:REVISION,hypothesisId:"H01",weekendHypothesisId:"H05",experimentId,configHash:hash({config:normalize(config),symbol,mode,experimentId}),symbol,quoteAsset:"USDT",platform:"binance",mode,allowLive:false};
}
module.exports={ID,REVISION,DEFAULTS,normalize,scope,hash};
