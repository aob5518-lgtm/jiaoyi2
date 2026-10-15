"use strict";
const crypto = require("crypto");
const REVISION = "V3_20261015_CONFIRM_COST", EXPERIMENT = "V3_STD_20261015_C";
function configHash(config) { return crypto.createHash("sha256").update(JSON.stringify({ ...config, strategyRevision: REVISION })).digest("hex"); }
function scopeFor(config) { return { strategyVersion: "trend_only_v3", strategyRevision: REVISION, experimentId: config.experimentId, configHash: configHash(config) }; }
function matches(item, scope) { return ["strategyVersion", "strategyRevision", "experimentId", "configHash"].every(key => !scope[key] || scope[key] === "all" || (key==="strategyRevision"&&scope[key]==="unknown"?!item[key]:item[key] === scope[key])); }
module.exports = { REVISION, EXPERIMENT, configHash, scopeFor, matches };
