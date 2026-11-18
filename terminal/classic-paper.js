"use strict";
const fs = require("fs");
const path = require("path");
const {randomUUID} = require("crypto");
const {getEstimatedTradeCost} = require("../trade_cost");
const Leverage=require("../market_leverage");

const isPaper = account => account?.tradeMode === "simulation" && account.simulationEnabled === true;
const eligible = account => isPaper(account) && ["classic", "connection_only"].includes(account.strategyType);
const identity = account => JSON.stringify([account.platform, account.symbol, account.quoteAsset, account.simulationBalance]);
const num = (value, low, high) => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const defaults = Object.freeze({side: "long", leverage: 1, baseAmount: 100, addAmount: 100, maxAdds: 3, addTrigger: .01, takeProfit: .01});
const money = value => Number(value.toFixed(8));
const totalNotional = cfg => cfg.baseAmount + cfg.addAmount * cfg.maxAdds;
function normalize(input, initialEquity) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw Error("参数字段不支持");
  const cfg = {...defaults, ...input};
  if (!["long", "short"].includes(cfg.side) || !Leverage.valid(cfg.leverage,.1) ||
      !num(cfg.baseAmount, 1, 1e8) || !num(cfg.addAmount, 1, 1e8) ||
      !num(cfg.maxAdds, 0, 10) || !Number.isInteger(cfg.maxAdds) ||
      !num(cfg.addTrigger, .0001, .99) || !num(cfg.takeProfit, .0001, .99)) throw Error("请核对方向、杠杆、金额、次数与百分比范围");
  if (totalNotional(cfg) / cfg.leverage > initialEquity) throw Error("计划总保证金超过模拟权益");
  return cfg;
}
function targets(book, price) {
  const p = book.position, c = book.settings;
  if (!p) return {nextAdd: null, takeProfit: null, gross: 0, floating: 0, margin: 0};
  const sign = c.side === "long" ? 1 : -1;
  const nextAdd = p.adds < c.maxAdds ? p.lastFill * (1 - sign * c.addTrigger) : null;
  const takeProfit = p.entry / (1 - sign * c.takeProfit / c.leverage);
  if (!num(price, Number.MIN_VALUE, Number.MAX_VALUE)) return {nextAdd, takeProfit, gross: null, floating: null, margin: null};
  const gross = (price - p.entry) * p.qty * sign;
  const exitFill = price * (1 - sign * book.cost.slippage);
  return {nextAdd, takeProfit, gross, floating: (exitFill - p.entry) * p.qty * sign - p.fee - exitFill * p.qty * book.cost.exitFee, margin: price * p.qty / c.leverage};
}
function tradePlan(book, price, now = Date.now()) {
  const p = book.position, c = book.settings, t = targets(book, price);
  const sign = c.side === "long" ? 1 : -1;
  const cooldown = Math.max(0, Math.ceil((book.lastActionAt + (p ? 60000 : 45000) - now) / 1000));
  return {
    side: c.side,
    first: {
      price: p ? p.firstFill ?? (p.adds === 0 ? p.entry : null) : null,
      reference: !p && price > 0 ? price * (1 + sign * book.cost.slippage) : null,
      amount: c.baseAmount,
      status: p ? "已成交" : !book.running ? "等待启动" : !price ? "等待报价" : cooldown ? "开仓冷却" : "等待下一轮"
    },
    add: {
      price: t.nextAdd, amount: c.maxAdds > 0 && (!p || p.adds < c.maxAdds) ? c.addAmount : null,
      quantity: t.nextAdd > 0 ? c.addAmount / t.nextAdd : null,
      lastPrice: p?.adds > 0 ? p.lastFill : null, done: p?.adds || 0, limit: c.maxAdds,
      status: c.maxAdds === 0 ? "未启用" : !p ? "等待首仓" : t.nextAdd === null ? "已达上限" : !book.running ? "已暂停" : cooldown ? "补仓冷却" : "等待触发"
    },
    exit: {price: t.takeProfit, status: p ? "监测止盈" : "暂无持仓"},
    cooldown, fills: p?.fills || []
  };
}
function nextAction(book, mark, now, manual = false, entryPrice = mark) {
  const p = book.position, c = book.settings, target = targets(book, mark);
  if (p && (manual || target.gross >= target.margin * c.takeProfit)) return "close";
  if (!book.running || manual) return null;
  if (!p) return now - book.lastActionAt >= 45000 ? "open" : null;
  const sign = c.side === "long" ? 1 : -1;
  return target.nextAdd !== null && sign * (entryPrice - target.nextAdd) <= 0 && now - book.lastActionAt >= 60000 ? "add" : null;
}
function step(book, mark, now, manual = false, marketLeverage) {
  if (!num(mark, Number.MIN_VALUE, Number.MAX_VALUE)) throw Error("行情价格无效");
  const next = structuredClone(book), c = next.settings, p = next.position;
  const sign = c.side === "long" ? 1 : -1;
  const t = targets(next, mark);
  const action = nextAction(book, mark, now, manual);
  if (action === "close") {
    const exit = mark * (1 - sign * next.cost.slippage), fee = p.fee + exit * p.qty * next.cost.exitFee;
    const gross = (exit - p.entry) * p.qty * sign, net = money(gross - fee);
    next.balance = money(next.balance + net);
    next.realized = money(next.realized + net);
    next.trades.unshift({id: randomUUID(), time: now, side: c.side, entryPrice: p.entry, firstFill: p.firstFill ?? (p.adds === 0 ? p.entry : null), fills: p.fills || [], exitPrice: exit, qty: p.qty, addCount: p.adds, grossPnl: money(gross), tradingFee: money(fee), netPnl: net, reason: manual ? "手动平仓" : "策略止盈", sampleType: "Paper"});
    next.position = null;
    if (manual) next.running = false;
    next.lastAction = manual ? "已手动平掉模拟仓位" : "已完成模拟止盈";
  } else if (action) {
    const amount = p ? c.addAmount : c.baseAmount;
    const fill = mark * (1 + sign * next.cost.slippage), qty = amount / mark;
    const fee = fill * qty * next.cost.entryFee;
    const available = next.balance + t.floating - t.margin;
    if(marketLeverage!==undefined){
      const issue=Leverage.leverageError(c.leverage,marketLeverage,Math.max(mark,fill)*(qty+(p?.qty||0)));
      if(issue&&(marketLeverage||c.leverage>1))return {book,notice:issue};
    }
    if (fill * qty / c.leverage + fee > available) return {book, notice: "可用模拟保证金不足，等待风险降低"};
    const total = qty + (p?.qty || 0);
    const fills = [...(p?.fills || []), {at: now, kind: p ? "add" : "open", price: fill, qty, notional: fill * qty}];
    next.position = {qty: total, entry: (fill * qty + (p ? p.entry * p.qty : 0)) / total, lastFill: fill, firstFill: p ? p.firstFill ?? (p.adds === 0 ? p.entry : null) : fill, fills, fee: fee + (p?.fee || 0), adds: p ? p.adds + 1 : 0, openedAt: p?.openedAt || now};
    next.lastAction = p ? "模拟补仓 #" + next.position.adds : "模拟首仓已成交";
  } else return {book, notice: !next.running ? p ? "已暂停新增交易，继续检查止盈" : "等待启动" : p ? "等待补仓或止盈条件" : "等待开仓冷却"};
  next.lastActionAt = now;
  return {book: next, notice: next.lastAction};
}
function validBook(book) {
  if (!book || typeof book.identity !== "string" || typeof book.running !== "boolean" ||
      !num(book.initialEquity, 1, 1e9) || !Number.isFinite(book.balance) || !Number.isFinite(book.realized) ||
      !Number.isFinite(book.lastActionAt) || !Array.isArray(book.trades)) return false;
  if (!book.cost || !["entryFee","exitFee","slippage"].every(key => num(book.cost[key], 0, .1))) return false;
  try {normalize(book.settings, book.initialEquity);} catch {return false;}
  const p = book.position;
  return p === null || p && num(p.qty, Number.MIN_VALUE, 1e12) && num(p.entry, Number.MIN_VALUE, 1e12) &&
    num(p.lastFill, Number.MIN_VALUE, 1e12) && num(p.fee, 0, 1e12) && Number.isInteger(p.adds) && p.adds >= 0 && p.adds <= book.settings.maxAdds;
}
function create(directory) {
  const file = path.join(directory, "classic_paper_runtime.json");
  let books = {}, corrupt = false;
  const quotes = new Map();
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.schema !== 1 || !data.books || typeof data.books !== "object" || Array.isArray(data.books) || !Object.values(data.books).every(validBook)) throw Error("Invalid book");
      books = data.books;
    } catch {corrupt = true;}
  }
  const get = id => Object.hasOwn(books, id) ? books[id] : null;
  function commit(id, book) {
    if (corrupt) throw Error("经典模拟账本无法核验，请先恢复原始账本");
    if (!validBook(book)) throw Error("新模拟账本数据无效，原账本已保留");
    const next = {...books, [id]: book};
    const temp = file + ".tmp-" + process.pid;
    const fd = fs.openSync(temp, "w", 0o600);
    try {fs.writeFileSync(fd, JSON.stringify({schema: 1, books: next}));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temp, file);
    books = next;
  }
  function assertMatch(account, book) {
    if (corrupt || !eligible(account) || book && book.identity !== identity(account)) throw Error("账户模式、标的或账本不一致，经典模拟交易已锁定");
  }
  function configure(account, input) {
    const old = get(account.id);
    assertMatch(account, old);
    if (old?.running || old?.position) throw Error("请暂停并结清模拟仓位后保存参数");
    const initialEquity = Number(account.simulationBalance);
    if (!num(initialEquity, 1, 1e9)) throw Error("模拟初始权益无效");
    const settings = normalize(input, initialEquity);
    const cost = getEstimatedTradeCost({...account, paper: true}, "classic");
    const rates = {entryFee: cost.entryFeeRate, exitFee: cost.exitFeeRate, slippage: cost.estimatedEntrySlippage};
    if (!Object.values(rates).every(value => num(value, 0, .1))) throw Error("模拟成本配置无效");
    commit(account.id, {...(old || {initialEquity, balance: initialEquity, realized: 0, position: null, trades: [], lastActionAt: 0}), identity: identity(account), settings, cost: rates, running: false, lastAction: "参数已保存"});
  }
  function control(account, action) {
    const book = get(account.id);
    if (!book) throw Error("请先保存经典策略参数");
    if (action === "start") assertMatch(account, book);
    if (!["start", "pause"].includes(action)) throw Error("操作不支持");
    const running = action === "start";
    if (book.running !== running) commit(account.id, {...book, running, lastAction: running ? "经典模拟交易已启动" : "已暂停新增交易"});
  }
  function mark(account, price, now = Date.now(), manual = false, marketLeverage) {
    const book = get(account.id);
    assertMatch(account, book);
    if (!book) return;
    const result = step(book, price, now, manual, marketLeverage);
    if (result.book !== book) commit(account.id, result.book);
    quotes.set(account.id, {price, at: now, notice: result.notice});
  }
  function view(account, now = Date.now()) {
    const book = get(account.id), q = quotes.get(account.id);
    if (!book) return null;
    const fresh = q?.price > 0 && now - q.at <= Math.max(60000, Number(account.interval || 15000) * 3);
    const t = targets(book, fresh ? q.price : null);
    const p = book.position;
    const blocked = corrupt || !eligible(account) || book.identity !== identity(account);
    const plan = tradePlan(book, fresh ? q.price : null, now);
    return {
      settings: book.settings, running: book.running, blocked, plan,
      equity: t.floating === null ? null : book.balance + t.floating, balance: book.balance, realized: book.realized,
      floating: t.floating, available: t.floating === null ? null : book.balance + t.floating - t.margin,
      margin: t.margin, mark: fresh ? q.price : null, updatedAt: q?.at || null, market: fresh ? "行情正常" : "等待最新行情",
      position: p ? {side: book.settings.side, qty: p.qty, entry: p.entry, leverage:book.settings.leverage, leverageSource:"cycle_snapshot", adds: p.adds, takeProfit: t.takeProfit, nextAdd: book.running ? t.nextAdd : null} : null,
      notice: blocked ? "账户配置与账本不一致，已锁定" : q?.notice || book.lastAction, lastAction: book.lastAction
    };
  }
  return {get, configure, control, mark, view, corrupt: () => corrupt};
}
module.exports = {create, eligible, defaults, normalize, totalNotional, targets, step, tradePlan, nextAction};
