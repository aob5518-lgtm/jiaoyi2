"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {createHash, randomUUID} = require("node:crypto");
const Classic = require("./classic-paper");

function eligible(account) {
  return account?.platform === "hotcoin" && account.tradeMode === "live" && account.simulationEnabled !== true &&
    account.strategyType === "connection_only" && account.quoteAsset === "USDT" &&
    ["ETH","BTC","SOL","BNB"].includes(account.symbol);
}

const fingerprint = account => createHash("sha256").update(JSON.stringify([
  account.id, account.platform, account.symbol, account.quoteAsset, account.apiKey, account.apiSecret
])).digest("hex");

const usableFee = Number.isFinite;
const settingsHash = book => book ? createHash("sha256").update(JSON.stringify(book.settings)).digest("hex") : null;
function create({directory, exchange, now = Date.now, conflict = () => false}) {
  const file = path.join(directory, "classic_live_runtime.json");
  const snapshots = new Map(), messages = new Map();
  let books = {}, corrupt = false;
  if (fs.existsSync(file)) {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.schema !== 1 || !state.books || Array.isArray(state.books)) throw Error();
      for (const book of Object.values(state.books)) {
        Classic.normalize(book.settings, Infinity);
        if (typeof book.identity !== "string" || typeof book.running !== "boolean" || !Array.isArray(book.trades) ||
            !Number.isFinite(book.lastActionAt) || book.position && !(book.position.contracts > 0 && book.position.qty > 0 && book.position.entry > 0) ||
            book.pending && !["open","add","close"].includes(book.pending.kind)) throw Error();
      }
      books = state.books;
    } catch {
      corrupt = true;
    }
  }
  const get = id => Object.hasOwn(books, id) ? books[id] : null;

  function assertMatch(account, book) {
    if (!eligible(account) || account.archivedAt) throw Error("此账户无法使用 Hotcoin 实盘经典补仓");
    if (corrupt) throw Error("实盘账本无法读取");
    if (book && book.identity !== fingerprint(account)) throw Error("账户身份或 API 密钥已改变，请核对实盘账本");
  }

  function commit(account, book) {
    assertMatch(account, book);
    const next = {...books,[account.id]:book}, temp = file + ".tmp";
    const fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({schema:1,books:next}));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    books = next;
  }

  function configure(account, input) {
    const book = get(account.id);
    assertMatch(account, book);
    if (book?.running || book?.pending || book?.position) throw Error("暂停并结清本策略的实盘仓位后可修改参数");
    const settings = Classic.normalize(input, Infinity);
    commit(account, {...(book || {identity:fingerprint(account),running:false,position:null,pending:null,trades:[],lastActionAt:0}),
      settings, lastAction:"实盘参数已保存，等待启动"});
    return settings;
  }

  async function refresh(account) {
    snapshots.delete(account.id);
    const snapshot = await exchange.snapshot(account);
    snapshots.set(account.id, snapshot);
    return snapshot;
  }

  function reconcilePosition(book, snapshot) {
    const remote = snapshot.positions[0], local = book.position;
    if (snapshot.positions.length > 1 || (local ? !remote || remote.side !== local.side || remote.qty !== local.contracts ||
      local.remoteId !== remote.id || Math.abs(remote.entry - local.entry) > 10 ** -snapshot.spec.digits / 2 ||
      remote.leverage !== book.settings.leverage : !!remote)) {
      throw Error("交易所仓位与本策略账本不一致，请核对原生仓位");
    }
    return remote;
  }

  function entryIntent(book, snapshot, kind) {
    const settings = book.settings, side = settings.side, {bid,ask,spec} = snapshot;
    const price = side === "long" ? ask : bid;
    const amount = kind === "open" ? settings.baseAmount : settings.addAmount;
    const bookSize = side === "long" ? snapshot.askSize : snapshot.bidSize;
    const remaining = snapshot.limits[side] - (book.position?.contracts || 0);
    const contracts = Math.floor(Math.min(amount / (spec.unit * price), bookSize, remaining) / spec.step) * spec.step;
    if (!(snapshot.limits[side] > 0 && Number.isSafeInteger(contracts) && contracts >= spec.step)) {
      throw Error("首仓或补仓金额、可成交深度或可开张数不满足 Hotcoin 合约规格");
    }
    if (snapshot.leverage[side] !== settings.leverage || settings.leverage > spec.maxLeverage) {
      throw Error("策略杠杆须与 Hotcoin 当前方向杠杆一致，交易所当前为 " + snapshot.leverage[side] + "×");
    }
    const notional = contracts * spec.unit * price;
    if (notional / settings.leverage + notional * snapshot.feeRate > snapshot.available) throw Error("Hotcoin 可用保证金不足");
    return {kind,side,contracts,price:price.toFixed(spec.digits),positionId:snapshot.mode === 1 ? book.position?.remoteId ?? null : null};
  }

  async function preflight(account) {
    const book = get(account.id), blockers = [];
    try {
      assertMatch(account, book);
      if (!book) throw Error("请先保存经典补仓实盘参数");
      if (book.pending) throw Error("存在待确认委托，请先核对");
      if (conflict(account)) throw Error("同一 Hotcoin 合约已有其他自动策略运行");
      const snapshot = await refresh(account);
      if (snapshot.working.length) throw Error("该合约还有未完成委托，请先核对交易所");
      reconcilePosition(book, snapshot);
      if (!book.position) entryIntent(book,snapshot,"open");
      if (!book.position && Classic.totalNotional(book.settings) / book.settings.leverage > snapshot.balance) {
        throw Error("参数中的首仓与全部补仓合计所需保证金超过账户权益");
      }
    } catch (error) {
      blockers.push(error.message);
    }
    return {allowed:!blockers.length,blockers,mode:"Live",settings:book?.settings||null,settingsHash:settingsHash(book)};
  }

  async function start(account) {
    const book = get(account.id);
    assertMatch(account, book);
    if (book?.running) return;
    const result = await preflight(account);
    if (!result.allowed) throw Error(result.blockers.join("；"));
    if (conflict(account)) throw Error("同一 Hotcoin 合约已有其他自动策略运行");
    commit(account, {...book,running:true,lastAction:"实盘经典补仓已启动"});
  }

  function pause(account) {
    const book = get(account.id);
    assertMatch(account, book);
    if (!book) throw Error("请先保存经典补仓实盘参数");
    commit(account, {...book,running:false,lastAction:"实盘已暂停新增，持仓继续检查止盈"});
  }

  async function submit(account, book, intent, manual) {
    const pending = {...intent, localId:randomUUID(), submittedAt:now(), exchangeId:null, manual};
    const next = {...book,pending,running:manual ? false : book.running,lastActionAt:now(),lastAction:"等待 Hotcoin 委托回报"};
    // Persist before sending. A process restart must never resend an unknown request.
    commit(account, next);
    try {
      const exchangeId = await exchange.place(account, pending);
      commit(account, {...next,pending:{...pending,exchangeId}});
    } catch {
      commit(account, {...next,running:false,lastAction:"Hotcoin 委托未确认，已暂停新增，请在交易所核对"});
      throw Error("Hotcoin 委托未确认，已暂停新增，请在交易所核对");
    }
  }

  async function settle(account, book, snapshot) {
    const pending = book.pending;
    if (!pending.exchangeId) throw Error("存在未知 Hotcoin 委托，请在交易所核对");
    const fill = await exchange.order(account, pending.exchangeId);
    const closing = pending.kind === "close";
    if (fill.side !== (closing ? "close_" : "open_") + pending.side || fill.contracts > pending.contracts) {
      throw Error("Hotcoin 委托回报与策略委托不一致");
    }
    if (![2,-1].includes(fill.status) || snapshot.working.includes(pending.exchangeId)) return;
    const old = book.position, remote = snapshot.positions[0];
    const expected = (old?.contracts || 0) + (closing ? -1 : 1) * fill.contracts;
    if (snapshot.positions.length > 1 || (expected === 0 ? !!remote :
        !remote || !remote.id || remote.side !== pending.side || remote.qty !== expected || !(remote.entry > 0) ||
        remote.leverage !== book.settings.leverage || old && remote.id !== old.remoteId)) {
      throw Error("成交已回报，Hotcoin 原生仓位尚未与成交数量一致");
    }
    const next = {...book,pending:null,lastActionAt:now(),lastAction:"Hotcoin 委托已撤销，未成交"};
    if (!fill.contracts) {
      commit(account, next);
      return;
    }
    const qty = fill.contracts * snapshot.spec.unit, fee = usableFee(fill.fee) ? fill.fee : null;
    if (!closing) {
      const priorFee = old ? old.fee : 0;
      next.position = {remoteId:remote.id,side:pending.side,qty:remote.qty*snapshot.spec.unit,contracts:remote.qty,entry:remote.entry,
        lastFill:fill.price,firstFill:old?.firstFill ?? fill.price,openedAt:old?.openedAt ?? now(),adds:pending.kind === "add" ? old.adds+1 : 0,
        fee:usableFee(priorFee) && usableFee(fee) ? priorFee+fee : null,
        fills:[...(old?.fills||[]),{at:now(),kind:pending.kind,price:fill.price,qty,contracts:fill.contracts,notional:fill.price*qty,id:pending.exchangeId}]};
      next.lastAction = pending.kind === "add" ? "实盘补仓已核对成交" : "实盘首仓已核对成交";
    } else {
      const entryFee = usableFee(old.fee) ? old.fee * fill.contracts / old.contracts : null;
      const fees = entryFee !== null && fee !== null ? entryFee + fee : null;
      const gross = (pending.side === "long" ? 1 : -1) * (fill.price-old.entry) * qty;
      const trade = {id:pending.exchangeId,time:now(),side:pending.side,entryPrice:old.entry,exitPrice:fill.price,qty,
        contracts:fill.contracts,firstFill:old.firstFill,fills:old.fills,addCount:old.adds,
        tradingFee:fees,grossPnl:gross,netPnl:fees===null?null:gross-fees,reason:pending.manual?"实盘手动平仓":"实盘策略止盈",sampleType:"Live"};
      next.trades = [trade,...book.trades];
      next.position = expected ? {...old,qty:expected*snapshot.spec.unit,contracts:expected,fee:entryFee===null?null:old.fee-entryFee} : null;
      next.lastAction = expected ? "实盘部分平仓已核对成交" : "实盘平仓已核对成交";
    }
    commit(account, next);
  }

  async function tick(account, {manual = false} = {}) {
    const book = get(account.id);
    if (!book || !manual && !book.running && !book.position && !book.pending) return;
    assertMatch(account, book);
    try {
      const snapshot = await refresh(account);
      messages.delete(account.id);
      if (book.pending) {
        if (manual) throw Error("请等已有实盘委托确认后再平仓");
        await settle(account, book, snapshot);
        return;
      }
      const remote = reconcilePosition(book, snapshot);
      if (snapshot.working.length) throw Error("Hotcoin 存在未完成委托，请先核对交易所");
      const mark = remote?.side === "short" ? snapshot.ask : snapshot.bid;
      // Trigger exits on the executable quote. Opening and adding use the same price rules as Paper.
      const entryPrice = book.settings.side === "long" ? snapshot.ask : snapshot.bid;
      const kind = Classic.nextAction({...book,cost:{slippage:0,exitFee:0}}, mark, now(), manual, entryPrice);
      if (!kind) {
        if (manual) throw Error("没有可由本策略平掉的实盘仓位");
        return;
      }
      if (kind === "close") {
        await submit(account, book, {kind,side:remote.side,contracts:remote.qty,positionId:snapshot.mode === 1 ? remote.id : null}, manual);
        return;
      }
      if (conflict(account)) throw Error("同一 Hotcoin 合约已有其他自动策略运行");
      await submit(account, book, entryIntent(book, snapshot, kind), false);
    } catch (error) {
      messages.set(account.id, error.message);
      throw error;
    }
  }

  async function inspect(account) {
    if (now() - (snapshots.get(account.id)?.at ?? 0) < 8000) return;
    try {await refresh(account);}
    catch (error) {messages.set(account.id,error.message);}
  }

  function view(account, native = {}) {
    const book = get(account.id);
    if (!eligible(account)) return null;
    const s = snapshots.get(account.id), fresh = s && now() - s.at < 45_000;
    const blocked = corrupt || !!book && book.identity !== fingerprint(account);
    const pending = book?.pending;
    const positions = fresh ? s.positions.map(p=>({...p,notional:p.qty*s.spec.unit*(s.bid+s.ask)/2})) : native.positions || [];
    const selected = positions.filter(p => p.market === account.symbol+"USDT");
    const position = selected.length === 1 ? selected[0] : null;
    const mark = fresh ? (s.bid+s.ask)/2 : native.mark ?? null;
    const plan = book && !blocked ? Classic.tradePlan({...book,cost:{slippage:0,exitFee:0}}, mark, now()) : null;
    if (plan) {
      if (plan.first.reference && !book.position) {
        plan.first.reference = fresh ? (book.settings.side === "long" ? s.ask : s.bid) : null;
        plan.first.status = "盘口参考，成交价由交易所确认";
      }
      if (plan.add.quantity && fresh) plan.add.contracts = Math.floor(plan.add.quantity / s.spec.unit / s.spec.step) * s.spec.step;
    }
    const trades = book?.trades || [];
    const realized = trades.length && trades.every(t=>t.netPnl !== null) ? trades.reduce((sum,t)=>sum+t.netPnl,0) : trades.length ? null : 0;
    return {...native, liveStrategy:true, native:true, plan, settings:book?.settings || null, position,positions,mark,
      managedPosition:!!book?.position, nativeLeverage:fresh?s.leverage:null,
      maxLeverage:fresh?s.spec.maxLeverage:null,
      equity:fresh?s.balance:native.equity??null, available:fresh?s.available:native.available??null,
      floating:fresh?s.unrealizedPnl:native.floating??null, valuationBasis:"native_equity",floatingBasis:"native_unrealized",
      updatedAt:fresh?s.at:native.updatedAt??null, realized, running:!!book?.running,
      blocked:blocked||!!pending&&!pending.exchangeId, pendingOrder:pending?{known:!!pending.exchangeId,kind:pending.kind}:null,
      margin:position?.margin??null, market:fresh||native.updatedAt?"原生账户已同步":"原生账户待核验",
      notice:blocked?"实盘账本待核对":messages.get(account.id)||book?.lastAction||"保存经典补仓实盘参数后可核对并启动",
      lastAction:book?.lastAction || "实盘策略尚未启动"};
  }

  return {get,configure,preflight,start,pause,tick,inspect,view};
}

module.exports = {create,eligible,settingsHash};
