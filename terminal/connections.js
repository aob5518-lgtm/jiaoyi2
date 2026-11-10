"use strict";
const crypto = require("crypto");
const secrets = ["privateKey", "apiKey", "apiSecret", "starkPrivateKey", "publicKey", "vault"];
const platforms = new Set(["hyperliquid", "binance", "extended"]);
const filled = value => typeof value === "string" && value.trim().length > 0;

function project(account, running = false) {
  const result = {
    id: account.id, name: account.name, platform: account.platform, symbol: account.symbol,
    quoteAsset: account.quoteAsset, address: account.address || "",
    tradeMode: account.tradeMode, simulationEnabled: account.simulationEnabled === true,
    simulationBalance: account.simulationBalance, running: !!running,
    connectionOnly: account.strategyType === "connection_only"
  };
  for (const key of secrets) result["has" + key[0].toUpperCase() + key.slice(1)] = filled(account[key]);
  return result;
}
function requireFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    throw Error("请求包含不允许的字段");
  }
}
function credentialPatch(input) {
  const result = {};
  for (const key of ["address", ...secrets]) {
    if (input[key] === undefined || input[key] === null || input[key] === "") continue;
    if (typeof input[key] !== "string" || input[key].length > 4096) throw Error("连接字段格式无效");
    if (input[key].trim()) result[key] = input[key].trim();
  }
  return result;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "", oversized = false;
    req.on("data", part => {body += part;if (Buffer.byteLength(body) > 32768) {oversized = true;body = "";}});
    req.on("end", () => {try {if (oversized) throw Error("请求过大");resolve(JSON.parse(body || "{}"));} catch {reject(Error("请求格式无效或超过限制"));}});
    req.on("error", reject);
  });
}
async function handle(req, res, parsed, d) {
  const send = (code, data) => d.json(res, code, data);
  const route = parsed.pathname;
  if (req.method === "GET" && route === "/api/v4/connections") {
    return send(200, {ok: true, currentAccountId: d.getCurrentAccount()?.id, accounts: d.accounts().map(account => project(account, d.classicPaper?.get(account.id)?.running ?? d.state(account.id)?.running))});
  }
  if (req.method !== "POST" || !["/api/v4/connections/create", "/api/v4/connections/update", "/api/v4/connections/check"].includes(route)) {
    return send(405, {ok: false, error: "连接管理操作不支持"});
  }
  if (req.headers.origin) {
    try {if (new URL(req.headers.origin).host !== req.headers.host) return send(403, {ok: false, error: "请在本站操作"});}
    catch {return send(403, {ok: false, error: "来源无效"});}
  }
  let lock, st;
  try {
    const input = await readBody(req);
    if (route.endsWith("/create")) {
      requireFields(input, ["name", "platform", "symbol", "initialEquity", "address", ...secrets]);
      if (!platforms.has(input.platform)) throw Error("交易所不支持");
      const name = String(input.name || "").trim(), symbol = String(input.symbol || "ETH").toUpperCase();
      const balance = Number(input.initialEquity ?? 10000);
      if (!name || name.length > 60 || !["ETH", "BTC", "SOL", "BNB"].includes(symbol) || !Number.isFinite(balance) || balance < 100 || balance > 10000000) throw Error("账户名称、标的或模拟权益无效");
      const account = {
        id: crypto.randomUUID(), name, platform: input.platform, symbol,
        quoteAsset: input.platform === "binance" ? "USDT" : input.platform === "extended" ? "USD" : "USDC",
        strategyType: "connection_only", strategyMode: "未绑定策略", running: false,
        tradeMode: "simulation", simulationEnabled: true, simulationBalance: balance,
        simulationSlippageBps: 5, interval: 15000, side: "long", leverage: 1,
        maxAdds: 0, baseAmount: 0, addAmount: 0, takeProfit: .01, addTrigger: .01,
        ...credentialPatch(input)
      };
      const config = d.configuration();
      config.accounts.push(account);
      d.save(config);
      return send(200, {ok: true, account: project(account), message: "连接账户已创建，保持停止且未绑定交易策略"});
    }
    const checking = route.endsWith("/check");
    requireFields(input, checking ? ["id"] : ["id", "name", "address", ...secrets]);
    const account = d.getAccountById(input.id);
    if (!account) throw Error("账户不存在");
    if (checking) {
      try {
        const summary = await d.checkConnection(account);
        return send(200, {ok: true, readOnly: true, platform: account.platform, checkedAt: Date.now(), summary, message: "原生账户读取成功；未提交订单或验证交易权限"});
      } catch {
        return send(400, {ok: false, error: "原生账户读取失败，请核对所选交易所、API 凭据、IP 白名单或网络。密钥未返回浏览器。"});
      }
    }
    st = d.state(account.id);
    const trend = /^trend_only_v[123]$/.test(account.strategyType || "") ? d.trend?.get(account) || {} : {};
    const compoundBusy = account.strategyType === "compound_4h_v1" && d.compound?.busy(account);
    const classic = d.classicPaper?.get(account.id);
    if (classic?.running || classic?.position) throw Error("请暂停并结清经典模拟仓位后更新连接");
    if (!st || st.running || st.tickRunning || st.placingOrder || st.pendingOrder || st.smartExitPending || Number(st.positionQty) > 0 || trend.position || trend.pendingOrder || compoundBusy) throw Error("请先停止监控并完成现有仓位与订单核对，再更改连接");
    lock = d.lock(account.id);
    if (!lock) throw Error("账户正在执行，请稍后重试");
    st.terminalMutating = true;
    const patch = credentialPatch(input);
    if (!(account.tradeMode === "simulation" && account.simulationEnabled === true) && Object.keys(patch).length) {
      try {await d.verifyLiveFlat(account);} catch {throw Error("Live 账户原生空仓与挂单核验未通过，连接修改已阻止");}
    }
    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 60) throw Error("账户名称无效");
      patch.name = input.name.trim();
    }
    const config = d.configuration();
    const target = config.accounts.find(item => item.id === account.id);
    Object.assign(target, patch);
    d.save(config);
    return send(200, {ok: true, account: project(target), message: "连接已保存，留空凭据保留原值"});
  } catch (error) {
    return send(400, {ok: false, error: error.message});
  } finally {
    if (st) st.terminalMutating = false;
    if (lock) d.unlock(lock);
  }
}
module.exports = {handle, project, credentialPatch};
