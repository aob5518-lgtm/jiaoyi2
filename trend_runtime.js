"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), T = require("./trend_only");

function createTrendRuntime(d) {
  const file = path.join(d.directory, "trend_only_runtime.json");
  let states = {};
  if (fs.existsSync(file)) states = JSON.parse(fs.readFileSync(file, "utf8")); // Fail closed on corrupted state.
  const approvals = new Map();
  function get(acc) { return states[acc.id] ||= T.initialState(); }
  function save() {
    const tmp = file + ".tmp";
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(states)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  function paper(acc) { return d.isPaper(acc); }
  function account(acc, st) { return { ...acc, paper: paper(acc), equity: Number(st.balance), available: Number(st.available), trendOnlyState: get(acc) }; }
  function log(acc, st, message) {
    st.lastAction = message;
    if (get(acc).lastLog !== message) { d.log(acc.id, message); get(acc).lastLog = message; }
  }
  function publish(acc, st) {
    const s = get(acc), p = s.position;
    st.trendOnly = { ...s, journal: undefined, submittedIds: undefined, position: p, weekendBlocked: T.isWeekendBlocked(Date.now(), T.normalizeConfig(acc.trendOnlyConfig)) };
    st.entryPrice = p?.entryPrice || 0; st.positionQty = p?.positionSize || 0;
    st.positionValueU = st.entryPrice * st.positionQty; st.marginUsedU = p ? st.positionValueU / p.leverage : 0;
    st.addCount = 0; st.nextAddPrice = 0; st.nextAddAmountU = 0; st.nextTakeProfitPrice = 0;
    st.pnl = p ? (st.currentPrice - p.entryPrice) * p.positionSize * (p.side === "long" ? 1 : -1) : 0;
    st.roi = st.marginUsedU ? st.pnl / st.marginUsedU * 100 : 0;
    if (paper(acc)) {
      if (s.simBalance === undefined) s.simBalance = Number(acc.simulationBalance || 10000);
      st.simBalance = s.simBalance; st.balance = s.simBalance + st.pnl; st.available = st.balance - st.marginUsedU;
    }
  }
  async function reconcileExternalExit(acc, st, remote) {
    const s = get(acc), p = s.position;
    if (!p || remote.qty >= p.positionSize || (remote.qty > 0 && remote.side !== p.side)) return false;
    const delta = p.positionSize - remote.qty;
    const seen = new Set(s.externalTradeIds || []);
    let fills;
    if (acc.platform === "hyperliquid") {
      const raw = await info({ type: "userFillsByTime", user: acc.address, startTime: p.entryTime });
      if (!Array.isArray(raw)) return false;
      fills = raw.filter(f => f.coin === acc.symbol && f.dir === (p.side === "long" ? "Close Long" : "Close Short") && !seen.has(String(f.tid)) && !s.journal.some(v => String(v.exchangeOrderId) === String(f.oid)))
        .map(f => ({ id: String(f.tid), qty: Number(f.sz), price: Number(f.px), oid: String(f.oid), time: Number(f.time), hash: f.hash }));
    } else if (acc.platform === "binance") {
      const m = await d.binanceMeta(acc.symbol);
      const raw = await signed(acc, "/fapi/v1/userTrades", { symbol: m.symbol, startTime: String(Math.max(p.entryTime, Date.now() - 7 * 86400000)), limit: "1000" });
      if (!Array.isArray(raw)) return false;
      fills = raw.filter(f => f.side === (p.side === "long" ? "SELL" : "BUY") && !seen.has(String(f.id)) && !s.journal.some(v => String(v.exchangeOrderId) === String(f.orderId)))
        .map(f => ({ id: String(f.id), qty: Number(f.qty), price: Number(f.price), oid: String(f.orderId), time: Number(f.time) }));
    } else return false;
    const qty = fills.reduce((n, f) => n + f.qty, 0);
    if (!(qty > 0) || Math.abs(qty - delta) > 1e-8) return false;
    const fill = { qty, price: fills.reduce((n, f) => n + f.qty * f.price, 0) / qty, clientOrderId: 'exchange-sync-' + fills.map(f => f.id).join('-'), exchangeOrderId: fills.map(f => f.oid).join(','), platformTradeId: fills.map(f => f.id).join(','), txHash: fills[0].hash };
    T.recordClose(account(acc, st), fill, 'exchange_sync_exit', Math.max(...fills.map(f => f.time)));
    s.externalTradeIds = [...seen, ...fills.map(f => f.id)];
    save(); flushJournal(acc); log(acc, st, '交易所外部平仓已核对真实成交，已写入历史凭证'); return true;
  }
  function flushJournal(acc) {
    for (const v of get(acc).journal) d.history(acc.id, { ...v, voucherId: v.id, dedupeKey: v.id, closeQty: v.positionSize, marginUsed: v.positionValue / v.leverage,
      openedAt: v.entryTime, simulation: paper(acc), platformOrderId: v.exchangeOrderId, addCount: 0 });
  }
  async function signed(acc, route, params = {}, method = "GET") {
    const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "5000" }).toString();
    const signature = crypto.createHmac("sha256", acc.apiSecret).update(query).digest("hex");
    return d.request(`https://fapi.binance.com${route}?${query}&signature=${signature}`, { method, headers: { "X-MBX-APIKEY": acc.apiKey } });
  }
  async function info(body) { return d.request("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  async function sync(acc, st) {
    if (paper(acc)) { publish(acc, st); return { qty: get(acc).position?.positionSize || 0, openOrders: [] }; }
    if (acc.platform === "hyperliquid") {
      const [a, orders] = await Promise.all([d.hyperAccount(acc.address, acc.symbol), info({ type: "openOrders", user: acc.address })]);
      if (!Array.isArray(orders) || !Number.isFinite(Number(a.balance))) throw Error("账户同步无效");
      st.balance = Number(a.rawPerp?.marginSummary?.accountValue); st.available = Number(a.rawPerp?.withdrawable);
      if (!Number.isFinite(st.balance) || !Number.isFinite(st.available)) throw Error("无法验证合约账户权益");
      const q = Number(a.currentPos?.szi || 0);
      return { qty: Math.abs(q), side: q < 0 ? "short" : "long", openOrders: orders.filter(o => o.coin === acc.symbol) };
    }
    if (acc.platform === "binance") {
      const meta = await d.binanceMeta(acc.symbol);
      const [a, orders] = await Promise.all([signed(acc, "/fapi/v2/account"), signed(acc, "/fapi/v1/openOrders", { symbol: meta.symbol })]);
      if (!Array.isArray(a.positions) || !Array.isArray(orders)) throw Error("Binance 账户同步失败");
      st.balance = Number(a.totalMarginBalance); st.available = Number(a.availableBalance);
      const positions = a.positions.filter(p => p.symbol === meta.symbol && Number(p.positionAmt) !== 0);
      if (positions.length > 1) throw Error("同一合约存在多空双仓，趋势策略暂停");
      return { qty: Math.abs(Number(positions[0]?.positionAmt || 0)), side: Number(positions[0]?.positionAmt || 0) < 0 ? "short" : "long", openOrders: orders };
    }
    throw Error("Extended Live 暂未通过订单幂等确认验证，请使用 Paper；禁止下单");
  }
  async function constraints(acc) {
    if (acc.platform === "hyperliquid") { const { meta } = await d.hyperMeta(acc.symbol); return { qtyStep: 10 ** -Number(meta.szDecimals), minNotional: 10 }; }
    if (acc.platform === "binance") {
      const m = await d.binanceMeta(acc.symbol), lot = m.filters.find(f => f.filterType === "MARKET_LOT_SIZE" && Number(f.stepSize) > 0) || m.filters.find(f => f.filterType === "LOT_SIZE");
      return { qtyStep: Number(lot.stepSize), minNotional: Number(m.filters.find(f => f.filterType === "MIN_NOTIONAL")?.notional || 5) };
    }
    return { qtyStep: 0.000001, minNotional: 10 };
  }
  async function lookup(acc, o) {
    if (paper(acc)) return o.paperFill ? { terminal: true, fill: o.paperFill } : { terminal: false };
    if (acc.platform === "hyperliquid") {
      const status = await info({ type: "orderStatus", user: acc.address, oid: o.clientOrderId });
      if (status.status !== "order") return { terminal: false };
      const order = status.order.order, state = status.order.status;
      if (["open", "triggered"].includes(state)) return { terminal: false };
      const all = await info({ type: "userFillsByTime", user: acc.address, startTime: o.createdAt - 60000 });
      if (!Array.isArray(all)) return { terminal: false };
      const fills = all.filter(f => String(f.oid) === String(order.oid));
      const qty = fills.reduce((a, f) => a + Number(f.sz), 0);
      const expected = Number(order.origSz) - Number(order.sz);
      if (expected > 0 && Math.abs(qty - expected) > 1e-8) return { terminal: false };
      if (state === "filled" && !qty) return { terminal: false };
      return { terminal: true, fill: qty ? { qty, price: fills.reduce((a, f) => a + Number(f.sz) * Number(f.px), 0) / qty,
        exchangeOrderId: String(order.oid), clientOrderId: o.clientOrderId, platformTradeId: fills.map(f => f.tid).join(","), txHash: fills[0].hash } : null };
    }
    const meta = await d.binanceMeta(acc.symbol);
    const order = await signed(acc, "/fapi/v1/order", { symbol: meta.symbol, origClientOrderId: o.clientOrderId });
    if (!["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(order.status)) return { terminal: false };
    const qty = Number(order.executedQty), price = Number(order.avgPrice);
    if (qty > 0 && !(price > 0)) return { terminal: false };
    return { terminal: true, fill: qty ? { qty, price, exchangeOrderId: String(order.orderId), clientOrderId: o.clientOrderId } : null };
  }
  function settle(acc, st, o, result) {
    const s = get(acc);
    if (!result.terminal) { o.status = "unknown_order_state"; save(); return false; }
    if (result.fill) {
      if (o.kind === "open") {
        s.position = T.positionFromFill(o.plan, result.fill, o.createdAt, o.config);
        s.lastEntrySignalTime = o.plan.signal.signalTime;
        log(acc, st, `趋势开仓成功：${acc.symbol} ${s.position.side === "long" ? "做多" : "做空"}，${s.position.leverage}倍杠杆，入场价 ${s.position.entryPrice}，初始止损 ${s.position.initialStopLossPrice}`);
      } else {
        const v = T.recordClose(account(acc, st), result.fill, o.reason);
        if (paper(acc)) s.simBalance += v.pnl;
        log(acc, st, `趋势平仓成交：${o.reason}，数量 ${result.fill.qty}，净盈亏 ${v.pnl.toFixed(4)}`);
      }
    } else log(acc, st, "交易所已确认订单结束且无成交，等待新的信号或下一次退出检查");
    s.pendingOrder = null;
    save(); flushJournal(acc); publish(acc, st);
    return true;
  }
  async function submit(acc, st, kind, plan, reason = "") {
    const s = get(acc);
    if (s.pendingOrder) throw Error("已有 pendingOrder，禁止提交");
    const c = T.normalizeConfig(acc.trendOnlyConfig), id = "0x" + crypto.randomBytes(16).toString("hex");
    const p = s.position, side = kind === "open" ? plan.side : p.side, qty = kind === "open" ? plan.qty : p.positionSize;
    if (!paper(acc) && kind === "open") {
      const approval = approvals.get(acc.id);
      if (!approval || approval.signalTime !== plan.signal.signalTime || approval.expires < Date.now() || approval.configHash !== configHash(acc)) throw Error("Live 本次信号尚未确认");
      approvals.delete(acc.id);
      if (acc.platform === "hyperliquid") await d.hyperLeverage({ ...acc, leverage: c.leverage });
      else if (acc.platform === "binance") {
        const m = await d.binanceMeta(acc.symbol), r = await signed(acc, "/fapi/v1/leverage", { symbol: m.symbol, leverage: String(c.leverage) }, "POST");
        if (Number(r.leverage) !== c.leverage) throw Error("杠杆同步失败，禁止开仓");
      } else throw Error("当前平台没有经过验证的 Live 趋势下单适配器");
    }
    const o = { clientOrderId: id, kind, plan, reason, config: c, qty, side, createdAt: Date.now(), status: "pending" };
    if (s.submittedIds.includes(id)) throw Error("clientOrderId 已提交");
    s.submittedIds.push(id); s.pendingOrder = o;
    if (kind === "open") s.lastEntrySignalTime = plan.signal.signalTime;
    if (paper(acc)) {
      const sign = (side === "long" ? 1 : -1) * (kind === "open" ? 1 : -1);
      o.paperFill = { qty, price: Number(st.currentPrice) * (1 + sign * Number(acc.simulationSlippageBps || 0) / 10000), clientOrderId: id, exchangeOrderId: `paper-${id}` };
    }
    save(); // Durable intent MUST precede the first external request.
    try {
      if (paper(acc)) return settle(acc, st, o, { terminal: true, fill: o.paperFill });
      const orderSide = (side === "long") === (kind === "open") ? "buy" : "sell";
      if (acc.platform === "hyperliquid") {
        await d.hyperOrder({ account: { ...acc, leverage: c.leverage }, symbol: acc.symbol, side: orderSide, size: qty, reduceOnly: kind === "close", tif: "Ioc", clientOrderId: id });
      } else {
        const m = await d.binanceMeta(acc.symbol), mode = await signed(acc, "/fapi/v1/positionSide/dual");
        if (typeof mode.dualSidePosition !== "boolean") throw Error("无法确认 Binance 持仓模式");
        const params = { symbol: m.symbol, side: orderSide.toUpperCase(), type: "MARKET", quantity: String(qty), newClientOrderId: id, newOrderRespType: "RESULT" };
        if (mode.dualSidePosition) params.positionSide = side.toUpperCase(); else if (kind === "close") params.reduceOnly = "true";
        await signed(acc, "/fapi/v1/order", params, "POST");
      }
      return settle(acc, st, o, await lookup(acc, o));
    } catch (e) {
      o.status = "unknown_order_state"; save();
      log(acc, st, "订单结果未知，保留 pendingOrder；先查询交易所状态，禁止重新下单");
      return false;
    }
  }
  function configHash(acc) { return crypto.createHash("sha256").update(JSON.stringify([acc.id, acc.platform, acc.symbol, acc.tradeMode, acc.simulationEnabled, T.normalizeConfig(acc.trendOnlyConfig)])).digest("hex"); }
  async function tick(acc, st, action) {
    const s = get(acc), c = T.normalizeConfig(acc.trendOnlyConfig);
    try {
      st.currentPrice = await d.price(acc); publish(acc, st); flushJournal(acc);
      if (s.pendingOrder) {
        if (!settle(acc, st, s.pendingOrder, await lookup(acc, s.pendingOrder))) { log(acc, st, "未知订单状态：查询中，禁止重复下单"); return; }
      }
      const remote = await sync(acc, st);
      if (s.position && (Math.abs(remote.qty - s.position.positionSize) > 1e-8 || (!paper(acc) && remote.side !== s.position.side))) {
        if (!await reconcileExternalExit(acc, st, remote)) { s.syncMismatch = true; log(acc, st, "交易所仓位与趋势记录不一致：保留原始凭证并暂停下单，需核对外部成交"); return; }
      }
      if (!s.position && remote.qty > 0) { log(acc, st, "存在非趋势策略仓位，禁止接管或新开仓"); return; }
      s.syncMismatch = false;
      if (action === "manual_close") { if (!s.position) throw Error("当前没有趋势仓位"); await submit(acc, st, "close", null, "manual_close"); return; }
      // Manage price stops before fetching candles; missing indicators must not disable the hard stop.
      if (s.position) {
        const protection = T.manageTrendOnlyPosition(account(acc, st), { price: st.currentPrice });
        protection.logs.forEach(m => log(acc, st, m)); save();
        if (protection.reason) { await submit(acc, st, "close", null, protection.reason); return; }
      }
      let i;
      try {
        const sets = await Promise.all([c.entryTimeframe, c.trendTimeframe, c.higherTimeframe].map(tf => d.candles(acc.symbol, tf, 300, acc.platform)));
        if (sets.some(x => x.stale)) throw Error("行情过期或使用跨交易所备用行情");
        const values = sets.map((x, n) => T.indicatorsFor(x.candles, c, [c.entryTimeframe, c.trendTimeframe, c.higherTimeframe][n]));
        i = { ...values[0], config: c, trendDirection: T.directionOf(values[1]), higherDirection: T.directionOf(values[2]), price: Number(st.currentPrice) };
        s.signal = T.detectMarketRegime(i.candles, i);
        s.indicators = { atr: i.atr, adx: i.adx, chop: i.chop, trendDirection: i.trendDirection, higherDirection: i.higherDirection };
      } catch (e) { log(acc, st, `趋势行情暂不可用：${e.message}；已有价格止损继续执行`); return; }
      if (s.position) {
        const result = T.manageTrendOnlyPosition(account(acc, st), { price: st.currentPrice }, i);
        result.logs.forEach(m => log(acc, st, m)); save();
        if (result.reason) await submit(acc, st, "close", null, result.reason);
        else log(acc, st, s.position.trailingActive ? "移动止盈中" : s.position.breakEvenActivated ? "已保本，等待趋势延续" : "已开仓，等待 1R");
        return;
      }
      if (!st.running) { log(acc, st, "趋势监控已停止，禁止新开仓"); return; }
      if (d.conflictingAccount?.(acc)) { log(acc, st, "同一交易账户与合约已被其他策略占用，禁止新开仓"); return; }
      if (remote.openOrders.length) { log(acc, st, "交易所存在挂单，禁止新开仓"); return; }
      const approval = approvals.get(acc.id);
      const confirmed = approval && approval.signalTime === s.signal.signalTime && approval.expires >= Date.now() && approval.configHash === configHash(acc);
      const a = { ...account(acc, st), confirmLive: !!confirmed };
      const bounds = await constraints(acc);
      const preview = T.tryOpenTrendOnlyPosition({ ...a, confirmLive: true }, s.signal, { ...i, ...bounds });
      s.preview = preview.allowed ? { ...preview, expires: Date.now() + 60000, configHash: configHash(acc) } : null;
      const plan = T.tryOpenTrendOnlyPosition(a, s.signal, { ...i, ...bounds });
      if (!plan.allowed) { log(acc, st, plan.reason); return; }
      await submit(acc, st, "open", plan);
    } finally { publish(acc, st); save(); }
  }
  function confirm(acc, body) {
    const s = get(acc), p = s.preview;
    if (paper(acc) || body.confirmLive !== true || !p || p.expires < Date.now() || body.signalTime !== p.signal.signalTime || body.configHash !== configHash(acc)) throw Error("Live 确认无效或信号已过期，请刷新后重新确认");
    approvals.set(acc.id, { signalTime: p.signal.signalTime, configHash: configHash(acc), expires: Date.now() + 60000 });
  }
  return { get, save, tick, publish, confirm, clearApproval: id => approvals.delete(id), busy: acc => !!(get(acc).position || get(acc).pendingOrder) };
}
module.exports = { createTrendRuntime };
