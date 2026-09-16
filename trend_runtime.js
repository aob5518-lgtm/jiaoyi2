"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), V1 = require("./trend_only"), V2 = require("./trend_only_v2");

function createTrendRuntime(d) {
  const file = path.join(d.directory, "trend_only_runtime.json");
  let states = {};
  if (fs.existsSync(file)) states = JSON.parse(fs.readFileSync(file, "utf8")); // Fail closed on corrupted state.
  const approvals = new Map();
  function isV2(acc) { return acc?.strategyType === "trend_only_v2"; }
  function engine(acc) { return isV2(acc) ? V2 : V1; }
  function get(acc) {
    const initial = engine(acc).initialState();
    const state = states[acc.id] ||= initial;
    for (const [key, value] of Object.entries(initial)) if (state[key] === undefined) state[key] = value;
    return state;
  }
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
  function annotateSignal(acc, reason, finalAction) {
    if (!isV2(acc)) return;
    const s = get(acc), item = (s.signalJournal || []).findLast?.(entry => entry.time === s.signal?.signalTime) || (s.signalJournal || []).at(-1);
    if (!item || item.time !== s.signal?.signalTime) return;
    item.finalAction = finalAction || reason || item.finalAction;
    if (reason && !(item.blockers || []).includes(reason)) item.blockers = [...(item.blockers || []), reason];
  }
  function publish(acc, st) {
    const s = get(acc), p = s.position;
    const T = engine(acc), weekendBlocked = T.isWeekendBlocked(Date.now(), T.normalizeConfig(acc.trendOnlyConfig));
    const rawStopOrderPrice = s.stopOrderPrice ?? s.stopSyncedPrice;
    const stopOrderPrice = rawStopOrderPrice === null || rawStopOrderPrice === undefined || rawStopOrderPrice === "" ? null : Number(rawStopOrderPrice);
    const signal = s.signal || {
      regime: "data_insufficient",
      direction: "none", directionRaw: "none", tradeDirection: "none", entryPermission: "blocked", blockers: [],
      score: 0,
      reasons: [weekendBlocked ? "周末过滤：当前为周六/周日，禁止新开仓" : (s.lastLog || "行情数据不足，等待已收盘 K 线")]
    };
    const indicators = s.indicators || { atr: null, adx: null, chop: null, trendDirection: "none", higherDirection: "none" };
    st.trendOnly = {
      weekendBlocked,
      signal,
      indicators,
      position: p || null,
      preview: s.preview || null,
      pendingOrder: s.pendingOrder || null,
      syncMismatch: !!s.syncMismatch,
      lastLog: s.lastLog || "",
      dailyLoss: Number(s.dailyLoss || 0),
      consecutiveLosses: Number(s.consecutiveLosses || 0),
      pauseUntil: Number(s.pauseUntil || 0),
      trendContext: s.trendContext || null,
      signalJournal: (s.signalJournal || []).slice(-50).reverse(),
      riskLock: !!s.riskLock,
      riskLockReason: s.riskLockReason || "",
      stopOrderId: s.stopOrderId || "",
      stopSyncStatus: s.stopSyncStatus || "not_required",
      stopOrderPrice: Number.isFinite(stopOrderPrice) ? stopOrderPrice : null,
      stopLastSyncAt: Number(s.stopLastSyncAt || s.stopLastSyncedAt || 0),
      // Old dashboard aliases remain during rolling upgrades.
      stopLastSyncedAt: Number(s.stopLastSyncAt || s.stopLastSyncedAt || 0),
      stopSyncedPrice: Number.isFinite(stopOrderPrice) ? stopOrderPrice : null
    };
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
    const T = engine(acc);
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
    if (isV2(acc)) { await cancelProtectiveStop(acc, s, { ignoreFailure: true }); s.riskLock = false; s.riskLockReason = ""; }
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
  function decimalPlaces(step) { const text = String(step); return text.includes("e-") ? Number(text.split("e-")[1]) : (text.split(".")[1] || "").length; }
  function formatPriceStep(value, step, roundUp = false) {
    const unit = Number(step || 0.00000001), scaled = Number(value) / unit;
    return ((roundUp ? Math.ceil(scaled - 1e-10) : Math.floor(scaled + 1e-10)) * unit).toFixed(decimalPlaces(unit));
  }
  function remoteHasStop(remote, orderId) {
    if (!orderId) return false;
    return (remote.openOrders || []).some(order => String(order.oid ?? order.algoId ?? order.orderId ?? order.id) === String(orderId));
  }
  function clearStopState(s) {
    s.stopOrderId = ""; s.stopClientOrderId = ""; s.stopSyncStatus = "not_required"; s.stopLastSyncAt = Date.now(); s.stopOrderPrice = null; s.stopSyncedPrice = null; s.stopLastSyncedAt = s.stopLastSyncAt;
  }
  async function cancelProtectiveStop(acc, s, { ignoreFailure = false } = {}) {
    const orderId = s.stopOrderId;
    if (!orderId || paper(acc)) { clearStopState(s); return true; }
    try {
      if (acc.platform === "hyperliquid") await d.hyperCancel({ account: acc, symbol: acc.symbol, orderId });
      else if (acc.platform === "binance") { const meta = await d.binanceMeta(acc.symbol); await signed(acc, "/fapi/v1/algoOrder", { symbol: meta.symbol, algoId: String(orderId) }, "DELETE"); }
      clearStopState(s); return true;
    } catch (error) {
      if (!ignoreFailure) throw error;
      s.stopSyncStatus = "cancel_unconfirmed"; s.stopLastSyncAt = Date.now(); return false;
    }
  }
  async function syncProtectiveStop(acc, st, force = false) {
    const s = get(acc), p = s.position;
    if (!isV2(acc) || !p) return true;
    const desired = Number(p.currentStopLossPrice);
    if (!(desired > 0)) return false;
    if (!force && s.stopSyncStatus === "synced" && Number(s.stopOrderPrice ?? s.stopSyncedPrice) === desired && s.stopOrderId) return true;
    const oldOrderId = s.stopOrderId, clientOrderId = "0x" + crypto.randomBytes(16).toString("hex");
    s.stopSyncStatus = "syncing"; s.stopLastSyncAt = Date.now(); save();
    try {
      let placed;
      if (paper(acc)) placed = { orderId: `paper-stop-${clientOrderId}`, stopPrice: desired };
      else if (acc.platform === "hyperliquid") placed = await d.hyperStop({ account: acc, symbol: acc.symbol, side: p.side === "long" ? "sell" : "buy", size: p.positionSize, stopPrice: desired, clientOrderId });
      else if (acc.platform === "binance") {
        const meta = await d.binanceMeta(acc.symbol), mode = await signed(acc, "/fapi/v1/positionSide/dual");
        if (typeof mode.dualSidePosition !== "boolean") throw Error("无法确认 Binance 持仓模式");
        const tick = Number(meta.filters?.find(filter => filter.filterType === "PRICE_FILTER")?.tickSize || 0.00000001);
        const params = { algoType: "CONDITIONAL", symbol: meta.symbol, side: p.side === "long" ? "SELL" : "BUY", type: "STOP_MARKET", quantity: String(p.positionSize),
          triggerPrice: formatPriceStep(desired, tick, p.side === "short"), workingType: "MARK_PRICE", priceProtect: "TRUE", clientAlgoId: clientOrderId };
        if (mode.dualSidePosition) params.positionSide = p.side.toUpperCase(); else params.reduceOnly = "true";
        const result = await signed(acc, "/fapi/v1/algoOrder", params, "POST");
        if (!result?.algoId || String(result.algoStatus || "NEW") !== "NEW") throw Error("Binance 保护止损单未返回可确认状态");
        placed = { orderId: String(result.algoId), stopPrice: Number(params.triggerPrice) };
      } else throw Error("Extended Live 趋势下单暂未开放；请使用 Paper 测试或切换 Hyperliquid/Binance。");
      if (!placed?.orderId) throw Error("保护止损单未返回 orderId");
      s.stopOrderId = String(placed.orderId); s.stopClientOrderId = clientOrderId; s.stopOrderPrice = Number(placed.stopPrice ?? desired); s.stopSyncedPrice = s.stopOrderPrice; s.stopSyncStatus = "synced"; s.stopLastSyncAt = Date.now(); s.stopLastSyncedAt = s.stopLastSyncAt;
      s.riskLock = false; s.riskLockReason = ""; save();
      if (oldOrderId && String(oldOrderId) !== String(s.stopOrderId) && !paper(acc)) {
        try {
          if (acc.platform === "hyperliquid") await d.hyperCancel({ account: acc, symbol: acc.symbol, orderId: oldOrderId });
          else { const meta = await d.binanceMeta(acc.symbol); await signed(acc, "/fapi/v1/algoOrder", { symbol: meta.symbol, algoId: String(oldOrderId) }, "DELETE"); }
        } catch (error) { throw Error(`新保护单已创建，但旧保护单撤销失败：${error.message}`); }
      }
      log(acc, st, `保护止损单已同步：${desired}`); return true;
    } catch (error) {
      s.riskLock = true; s.riskLockReason = error.message || String(error); s.stopSyncStatus = "failed"; s.stopLastSyncAt = Date.now(); save();
      log(acc, st, `risk_lock：保护止损单同步失败，${s.riskLockReason}`); return false;
    }
  }
  async function sync(acc, st) {
    if (paper(acc)) { publish(acc, st); return { qty: get(acc).position?.positionSize || 0, openOrders: [] }; }
    if (acc.platform === "hyperliquid") {
      const [a, orders] = await Promise.all([d.hyperAccount(acc.address, acc.symbol), info({ type: "frontendOpenOrders", user: acc.address })]);
      if (!Array.isArray(orders) || !Number.isFinite(Number(a.balance))) throw Error("账户同步无效");
      st.balance = Number(a.rawPerp?.marginSummary?.accountValue); st.available = Number(a.rawPerp?.withdrawable);
      if (!Number.isFinite(st.balance) || !Number.isFinite(st.available)) throw Error("无法验证合约账户权益");
      const q = Number(a.currentPos?.szi || 0);
      return { qty: Math.abs(q), side: q < 0 ? "short" : "long", openOrders: orders.filter(o => o.coin === acc.symbol) };
    }
    if (acc.platform === "binance") {
      const meta = await d.binanceMeta(acc.symbol);
      const [a, orders, algoOrders] = await Promise.all([signed(acc, "/fapi/v2/account"), signed(acc, "/fapi/v1/openOrders", { symbol: meta.symbol }), signed(acc, "/fapi/v1/openAlgoOrders", { symbol: meta.symbol })]);
      if (!Array.isArray(a.positions) || !Array.isArray(orders) || !Array.isArray(algoOrders)) throw Error("Binance 账户同步失败");
      st.balance = Number(a.totalMarginBalance); st.available = Number(a.availableBalance);
      const positions = a.positions.filter(p => p.symbol === meta.symbol && Number(p.positionAmt) !== 0);
      if (positions.length > 1) throw Error("同一合约存在多空双仓，趋势策略暂停");
      return { qty: Math.abs(Number(positions[0]?.positionAmt || 0)), side: Number(positions[0]?.positionAmt || 0) < 0 ? "short" : "long", openOrders: [...orders, ...algoOrders] };
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
  async function settle(acc, st, o, result) {
    const T = engine(acc);
    const s = get(acc);
    if (!result.terminal) { o.status = "unknown_order_state"; save(); return false; }
    if (result.fill) {
      if (o.kind === "open") {
        s.position = T.positionFromFill(o.plan, result.fill, o.createdAt, o.config);
        s.lastEntrySignalTime = o.plan.signal.signalTime;
        log(acc, st, `趋势开仓成功：${acc.symbol} ${s.position.side === "long" ? "做多" : "做空"}，${s.position.leverage}倍杠杆，入场价 ${s.position.entryPrice}，初始止损 ${s.position.initialStopLossPrice}`);
        if (isV2(acc)) await syncProtectiveStop(acc, st, true);
      } else {
        if (isV2(acc)) {
          s.lastExitSignalTime = Number(s.signal?.signalTime || s.position?.lastManagedSignalTime || s.position?.signalTime || Date.now());
          s.lastExitEntryMode = s.position?.entryMode || "";
          s.lastExitReason = o.reason || "";
          s.lastExitDirection = s.position?.side || "";
          s.lastExitStructureHigh = s.trendContext?.lastStructureHigh ?? null;
          s.lastExitStructureLow = s.trendContext?.lastStructureLow ?? null;
        }
        if (isV2(acc)) await cancelProtectiveStop(acc, s, { ignoreFailure: true });
        const v = T.recordClose(account(acc, st), result.fill, o.reason);
        if (isV2(acc)) { s.riskLock = false; s.riskLockReason = ""; clearStopState(s); }
        if (paper(acc)) s.simBalance += v.pnl;
        log(acc, st, `趋势平仓成交：${o.reason}，数量 ${result.fill.qty}，净盈亏 ${v.pnl.toFixed(4)}`);
      }
    } else log(acc, st, "交易所已确认订单结束且无成交，等待新的信号或下一次退出检查");
    s.pendingOrder = null;
    save(); flushJournal(acc); publish(acc, st);
    return true;
  }
  async function submit(acc, st, kind, plan, reason = "") {
    const T = engine(acc);
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
      } else throw Error("Extended Live 趋势下单暂未开放；请使用 Paper 测试或切换 Hyperliquid/Binance。");
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
      if (paper(acc)) return await settle(acc, st, o, { terminal: true, fill: o.paperFill });
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
      return await settle(acc, st, o, await lookup(acc, o));
    } catch (e) {
      o.status = "unknown_order_state"; save();
      log(acc, st, "订单结果未知，保留 pendingOrder；先查询交易所状态，禁止重新下单");
      return false;
    }
  }
  function configHash(acc) { const T = engine(acc); return crypto.createHash("sha256").update(JSON.stringify([acc.id, acc.platform, acc.symbol, acc.tradeMode, acc.simulationEnabled, T.normalizeConfig(acc.trendOnlyConfig)])).digest("hex"); }
  async function tick(acc, st, action) {
    const T = engine(acc), s = get(acc), c = T.normalizeConfig(acc.trendOnlyConfig);
    try {
      st.currentPrice = await d.price(acc); publish(acc, st); flushJournal(acc);
      st.updatedAt = new Date().toLocaleString("zh-CN");
      if (s.pendingOrder) {
        if (!await settle(acc, st, s.pendingOrder, await lookup(acc, s.pendingOrder))) { log(acc, st, "未知订单状态：查询中，禁止重复下单"); return; }
      }
      const remote = await sync(acc, st);
      if (s.position && (Math.abs(remote.qty - s.position.positionSize) > 1e-8 || (!paper(acc) && remote.side !== s.position.side))) {
        if (!await reconcileExternalExit(acc, st, remote)) { s.syncMismatch = true; log(acc, st, "交易所仓位与趋势记录不一致：保留原始凭证并暂停下单，需核对外部成交"); return; }
      }
      if (!s.position && remote.qty > 0) { log(acc, st, "存在非趋势策略仓位，禁止接管或新开仓"); return; }
      s.syncMismatch = false;
      if (s.position && isV2(acc)) {
        if (!paper(acc) && (!s.stopOrderId || !remoteHasStop(remote, s.stopOrderId))) {
          s.stopSyncStatus = "missing";
          await syncProtectiveStop(acc, st, true);
        } else if (paper(acc) && !s.stopOrderId) await syncProtectiveStop(acc, st, true);
      }
      if (action === "manual_close") { if (!s.position) throw Error("当前没有趋势仓位"); await submit(acc, st, "close", null, "manual_close"); return; }
      // Manage price stops before fetching candles; missing indicators must not disable the hard stop.
      if (s.position) {
        const beforeStop = Number(s.position.currentStopLossPrice);
        const protection = T.manageTrendOnlyPosition(account(acc, st), { price: st.currentPrice });
        protection.logs.forEach(m => log(acc, st, m)); save();
        if (protection.reason) { await submit(acc, st, "close", null, protection.reason); return; }
        if (isV2(acc) && Number(s.position.currentStopLossPrice) !== beforeStop) await syncProtectiveStop(acc, st, true);
      }
      let i;
      try {
        const sets = await Promise.all([c.entryTimeframe, c.trendTimeframe, c.higherTimeframe].map(tf => d.candles(acc.symbol, tf, 300, acc.platform)));
        if (sets.some(x => x.stale)) throw Error("行情过期或使用跨交易所备用行情");
        const values = sets.map((x, n) => T.indicatorsFor(x.candles, c, [c.entryTimeframe, c.trendTimeframe, c.higherTimeframe][n]));
        i = { ...values[0], config: c, trendDirection: T.directionOf(values[1]), higherDirection: T.directionOf(values[2]), price: Number(st.currentPrice) };
        if (isV2(acc)) i.entryDirection = T.directionOf(values[0]);
        s.signal = T.detectMarketRegime(i.candles, i);
        if (isV2(acc)) {
          Object.assign(i, {
            structureHigh: s.signal.structureHigh,
            structureLow: s.signal.structureLow,
            distanceFromEmaAtr: s.signal.distanceFromEmaAtr,
            states: s.signal.states || { breakout: false, pullback: false, continuation: false }
          });
          T.updateTrendContext(s, s.signal, i);
          T.appendShadowSignal(s, acc.id, s.signal, i, s.signal.entryPermission === "allowed" ? "允许开仓" : (s.signal.blockers || []).join("；"));
        }
        s.indicators = { atr: i.atr, adx: i.adx, chop: i.chop, trendDirection: i.trendDirection, higherDirection: i.higherDirection };
      } catch (e) { log(acc, st, `趋势行情暂不可用：${e.message}；已有价格止损继续执行`); return; }
      if (s.position) {
        const beforeStop = Number(s.position.currentStopLossPrice);
        const result = T.manageTrendOnlyPosition(account(acc, st), { price: st.currentPrice }, i);
        result.logs.forEach(m => log(acc, st, m)); save();
        if (result.reason) { annotateSignal(acc, result.reason, "平仓信号"); await submit(acc, st, "close", null, result.reason); }
        else { if (isV2(acc) && Number(s.position.currentStopLossPrice) !== beforeStop) await syncProtectiveStop(acc, st, true); const actionText = s.position.defensiveMode ? "趋势衰减，进入防守模式" : s.position.trailingActive ? "移动止盈中" : s.position.breakEvenActivated ? "已保本，等待趋势延续" : "已开仓，等待 1R"; annotateSignal(acc, "当前已有仓位", actionText); log(acc, st, actionText); }
        return;
      }
      if (!st.running) { annotateSignal(acc, "趋势监控已停止，禁止新开仓", "监控已停止"); log(acc, st, "趋势监控已停止，禁止新开仓"); return; }
      if (d.conflictingAccount?.(acc)) { annotateSignal(acc, "同一交易账户与合约已被其他策略占用", "风控暂停"); log(acc, st, "同一交易账户与合约已被其他策略占用，禁止新开仓"); return; }
      if (remote.openOrders.length) { annotateSignal(acc, "交易所存在挂单", "等待挂单完成"); log(acc, st, "交易所存在挂单，禁止新开仓"); return; }
      const approval = approvals.get(acc.id);
      const confirmed = approval && approval.signalTime === s.signal.signalTime && approval.expires >= Date.now() && approval.configHash === configHash(acc);
      const a = { ...account(acc, st), confirmLive: !!confirmed };
      const bounds = await constraints(acc);
      const preview = T.tryOpenTrendOnlyPosition({ ...a, confirmLive: true }, s.signal, { ...i, ...bounds });
      s.preview = preview.allowed ? { ...preview, expires: Date.now() + 60000, configHash: configHash(acc) } : null;
      const plan = T.tryOpenTrendOnlyPosition(a, s.signal, { ...i, ...bounds });
      if (!plan.allowed) { annotateSignal(acc, plan.reason, plan.reason); log(acc, st, plan.reason); return; }
      annotateSignal(acc, "", paper(acc) ? "Paper 开仓" : "Live 信号已确认，准备开仓");
      await submit(acc, st, "open", plan);
    } finally { publish(acc, st); save(); }
  }
  function confirm(acc, body) {
    const s = get(acc), p = s.preview;
    if (paper(acc) || body.confirmLive !== true || !p || p.expires < Date.now() || body.signalTime !== p.signal.signalTime || body.configHash !== configHash(acc)) throw Error("Live 确认无效或信号已过期，请刷新后重新确认");
    approvals.set(acc.id, { signalTime: p.signal.signalTime, configHash: configHash(acc), expires: Date.now() + 60000 });
  }
  return { get, save, tick, publish, confirm, syncProtection: (acc, st, force = true) => syncProtectiveStop(acc, st, force), clearApproval: id => approvals.delete(id), busy: acc => !!(get(acc).position || get(acc).pendingOrder) };
}
module.exports = { createTrendRuntime };
