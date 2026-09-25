"use strict";

function buildDecisionFunnel(signal, execution = {}) {
  const unified = execution.executionEvaluation || execution;
  if (["data", "trend", "environment", "setup", "cost", "rewardSpace", "risk", "execution"].some(key => unified[key])) {
    const labels = { data: "数据", trend: "主趋势", environment: "市场环境", setup: "Entry Setup", cost: "成本", rewardSpace: "前方空间", risk: "风控", execution: "执行" };
    return Object.keys(labels).map(key => ({ key, label: labels[key], status: unified[key] || "WAITING" }));
  }
  const blocked = new Set(signal.hardBlockers || []);
  return [
    { key: "data", label: "数据", status: blocked.size && [...blocked].some(v => /数据|行情/.test(v)) ? "BLOCK" : "PASS" },
    { key: "trend", label: "主趋势", status: signal.directionRaw === "none" ? "WAITING" : "PASS" },
    { key: "environment", label: "市场环境", status: Number(signal.scoreBreakdown?.environment || 0) <= 2 ? "CONDITIONAL" : "PASS" },
    { key: "setup", label: "Entry Setup", status: signal.entryPermission === "allowed" ? "PASS" : signal.setupState === "BLOCKED" ? "BLOCK" : "WAITING" },
    { key: "cost", label: "成本", status: execution.costBlocked ? "BLOCK" : signal.entryPermission === "allowed" ? "PASS" : "WAITING" },
    { key: "rewardSpace", label: "前方空间", status: execution.potentialRBlocked ? "BLOCK" : "WAITING" },
    { key: "risk", label: "风控", status: execution.riskBlocked ? "BLOCK" : "PASS" },
    { key: "execution", label: "执行", status: execution.executionBlocked ? "BLOCK" : signal.entryPermission === "allowed" ? "PASS" : "WAITING" }
  ];
}

module.exports = { buildDecisionFunnel };
