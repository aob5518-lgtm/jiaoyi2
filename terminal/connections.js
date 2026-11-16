"use strict";
const crypto = require("crypto");
const secrets = ["privateKey", "apiKey", "apiSecret", "starkPrivateKey", "publicKey", "vault"];
const platforms = new Set(["hyperliquid", "binance", "extended", "hotcoin"]);
const filled = value => typeof value === "string" && value.trim().length > 0;
const Lifecycle=require("./account-lifecycle");

function project(account, running = false) {
  const result = {
    id: account.id, name: account.name, platform: account.platform, symbol: account.symbol,strategyType:account.strategyType,
    quoteAsset: account.quoteAsset, address: account.address || "",
    tradeMode: account.tradeMode, simulationEnabled: account.simulationEnabled === true,
    simulationBalance: account.simulationBalance, running: !!running,
    connectionOnly: account.strategyType === "connection_only",archivedAt:account.archivedAt||null,lifecycleVersion:Lifecycle.version(account)
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
function checkHotcoinCredentials(patch, account = {}) {
  if (Object.keys(patch).some(key => !["apiKey", "apiSecret"].includes(key))) throw Error("Hotcoin 只接受 API Key 和 API Secret");
  if (!(patch.apiKey || account.apiKey) || !(patch.apiSecret || account.apiSecret)) throw Error("请填写 Hotcoin API Key 和 API Secret");
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
  if (req.method !== "POST" || !["/api/v4/connections/create", "/api/v4/connections/update", "/api/v4/connections/check","/api/v4/connections/archive-preview","/api/v4/connections/archive","/api/v4/connections/restore"].includes(route)) {
    return send(405, {ok: false, error: "连接管理操作不支持"});
  }
  if (req.headers.origin) {
    try {if (new URL(req.headers.origin).host !== req.headers.host) return send(403, {ok: false, error: "请在本站操作"});}
    catch {return send(403, {ok: false, error: "来源无效"});}
  }
  let lock, st, mutating=false;
  try {
    const input = await readBody(req);
    if (route.endsWith("/create")) {
      requireFields(input, ["name", "platform", "symbol", "initialEquity", "accountMode","confirmLive", "address", ...secrets]);
      const mode=input.accountMode??"paper";
      if(!["paper","live"].includes(mode)||mode==="live"&&input.confirmLive!==true)throw Error("请明确确认创建真实账户连接；不会自动开启策略");
      if(mode==="live"&&input.initialEquity!==undefined)throw Error("真实账户权益由交易所读取，不能填写模拟资金");
      if (!platforms.has(input.platform)) throw Error("交易所不支持");
      const credentials = credentialPatch(input);
      if (input.platform === "hotcoin") {
        if (mode !== "live") throw Error("Hotcoin 当前仅支持真实账户只读连接");
        checkHotcoinCredentials(credentials);
      }
      const name = String(input.name || "").trim(), symbol = String(input.symbol || "ETH").toUpperCase();
      const balance = Number(input.initialEquity ?? 10000);
      if (!name || name.length > 60 || !["ETH", "BTC", "SOL", "BNB"].includes(symbol) || !Number.isFinite(balance) || balance < 100 || balance > 10000000) throw Error("账户名称、标的或模拟权益无效");
      const account = {
        id: crypto.randomUUID(), name, platform: input.platform, symbol,
        quoteAsset: ["binance", "hotcoin"].includes(input.platform) ? "USDT" : input.platform === "extended" ? "USD" : "USDC",
        strategyType: "connection_only", strategyMode: "未绑定策略", running: false,
        tradeMode: mode==="live"?"live":"simulation", simulationEnabled: mode==="paper", ...(mode==="paper"?{simulationBalance:balance}:{}),
        simulationSlippageBps: 5, interval: 15000, side: "long", leverage: 1,
        maxAdds: 0, baseAmount: 0, addAmount: 0, takeProfit: .01, addTrigger: .01,
        ...credentials
      };
      const config = d.configuration();
      config.accounts.push(account);
      d.save(config);
      return send(200, {ok: true, account: project(account), message: mode==="live"?"真实账户连接已创建，保持停止；未启用实盘策略或提交订单":"模拟账户已创建，保持停止；可继续配置经典策略"});
    }
    if(["archive-preview","archive","restore"].some(s=>route.endsWith("/"+s))){
      const action=route.split("/").at(-1);
      requireFields(input,action==="archive-preview"?["id"]:["id","confirm","expectedVersion",...(action==="archive"?["pausePaper"]:[])]);
      const account=d.getAccountById(input.id);if(!account)throw Error("账户不存在");
      st=d.state(account.id);if(!st||st.tickRunning||st.terminalMutating)throw Error("本轮正在更新，请稍后重试");
      lock=d.lock(account.id);if(!lock)throw Error("账户正在执行，请稍后重试");st.terminalMutating=mutating=true;
      if(action==="archive-preview")return send(200,{ok:true,review:await Lifecycle.review(account,d)});
      if(input.confirm!==true||input.expectedVersion!==Lifecycle.version(account))throw Error("账户信息已变化，请重新核对并确认");
      let pausePaper=false;
      if(action==="archive"){
        if(account.archivedAt)throw Error("账户已移出列表");
        const review=await Lifecycle.review(account,d);
        if(!review.allowed)return send(409,{ok:false,error:review.blockers.map(b=>b.message).join("；"),review});
        if(review.pauseRequired&&input.pausePaper!==true)
          return send(409,{ok:false,error:"请确认暂停旧模拟策略并归档",review});
        pausePaper=review.pauseRequired;
      }else if(!account.archivedAt)throw Error("账户已在列表中");
      const next=d.configuration(),index=next.accounts.findIndex(a=>a.id===account.id);
      if(index<0||Lifecycle.version(next.accounts[index])!==input.expectedVersion)throw Error("账户信息已变化，请重新核对并确认");
      next.accounts[index]=Lifecycle.transition(next.accounts[index],action,{pausePaper});
      if(action==="archive"&&next.currentAccountId===account.id)next.currentAccountId=next.accounts.find(a=>!a.archivedAt)?.id||account.id;
      d.save(next);
      return send(200,{ok:true,account:project(next.accounts[index]),message:action==="archive"?(pausePaper?"旧模拟策略已暂停，账户已归档，可恢复":"账户已移出列表，历史、密钥和账本完整保留，可恢复"):"账户已恢复显示，未自动启动"});
    }
    const checking = route.endsWith("/check");
    requireFields(input, checking ? ["id"] : ["id", "name", "address", ...secrets]);
    const account = d.getAccountById(input.id);
    if (!account) throw Error("账户不存在");
    if(account.archivedAt)throw Error("账户已移出列表，请先恢复账户");
    if(["turtle_4h_v1","reversal_4h_v1","funding_carry_v1","pullback_15m_v1","chart_swing_1h_v1"].includes(account.strategyType)&&!checking&&Object.keys(credentialPatch(input)).length)throw Error("独立模拟账户禁止添加交易密钥或地址");
    if (checking) {
      try {
        const summary = await d.checkConnection(account);
        return send(200, {ok: true, readOnly: true, platform: account.platform, checkedAt: summary.checkedAt||Date.now(), summary, message: "原生账户读取成功；未提交订单或验证交易权限"});
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
    st.terminalMutating = mutating = true;
    const patch = credentialPatch(input);
    if (account.platform === "hotcoin" && Object.keys(patch).length) {
      if (account.strategyType !== "connection_only") throw Error("Hotcoin 仅支持只读连接");
      checkHotcoinCredentials(patch, account);
      try {await d.checkConnection({...account,...patch}, {fresh:true});}
      catch {throw Error("新 Hotcoin 凭据未通过原生只读核验，已保留原连接");}
    } else if (!(account.tradeMode === "simulation" && account.simulationEnabled === true) && Object.keys(patch).length) {
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
    d.connectionChanged?.(account.id);
    return send(200, {ok: true, account: project(target), message: "连接已保存，留空凭据保留原值"});
  } catch (error) {
    return send(400, {ok: false, error: error.message});
  } finally {
    if (mutating) st.terminalMutating = false;
    if (lock) d.unlock(lock);
  }
}
module.exports = {handle, project, credentialPatch};
