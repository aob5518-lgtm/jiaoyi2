"use strict";

const {client, assets, number, positionsFrom} = require("./hotcoin");

function identifier(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? "");
  return /^\d{1,40}$/.test(id) && /[1-9]/.test(id) ? id : null;
}

function nativePositions(rows, contract) {
  return rows.flatMap(row => positionsFrom([row])
    .filter(position => position.market.toLowerCase() === contract)
    .map(position => ({...position, id:identifier(row.id ?? row.positionId)})));
}

function requireOrders(rows) {
  if (!Array.isArray(rows)) throw Error("Hotcoin 未返回当前委托列表");
  return rows.filter(row => {
    const status = number(row?.status);
    if (![-1, 0, 1, 2].includes(status)) throw Error("Hotcoin 当前委托状态未知");
    // The conditional order status values differ from ordinary orders.
    if (number(row.systemType) === 12) return status !== -1;
    return status === 0 || status === 1;
  });
}

function create(orderRequest = fetch) {
  const instruments = new Map();

  async function rules(api) {
    const cached = instruments.get(api.contract);
    if (cached && Date.now() - cached.at < 60_000) return cached.rules;
    const rows = await api.publicRead("/public");
    const product = Array.isArray(rows) && rows.find(row =>
      row.code === api.contract && number(row.env) === 0 && number(row.direction) === 0 && row.quote === "usdt");
    const unit = number(product?.unitAmount), step = number(product?.minTradeUnit), digits = number(product?.minQuoteDigit);
    const maxLeverage = number(product?.maxLever);
    if (!(unit > 0 && maxLeverage >= 1) || !Number.isSafeInteger(step) || step < 1 || !Number.isInteger(digits) || digits < 0 || digits > 12) {
      throw Error("Hotcoin 未返回有效的 USDT 线性合约规格");
    }
    const spec = {unit, step, digits, maxLeverage};
    instruments.set(api.contract, {at:Date.now(),rules:spec});
    return spec;
  }

  async function snapshot(account) {
    const api = client(account, orderRequest), contract = api.contract;
    const started = Date.now();
    const [asset, rows, orders, config, depth, spec] = await Promise.all([
      api.privateCall("/account/assets/" + contract),
      api.privateCall("/position/list-all"),
      api.privateCall("/products/" + contract + "/list"),
      api.privateCall("/position/" + contract + "/configs"),
      api.publicRead("/public/products/" + contract + "/orderbook"),
      rules(api)
    ]);
    const ask = number(depth?.asks?.[0]?.[0]), bid = number(depth?.bids?.[0]?.[0]);
    const askSize = number(depth?.asks?.[0]?.[1]), bidSize = number(depth?.bids?.[0]?.[1]);
    const long = number(config?.longPositionConfigDetails?.lever), short = number(config?.shortPositionConfigDetails?.lever);
    const mode = number(config?.selectedMode);
    const limits = {long:number(config?.longPositionConfigDetails?.maxOpenAmount),short:number(config?.shortPositionConfigDetails?.maxOpenAmount)};
    const feeRate = number(config?.takerFeeRate ?? config?.feeRate);
    if (!(bid > 0 && ask >= bid && bidSize > 0 && askSize > 0) || Date.now() - started > 6500) throw Error("Hotcoin 原生盘口过期或格式无效");
    if (String(config?.contractCode).toLowerCase() !== contract || number(config?.unitAmount) !== spec.unit ||
        ![0,1].includes(mode) || !(long >= 1 && short >= 1 && feeRate >= 0 && feeRate < 1) || feeRate === null) {
      throw Error("Hotcoin 仓位规格、手续费或杠杆无法核对");
    }
    if (!Array.isArray(rows)) throw Error("Hotcoin 未返回原生仓位列表");
    const positions = nativePositions(rows, contract);
    return {...assets(asset), positions, working:requireOrders(orders).map(row => identifier(row.id ?? row.orderId)),
      spec, mode, marginType:number(config.type),leverage:{long,short}, limits, feeRate, bid, ask, bidSize, askSize, at:Date.now()};
  }

  async function place(account, intent) {
    const api = client(account, orderRequest), closing = intent.kind === "close";
    const payload = {type:closing ? "11" : "10", side:(closing ? "close_" : "open_") + intent.side, amount:intent.contracts};
    if (!closing) Object.assign(payload, {price:intent.price, ioc:1});
    const params = intent.positionId ? {positionId:intent.positionId} : undefined;
    const reply = await api.privateCall("/products/" + api.contract + "/order", {method:"POST",payload,params});
    const id = identifier(reply?.id ?? reply?.orderId);
    if (!id) throw Error("Hotcoin 未返回可核对的委托编号");
    return id;
  }

  async function order(account, id) {
    const api = client(account, orderRequest);
    if (identifier(id) !== id) throw Error("Hotcoin 委托编号无效");
    const row = await api.privateCall("/products/" + api.contract + "/" + id);
    const contracts = number(row?.dealAmount), status = number(row?.status), price = number(row?.avgPrice);
    if (identifier(row?.id ?? row?.orderId) !== id || String(row?.contractCode).toLowerCase() !== api.contract ||
        ![-1, 0, 1, 2].includes(status) || !Number.isSafeInteger(contracts) || contracts < 0 ||
        contracts > 0 && !(price > 0) || status === 2 && contracts === 0) {
      throw Error("Hotcoin 委托回报无法核对");
    }
    const fee = number(row.fee);
    return {contracts, status, price, side:row.detailSide, fee:fee === null ? null : -fee};
  }

  return {snapshot, place, order};
}

module.exports = {create};
