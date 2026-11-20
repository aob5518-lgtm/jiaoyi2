"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {createHash, randomUUID} = require("node:crypto");
const Classic = require("./classic-paper");
const Strategies = require("./live-strategies");
const venues={hotcoin:"USDT",binance:"USDT",hyperliquid:"USDC",extended:"USD"};

function eligible(account) {
  return account?.tradeMode === "live" && account.simulationEnabled !== true &&
    Object.hasOwn(venues,account.platform) && account.quoteAsset === venues[account.platform] &&
    ["ETH","BTC","SOL","BNB"].includes(account.symbol);
}

const fingerprint = account => createHash("sha256").update(JSON.stringify([
  account.id, account.platform, account.symbol, account.quoteAsset, account.address,account.privateKey,
  account.apiKey, account.apiSecret,account.starkPrivateKey,account.publicKey,account.vault
])).digest("hex");

const usableFee = Number.isFinite;
const settingsHash = book => book ? createHash("sha256").update(JSON.stringify([book.strategy||"classic",book.settings])).digest("hex") : null;
const equalQty=(a,b)=>Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*1e-10;
function create({directory, exchange, now = Date.now, conflict = () => false,permit}) {
  const file = path.join(directory, "classic_live_runtime.json");
  const snapshots = new Map(), messages = new Map();
  let books = {}, corrupt = false;
  if (fs.existsSync(file)) {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.schema !== 1 || !state.books || Array.isArray(state.books)) throw Error();
      for (const book of Object.values(state.books)) {
        Strategies.normalize(book.strategy||"classic",book.settings);
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
    if (!eligible(account) || account.archivedAt) throw Error("此账户无法使用实盘策略");
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

  function configure(account, input, strategy="classic") {
    const book = get(account.id);
    assertMatch(account, book);
    if (book?.running || book?.pending || book?.position) throw Error("暂停并结清本策略的实盘仓位后可修改参数");
    const settings = Strategies.normalize(strategy,input);
    commit(account, {...(book || {identity:fingerprint(account),running:false,position:null,pending:null,trades:[],lastActionAt:0}),
      settings,strategy,lastSignalAt:book?.strategy===strategy?book.lastSignalAt||0:0,
      lastAction:"实盘参数已保存，等待启动"});
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
    if (snapshot.positions.length > 1 || (local ? !remote || remote.side !== local.side || !equalQty(remote.qty,local.contracts) ||
      local.remoteId !== remote.id || Math.abs(remote.entry - local.entry) > 10 ** -snapshot.spec.digits / 2 ||
      remote.leverage !== book.settings.leverage : !!remote)) {
      throw Error("交易所仓位与本策略账本不一致，请核对原生仓位");
    }
    return remote;
  }

  function entryIntent(book, snapshot, kind, plan,checkLeverage=true) {
    const settings = book.settings, side = plan?.side||settings.side, {bid,ask,spec} = snapshot;
    const price = side === "long" ? ask : bid;
    const plannedQty=plan?Math.min(plan.qty,plan.budget/(plan.distance+price*snapshot.feeRate*2)):null;
    const amount = plan ? plannedQty*price : kind === "open" ? settings.baseAmount : settings.addAmount;
    const bookSize = side === "long" ? snapshot.askSize : snapshot.bidSize;
    const remaining = snapshot.limits[side] - (book.position?.contracts || 0);
    const contracts = Number((Math.floor(Math.min(amount / (spec.unit * price), bookSize, remaining) / spec.step) * spec.step).toFixed(12));
    if (!(snapshot.limits[side] > 0 && Number.isFinite(contracts) && contracts >= (spec.minQty||spec.step) &&
      contracts*spec.unit*price >= (spec.minNotional||0))) {
      throw Error("金额、盘口深度或可开数量不满足交易所合约规格");
    }
    if (checkLeverage&&snapshot.leverage[side] !== settings.leverage || settings.leverage > spec.maxLeverage) {
      throw Error("策略杠杆须与交易所当前方向一致，当前为 " + snapshot.leverage[side] + "×");
    }
    const notional = contracts * spec.unit * price;
    if (notional / settings.leverage + notional * snapshot.feeRate > snapshot.available) throw Error("交易所可用保证金不足");
    return {kind,side,contracts,price:price.toFixed(spec.digits),hedged:snapshot.mode===1,plan:plan||null,
      positionId:snapshot.mode === 1 ? book.position?.remoteId ?? null : null};
  }

  async function preflight(account) {
    const book = get(account.id), blockers = [];
    try {
      assertMatch(account, book);
      if (!book) throw Error("请先保存实盘策略参数");
      if (book.pending) throw Error("存在待确认委托，请先核对");
      if (conflict(account)) throw Error("同一实盘合约已有其他自动策略运行");
      const snapshot = await refresh(account);
      if(!book.position&&!(snapshot.balance>0&&snapshot.available>0))throw Error("交易所账户权益或可用保证金为零，请先在交易所确认资金");
      if (snapshot.working.length) throw Error("该合约还有未完成委托，请先核对交易所");
      reconcilePosition(book, snapshot);
      if (!book.position && (book.strategy||"classic")==="classic") entryIntent(book,snapshot,"open",null,!exchange.setLeverage);
      if (!book.position && (book.strategy||"classic")==="classic" && Classic.totalNotional(book.settings) / book.settings.leverage > snapshot.balance) {
        throw Error("参数中的首仓与全部补仓合计所需保证金超过账户权益");
      }
      if(book.strategy&&book.strategy!=="classic"){
        if(!(snapshot.balance>0&&snapshot.available>0))throw Error("交易所账户权益或可用保证金不足");
        const directions=book.settings.direction==="both"?["long","short"]:[book.settings.direction];
        if(directions.some(side=>!exchange.setLeverage&&snapshot.leverage[side]!==book.settings.leverage||book.settings.leverage>snapshot.spec.maxLeverage)) {
          throw Error("所选方向的交易所当前杠杆与策略设置不一致");
        }
        const research=await Strategies.analyze(account,book,snapshot,exchange,now());
        if(["WARMUP","CANDLE_GAP","CANDLE_STALE"].includes(research.analysis.code))throw Error(research.analysis.reason);
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
    const s=snapshots.get(account.id),directions=book.settings.side?[book.settings.side]:
      book.settings.direction==="both"?["long","short"]:[book.settings.direction];
    if(!book.position&&exchange.setLeverage&&directions.some(side=>s.leverage[side]!==book.settings.leverage)){
      await exchange.setLeverage(account,book.settings.leverage,directions,s);
      const changed=await refresh(account);
      if(directions.some(side=>changed.leverage[side]!==book.settings.leverage))throw Error("交易所尚未确认新的杠杆，策略保持停止");
    }
    if (conflict(account)) throw Error("同一实盘合约已有其他自动策略运行");
    let lastSignalAt=book.lastSignalAt||0;
    if(book.strategy&&book.strategy!=="classic"&&!book.position){
      const research=await Strategies.analyze(account,book,snapshots.get(account.id),exchange,now());
      lastSignalAt=Math.max(lastSignalAt,research.analysis.closedAt||0);
    }
    commit(account, {...book,running:true,lastSignalAt,lastAction:"实盘策略已启动"});
  }

  function pause(account) {
    const book = get(account.id);
    assertMatch(account, book);
    if (!book) throw Error("请先保存实盘策略参数");
    commit(account, {...book,running:false,lastAction:"实盘已暂停新增，持仓继续检查止盈"});
  }

  async function submit(account, book, intent, manual) {
    const pending = {...intent, localId:randomUUID(), submittedAt:now(), exchangeId:null, manual};
    const next = {...book,pending,running:manual ? false : book.running,lastActionAt:now(),lastAction:"等待交易所委托回报"};
    // Persist before sending. A process restart must never resend an unknown request.
    commit(account, next);
    try {
      const exchangeId = await exchange.place(account, pending);
      commit(account, {...next,pending:{...pending,exchangeId}});
    } catch (error) {
      if(error.code==="ORDER_REJECTED"){
        commit(account,{...next,pending:null,running:false,lastAction:error.message});
        throw error;
      }
      commit(account, {...next,running:false,lastAction:"交易所委托未确认，已暂停新增，请核对委托"});
      throw Error("交易所委托未确认，已暂停新增，请核对委托");
    }
  }

  async function settle(account, book, snapshot) {
    const pending = book.pending;
    if (!pending.exchangeId) throw Error("存在未知交易所委托，请在交易所核对");
    const fill = await exchange.order(account, pending.exchangeId,pending);
    const closing = pending.kind === "close";
    if (fill.side !== (closing ? "close_" : "open_") + pending.side ||
      !(Number.isFinite(fill.contracts)&&fill.contracts>=0) ||
      fill.contracts>0&&!(fill.price>0)||fill.contracts > pending.contracts&&!equalQty(fill.contracts,pending.contracts)) {
      throw Error("交易所委托回报与策略委托不一致");
    }
    if (![2,-1].includes(fill.status) || snapshot.working.includes(pending.exchangeId)) return;
    const old = book.position, remote = snapshot.positions[0];
    const expected = Number(((old?.contracts || 0) + (closing ? -1 : 1) * fill.contracts).toFixed(12));
    if (snapshot.positions.length > 1 || (equalQty(expected,0) ? !!remote :
        !remote || !remote.id || remote.side !== pending.side || !equalQty(remote.qty,expected) || !(remote.entry > 0) ||
        remote.leverage !== book.settings.leverage || old && remote.id !== old.remoteId)) {
      throw Error("成交已回报，交易所原生仓位尚未与成交数量一致");
    }
    const next = {...book,pending:null,lastActionAt:now(),lastAction:"交易所委托已撤销，未成交"};
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
      if(pending.plan){
        const m=pending.plan,stop=fill.price+(pending.side==="long"?-1:1)*m.distance;
        Object.assign(next.position,{id:pending.localId,stop,initialStop:stop,atr:m.atr,budget:m.budget,
          actualRisk:qty*(m.distance+fill.price*snapshot.feeRate*2),config:m.config,configHash:m.configHash,signalAt:m.signalAt,
          ...(m.entry?{target:m.entry.target,entryMode:m.entry.mode,plannedNetR:m.netR}:{})});
      }
      next.lastAction = pending.kind === "add" ? "实盘补仓已核对成交" : "实盘首仓已核对成交";
    } else {
      const entryFee = usableFee(old.fee) ? old.fee * fill.contracts / old.contracts : null;
      const fees = entryFee !== null && fee !== null ? entryFee + fee : null;
      const gross = (pending.side === "long" ? 1 : -1) * (fill.price-old.entry) * qty;
      const trade = {id:pending.exchangeId,time:now(),side:pending.side,entryPrice:old.entry,exitPrice:fill.price,qty,
        contracts:fill.contracts,firstFill:old.firstFill,fills:old.fills,addCount:old.adds,
        strategy:book.strategy||"classic",tradingFee:fees,grossPnl:gross,netPnl:fees===null?null:gross-fees,
        reason:pending.reason||(pending.manual?"实盘手动平仓":"实盘策略止盈"),sampleType:"Live"};
      next.trades = [trade,...book.trades];
      if(next.day&&trade.netPnl!==null)next.day={...next.day,net:next.day.net+trade.netPnl};
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
      if (snapshot.working.length) throw Error("交易所存在未完成委托，请先核对");
      const mark = remote?.side === "short" ? snapshot.ask : snapshot.bid;
      if(book.strategy&&book.strategy!=="classic"){
        const p=book.position,hard=p&&(p.side==="long"?snapshot.bid<=p.stop:snapshot.ask>=p.stop);
        let decision;
        if(manual||hard)decision={intent:{kind:"close",meta:{reason:hard?
          Strategies.profile(book.strategy).config.stopOnly&&p.stop!==p.initialStop?"swing_trailing_exit":"hard_sl":"manual_close"}}};
        else{
          const research=await Strategies.analyze(account,book,snapshot,exchange,now());
          decision=Strategies.decide(account,book,snapshot,research,now(),false,
            (risk,side)=>permit?permit(account,risk,side):{allowed:true});
        }
        const next={...book,lastSignalAt:decision.lastSignalAt??book.lastSignalAt,lastSetupAt:decision.lastSetupAt??book.lastSetupAt,
          day:decision.day||book.day,lastAction:decision.decision?.reason?.replaceAll("模拟","实盘")||book.lastAction};
        if(p&&decision.position)next.position={...p,stop:decision.position.stop,
          lastManagedAt:decision.position.lastManagedAt,closedPeak:decision.position.closedPeak};
        if(!decision.intent){commit(account,next);return;}
        const order=decision.intent;
        if(order.kind==="open"){
          if(conflict(account))throw Error("同一实盘合约已有其他自动策略运行");
          await submit(account,next,entryIntent(next,snapshot,"open",order.meta),false);
        }else if(p){
          await submit(account,next,{kind:"close",side:p.side,contracts:p.contracts,
            price:(p.side==="long"?snapshot.bid:snapshot.ask).toFixed(snapshot.spec.digits),
            hedged:snapshot.mode===1,positionId:snapshot.mode===1?p.remoteId:null,reason:order.meta.reason},manual);
        }
        return;
      }
      // Trigger exits on the executable quote. Opening and adding use the same price rules as Paper.
      const entryPrice = book.settings.side === "long" ? snapshot.ask : snapshot.bid;
      const kind = Classic.nextAction({...book,cost:{slippage:0,exitFee:0}}, mark, now(), manual, entryPrice);
      if (!kind) {
        if (manual) throw Error("没有可由本策略平掉的实盘仓位");
        return;
      }
      if (kind === "close") {
        await submit(account, book, {kind,side:remote.side,contracts:remote.qty,
          price:(remote.side==="long"?snapshot.bid:snapshot.ask).toFixed(snapshot.spec.digits),
          hedged:snapshot.mode===1,positionId:snapshot.mode === 1 ? remote.id : null}, manual);
        return;
      }
      if (conflict(account)) throw Error("同一实盘合约已有其他自动策略运行");
      if(permit){const permission=permit(account,0,book.settings.side);if(!permission.allowed)throw Error(permission.reason);}
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
    const positions = fresh ? s.positions.map(p=>({...p,notional:p.qty*s.spec.unit*(s.bid+s.ask)/2,
      qtyUnit:p.qtyUnit|| (account.platform==="hotcoin"?"张":account.symbol)})) : native.positions || [];
    const selected = positions.filter(p => p.symbol === account.symbol&&(!p.quoteAsset||p.quoteAsset===account.quoteAsset));
    const position = selected.length === 1 ? selected[0] : null;
    const mark = fresh ? (s.bid+s.ask)/2 : native.mark ?? null;
    const plan = book && (book.strategy||"classic")==="classic" && !blocked ? Classic.tradePlan({...book,cost:{slippage:0,exitFee:0}}, mark, now()) : null;
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
      strategy:book?.strategy||"classic",strategyLabel:Strategies.profile(book?.strategy||"classic").label,
      strategies:Strategies.catalog(),settingsHash:settingsHash(book),protection:book?.position?{stop:book.position.stop,target:book.position.target}:null,
      managedPosition:!!book?.position, nativeLeverage:fresh?s.leverage:null,
      maxLeverage:fresh?s.spec.maxLeverage:null,
      equity:fresh?s.balance:native.equity??null, available:fresh?s.available:native.available??null,
      floating:fresh?s.unrealizedPnl:native.floating??null, valuationBasis:"native_equity",floatingBasis:"native_unrealized",
      updatedAt:fresh?s.at:native.updatedAt??null, realized, running:!!book?.running,
      blocked:blocked||!!pending&&!pending.exchangeId, pendingOrder:pending?{known:!!pending.exchangeId,kind:pending.kind}:null,
      margin:position?.margin??null, market:fresh||native.updatedAt?"原生账户已同步":"原生账户待核验",
      notice:blocked?"实盘账本待核对":messages.get(account.id)||book?.lastAction||"选择并保存实盘策略参数后即可核对启动",
      lastAction:book?.lastAction || "实盘策略尚未启动"};
  }

  return {get,configure,preflight,start,pause,tick,inspect,view};
}

module.exports = {create,eligible,settingsHash};
