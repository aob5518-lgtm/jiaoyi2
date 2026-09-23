"use strict";

const V2 = require("../../trend_only_v2");

function compareV2Shadow(accountId, input, v3Signal) {
  const v2Input = { ...input, config: V2.normalizeConfig(input.config) };
  const v2 = V2.detectMarketRegime(v2Input.candles || [], v2Input);
  return {
    time: v3Signal.signalTime,
    accountId,
    postHocOnly: true,
    shadowOrderAllowed: false,
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

module.exports = { compareV2Shadow };
