"use strict";

const V2 = require("../../trend_only_v2");
const crypto = require("crypto");

const SHADOW_BASELINE_ID = "V2_STANDARD_20260922";
const SHADOW_V2_CONFIG_SNAPSHOT = Object.freeze(V2.normalizeConfig({
  version: "v2", chopIdealMax: 45, chopTransitionMax: 55, chopHardBlock: 61.8,
  adxTrendStart: 22, adxTrendValid: 28, adxStrong: 32, adxVeryStrong: 40,
  minDiSpread: 8, higherTimeframeMode: "not_against", maxEntryExtensionAtr: 1.5,
  minStopDistanceAtr: 1.2, riskPerTrade: 0.01
}));
const SHADOW_CONFIG_HASH = crypto.createHash("sha256").update(JSON.stringify(SHADOW_V2_CONFIG_SNAPSHOT)).digest("hex");

function compareV2Shadow(accountId, input, v3Signal) {
  const v2Input = { ...input, config: SHADOW_V2_CONFIG_SNAPSHOT };
  const v2 = V2.detectMarketRegime(v2Input.candles || [], v2Input);
  return {
    time: v3Signal.signalTime,
    accountId,
    postHocOnly: true,
    shadowOrderAllowed: false,
    shadowBaselineId: SHADOW_BASELINE_ID,
    shadowConfigHash: SHADOW_CONFIG_HASH,
    v2Decision: v2.entryPermission,
    v3Decision: v3Signal.entryPermission,
    v2Blockers: [...(v2.blockers || [])],
    v3Score: v3Signal.trendScore,
    v2Setup: v2.entryMode,
    v3Setup: v3Signal.entryMode,
    v2TheoreticalEntry: v2.entryPermission === "allowed" ? input.close : null,
    v3TheoreticalEntry: v3Signal.entryPermission === "allowed" ? input.close : null
  };
}

module.exports = { SHADOW_BASELINE_ID, SHADOW_V2_CONFIG_SNAPSHOT, SHADOW_CONFIG_HASH, compareV2Shadow };
