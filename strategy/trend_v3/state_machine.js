"use strict";

const STATES = Object.freeze(["SCANNING", "TREND_FOUND", "WAIT_PULLBACK", "WAIT_BREAKOUT", "WAIT_RETEST", "WAIT_CONTINUATION", "WAIT_ENTRY_ALIGNMENT", "READY_A", "READY_B", "BLOCKED", "ENTERED", "MANAGING", "DEFENSIVE", "EXITED", "REENTRY_COOLDOWN"]);
function normalizeSetupState(value) { return STATES.includes(value) ? value : "SCANNING"; }
module.exports = { STATES, normalizeSetupState };
