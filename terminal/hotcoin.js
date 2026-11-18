"use strict";
const {createHmac} = require("node:crypto");

const host = "api-ct.hotcoin.fit";
// The official futures SDK signs the canonical host separately from the REST origin.
const signingHost = "perpetual.hotcoinex.io";
const base = "https://" + host;
const prefix = "/api/v1/perpetual";
const symbols = new Set(["ETH","BTC","SOL","BNB"]);

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}

function signedUrl(path, account, timestamp, params = {}, method = "GET") {
  const query = {...params, AccessKeyId: account.apiKey, SignatureMethod: "HmacSHA256", SignatureVersion: "2", Timestamp: timestamp};
  const canonical = Object.keys(query).sort().map(key => encode(key) + "=" + encode(query[key])).join("&");
  const signature = createHmac("sha256", account.apiSecret).update([method, signingHost, path, canonical].join("\n")).digest("base64");
  return base + path + "?" + canonical + "&Signature=" + encode(signature);
}

async function send(url, request, {signal, method = "GET", payload} = {}) {
  // The URL contains credentials for signed reads. Keep network and venue errors out of the response.
  try {
    const response = await request(url, {method, redirect:"error", signal,
      ...(payload ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)} : {})});
    if (!response.ok) throw Error();
    const json = response.text ? JSON.parse(await response.text(), (key, value, context) =>
      ["id","orderId","positionId"].includes(key) && typeof value === "number" && /^\d+$/.test(context?.source || "")
        ? context.source : value) : await response.json();
    if (json && Object.hasOwn(json, "code") && String(json.code) !== "200") throw Error();
    return json && Object.hasOwn(json, "code") ? json.data : json;
  } catch {
    throw Error(method === "GET" ? "Hotcoin 原生查询失败，请检查 API 读取权限和网络" : "Hotcoin 未确认委托结果，请核对交易所");
  }
}

function number(value) {
  return (typeof value === "number" || typeof value === "string" && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
}

function positionsFrom(rows) {
  if (!Array.isArray(rows)) throw Error("Hotcoin 原生持仓列表缺失");
  const positions = [];
  for (const row of rows) {
    const qty = number(row?.amount);
    if (qty === null || qty < 0) throw Error("Hotcoin 持仓张数无法核对");
    if (qty === 0) continue;
    const quoteAsset = String(row.quoteDisplayName || row.quote || "").toUpperCase();
    const market = String(row.contractCode || "").toUpperCase();
    const side = String(row.side || "").toLowerCase();
    if (!market || !quoteAsset || !["long","short"].includes(side)) throw Error("Hotcoin 持仓合约或方向缺失");
    const symbol = market.endsWith(quoteAsset) ? market.slice(0, -quoteAsset.length).replace(/[-_]$/, "") : market;
    const entry = number(row.price), leverage = number(row.lever);
    positions.push({
      market, symbol, quoteAsset, side, qty, qtyUnit:"张", entry:entry > 0 ? entry : null,
      leverage:leverage > 0 ? leverage : null, leverageSource:"native_exchange",
      mark:number(row.markPrice), margin:number(row.openMargin), unrealizedPnl:number(row.unRealizedSurplus)
    });
  }
  return positions;
}

function contractFor(account) {
  if (!symbols.has(account.symbol) || account.quoteAsset !== "USDT" || !account.apiKey || !account.apiSecret) {
    throw Error("Hotcoin 需要 USDT 永续合约和已配置的 API Key、Secret");
  }
  return account.symbol.toLowerCase() + "usdt";
}

function client(account, request = fetch) {
  const contract = contractFor(account);
  function privateCall(route, {params, method = "GET", payload} = {}) {
    return send(signedUrl(prefix + route, account, new Date().toISOString(), params, method), request,
      {signal:AbortSignal.timeout(6000),method,payload});
  }
  const publicRead = route => send(base + prefix + route, request, {signal:AbortSignal.timeout(6000)});
  return {contract, privateCall, publicRead};
}

function assets(asset) {
  const balance = number(asset?.accountRights), available = number(asset?.availableMargin);
  if (String(asset?.currencyCode || "").toUpperCase() !== "USDT" || number(asset?.env) !== 0 || balance === null || available === null) {
    throw Error("Hotcoin USDT 账户权益或可用保证金数据缺失");
  }
  return {balance, available, unrealizedPnl:number(asset.unRealizedSurplus)};
}

async function readAccount(account, request = fetch) {
  const {contract, privateCall:read} = client(account, request);
  const [asset, rows, orders] = await Promise.all([
    read("/account/assets/" + contract),
    read("/position/list-all"),
    read("/products/" + contract + "/list").catch(() => null)
  ]);
  const balances = assets(asset);
  const positions = positionsFrom(rows);
  const orderCount = Array.isArray(orders) && orders.every(order => [-1,0,1,2].includes(number(order?.status)))
    ? orders.filter(order => [0,1].includes(number(order.status))).length : null;
  return {
    source:"native_exchange", valuationBasis:"native_equity", ...balances, positionCount:positions.length, positions,
    ordersMarket:contract.toUpperCase(), openOrderCount:orderCount, checkedAt:Date.now()
  };
}

module.exports = {signedUrl, positionsFrom, readAccount, client, assets, number};
