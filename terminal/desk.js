"use strict";
const C = require("./classic-paper");
const {number, historyRows} = require("./model");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "", oversized = false;
    req.on("data", chunk => {
      if (oversized) return;
      body += chunk;
      if (Buffer.byteLength(body) > 16384) {oversized = true;body = "";}
    });
    req.on("end", () => {
      try {
        if (oversized) throw Error();
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
        resolve(parsed);
      } catch {reject(Error("请求内容无效"));}
    });
    req.on("error", reject);
  });
}
function accountRow(account, st, classic) {
  return {
    id: account.id, name: account.name, symbol: account.symbol, quoteAsset: account.quoteAsset,
    platform: account.platform, paper: account.tradeMode === "simulation" && account.simulationEnabled === true,
    strategy: C.eligible(account) ? "经典补仓" : "归档账户",
    ready: !!classic, eligible: C.eligible(account), running: classic?.running ?? !!st?.running,
    hasPosition: classic ? !!classic.position : Number(st?.positionQty || st?.realPositionSize || 0) > 0,
    floating: classic?.floating ?? null, realized: classic?.realized ?? null,
    error: classic?.blocked ? classic.notice : st?.activeError || null
  };
}
async function handle(req, res, parsed, d) {
  const send = (code, data) => d.json(res, code, data);
  const route = parsed.pathname;
  let lock, st, mutating = false;
  try {
    if (req.method === "GET") {
      const account = d.getAccountById(parsed.query.id || d.getCurrentAccount()?.id);
      if (!account) return send(404, {ok: false, error: "账户不存在"});
      const classic = d.classicPaper.view(account);
      if (route === "/api/v4/desk/history") {
        const book = d.classicPaper.get(account.id);
        const items = book ? book.trades : historyRows(d.legacyHistory(account)).map(item => ({
          id: item.voucherId || item.id, time: item.exitTime || item.time, side: item.side,
          entryPrice: item.entryPrice ?? item.averagePrice, exitPrice: item.exitPrice, qty: item.closeQty ?? item.filledQty,
          netPnl: item.netPnl, tradingFee: item.tradingFee, reason: item.closeReason, sampleType: item.sampleType
        }));
        const offset = Math.min(Math.max(0, Math.floor(Number(parsed.query.offset) || 0)), items.length);
        return send(200, {ok: true, total: items.length, items: items.slice(offset, offset + 30)});
      }
      if (route !== "/api/v4/desk") return send(404, {ok: false, error: "接口不存在"});
      st = d.state(account.id);
      const snapshot = classic || d.readOnlyStatus(account, st);
      return send(200, {ok: true, selected: accountRow(account, st, classic),
        accounts: d.accounts().map(a => accountRow(a, d.state(a.id), d.classicPaper.view(a))),
        snapshot, defaultSettings: C.defaults, ledgerBlocked: d.classicPaper.corrupt()});
    }
    if (req.method !== "POST" || !["/api/v4/desk/settings", "/api/v4/desk/control"].includes(route)) return send(405, {ok: false, error: "操作不支持"});
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, {ok: false, error: "请在本站操作"});
    const input = await readBody(req);
    const settings = route.endsWith("/settings");
    if (Object.keys(input).some(key => !(settings ? ["id", "settings"] : ["id", "action", "confirm"]).includes(key))) throw Error("请求字段不支持");
    const account = d.getAccountById(input.id);
    if (!account || !C.eligible(account)) throw Error("经典补仓仅适用于明确的模拟经典账户或未绑定的模拟账户");
    st = d.state(account.id);
    if (!st || st.tickRunning || st.placingOrder || st.terminalMutating) throw Error("正在处理本轮行情，请稍后重试");
    lock = d.lock(account.id);
    if (!lock) throw Error("账户正在处理其他操作");
    st.terminalMutating = mutating = true;
    const book = d.classicPaper.get(account.id);
    if (settings) {
      if (!book) d.verifyLegacyFlat(account, st);
      d.classicPaper.configure(account, input.settings);
    } else if (input.action === "close") {
      if (input.confirm !== true || !book?.position) throw Error("请明确确认平掉已有模拟仓位");
      const price = await d.price(account);
      d.classicPaper.mark(d.getAccountById(account.id), price, Date.now(), true);
    } else {
      if (input.action === "start" && st.riskLock) throw Error("账户风险锁定");
      d.classicPaper.control(account, input.action);
    }
    return send(200, {ok: true, snapshot: d.classicPaper.view(account)});
  } catch (error) {
    return send(400, {ok: false, error: error.message || "操作失败"});
  } finally {
    if (mutating) st.terminalMutating = false;
    if (lock) d.unlock(lock);
  }
}
module.exports = {handle, accountRow};
