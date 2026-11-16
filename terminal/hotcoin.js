"use strict";
const {createHmac} = require("node:crypto");

const host = "api-ct.hotcoin.fit";
const base = "https://" + host;
const prefix = "/api/v1/perpetual";
const symbols = new Set(["ETH","BTC","SOL","BNB"]);

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}

function signedUrl(path, account, timestamp, params = {}) {
  const query = {...params, AccessKeyId: account.apiKey, SignatureMethod: "HmacSHA256", SignatureVersion: "2", Timestamp: timestamp};
  const canonical = Object.keys(query).sort().map(key => encode(key) + "=" + encode(query[key])).join("&");
  const signature = createHmac("sha256", account.apiSecret).update(["GET", host, path, canonical].join("\n")).digest("base64");
  return base + path + "?" + canonical + "&Signature=" + encode(signature);
}

async function get(url, request, signal) {
  // The URL contains credentials for signed reads. Keep network and venue errors out of the response.
  try {
    const response = await request(url, {method:"GET", redirect:"error", signal});
    if (!response.ok) throw Error();
    const json = await response.json();
    if (json && Object.hasOwn(json, "code") && String(json.code) !== "200") throw Error();
    return json && Object.hasOwn(json, "code") ? json.data : json;
  } catch {
    throw Error("Hotcoin 原生查询失败，请检查 API 读取权限和网络");
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

async function readAccount(account, request = fetch) {
  if (!symbols.has(account.symbol) || account.quoteAsset !== "USDT" || !account.apiKey || !account.apiSecret) {
    throw Error("Hotcoin 需要 USDT 永续合约和已配置的 API Key、Secret");
  }
  const signal = AbortSignal.timeout(9500);
  const clock = await get(base + prefix + "/public/time", request, signal);
  const exchangeTime = number(clock?.timestamp);
  if (!(exchangeTime > 0) || !Number.isFinite(new Date(exchangeTime).getTime())) throw Error("Hotcoin 服务器时间不可用");
  const timestamp = new Date(exchangeTime).toISOString();
  const contract = account.symbol.toLowerCase() + "usdt";
  const read = (route, params) => get(signedUrl(prefix+route, account, timestamp, params), request, signal);
  const [asset, rows, orders] = await Promise.all([
    read("/account/assets/" + contract),
    read("/position/list-all", {env:0}),
    read("/products/" + contract + "/list").catch(() => null)
  ]);
  const balance = number(asset?.accountRights), available = number(asset?.availableMargin);
  if (String(asset?.currencyCode || "").toUpperCase() !== "USDT" || number(asset?.env) !== 0 || balance === null || available === null) {
    throw Error("Hotcoin USDT 账户权益或可用保证金数据缺失");
  }
  const positions = positionsFrom(rows);
  const orderCount = Array.isArray(orders) && orders.every(order => [-1,0,1,2].includes(number(order?.status)))
    ? orders.filter(order => [0,1].includes(number(order.status))).length : null;
  return {
    source:"native_exchange", valuationBasis:"native_equity", balance, available,
    unrealizedPnl:number(asset.unRealizedSurplus), positionCount:positions.length, positions,
    ordersMarket:contract.toUpperCase(), openOrderCount:orderCount, checkedAt:Date.now()
  };
}

module.exports = {signedUrl, positionsFrom, readAccount};
