"use strict";
const crypto = require("crypto");
const files = ["profit_history.json", "simulation_orders.json", "smart_runtime.json", "trend_only_runtime.json", "compound_4h_runtime.json"];
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function plan(config, ledgers) {
  if (!config || !Array.isArray(config.accounts)) throw Error("账户配置格式无效");
  const nextConfig = structuredClone(config);
  const targets = nextConfig.accounts.filter(account => account.tradeMode === "simulation" && account.simulationEnabled === true);
  const selected = new Set(targets.map(account => account.id));
  if (!targets.length || selected.size !== targets.length) throw Error("没有明确的模拟账户或账户 ID 重复");
  const nextLedgers = {}, removed = {};
  for (const account of targets) {
    if (!Number.isFinite(Number(account.simulationBalance)) || Number(account.simulationBalance) <= 0) throw Error("模拟初始权益缺失，不能推定复原金额");
    account.running = false;
  }
  for (const [file, values] of Object.entries(ledgers)) {
    if (!files.includes(file) || !values || typeof values !== "object" || Array.isArray(values)) throw Error("账本格式不支持");
    const copy = structuredClone(values);
    removed[file] = 0;
    for (const id of selected) {
      if (Object.hasOwn(copy, id)) {
        removed[file] += Array.isArray(copy[id]) ? copy[id].length : 1;
        delete copy[id];
      }
    }
    for (const id of Object.keys(values)) if (!selected.has(id) && hash(copy[id]) !== hash(values[id])) throw Error("非模拟账户账本发生变化");
    nextLedgers[file] = copy;
  }
  for (let index = 0; index < config.accounts.length; index++) {
    const old = config.accounts[index], next = nextConfig.accounts[index];
    const expected = selected.has(old.id) ? {...old, running: false} : old;
    if (hash(next) !== hash(expected)) throw Error("账户身份、参数或密钥发生变化");
  }
  return {
    config: nextConfig, ledgers: nextLedgers,
    report: {
      resetAccounts: targets.map(account => ({id: account.id, name: account.name, initialEquity: account.simulationBalance})),
      skippedAccounts: config.accounts.filter(account => !selected.has(account.id)).map(account => ({id: account.id, name: account.name, reason: "非明确模拟模式，原值保留"})),
      removed, mode: "authorized_paper_reset", realOrdersSubmitted: false
    }
  };
}
module.exports = {plan, files};
