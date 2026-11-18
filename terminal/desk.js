"use strict";
const C = require("./classic-paper");
const Live = require("./classic-live");
const Leverage = require("../market_leverage");
const {number, historyRows} = require("./model");
const paperLabels = {funding_carry_v1:"资金费率对冲",reversal_4h_v1:"找底摸顶 4H",turtle_4h_v1:"海龟趋势 4H",pullback_15m_v1:"短线顺势回踩",chart_swing_1h_v1:"图示波段 1H"};

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
function accountRow(account, st, classic, live) {
  const view = live || classic;
  return {
    id: account.id, name: account.name, symbol: account.symbol, quoteAsset: account.quoteAsset,
    platform: account.platform, strategyType: account.strategyType, archivedAt:account.archivedAt||null, paper: account.tradeMode === "simulation" && account.simulationEnabled === true,
    strategy: live ? live.strategyLabel+" · 实盘" : Object.hasOwn(paperLabels,account.strategyType)?paperLabels[account.strategyType]:C.eligible(account)?"经典补仓":account.tradeMode==="live"?"真实账户连接":"归档账户",
    ready: live ? !!live.settings : !!classic, eligible: !account.archivedAt&&(!!live||C.eligible(account)),
    running: view?.running ?? !!st?.running, liveStrategy:!!live,
    hasPosition: view ? !!(view.position||live?.managedPosition) : Number(st?.positionQty || st?.realPositionSize || 0) > 0,
    floating: view?.floating ?? null, realized: view?.realized ?? null,
    error: view?.blocked ? view.notice : st?.activeError || null
  };
}
async function preflight(account, st, d) {
  const book = d.classicPaper.get(account.id), blockers = [];
  if(account.archivedAt)blockers.push("账户已移出列表，请先恢复账户");
  if(!C.eligible(account))blockers.push("请选择可配置的经典模拟账户");
  if(!book)blockers.push("请先保存经典策略参数");
  if(st.riskLock||st.legacyLedgerBlocked)blockers.push("账户风险或账本尚未完成核对");
  if(st.pendingOrder||st.placingOrder||st.smartExitPending)blockers.push("存在尚未完成的委托或退出流程");
  if(d.classicPaper.corrupt())blockers.push("模拟账本损坏，不能启动");
  if(book && (!d.classicPaper.view(account) || d.classicPaper.view(account).blocked))blockers.push("配置与账本不一致");
  if(!blockers.length){const price=await d.price(account);if(!(Number.isFinite(price)&&price>0))blockers.push("当前行情报价无效");}
  if(!blockers.length&&book?.settings.leverage>1&&d.leverageRules){
    const issue=Leverage.leverageError(book.settings.leverage,await d.leverageRules(account),C.totalNotional(book.settings));
    if(issue)blockers.push(issue);
  }
  return {allowed:!blockers.length,blockers,mode:"Paper",realOrderPermission:false,settings:book?.settings||null};
}
async function handle(req, res, parsed, d) {
  const send = (code, data) => d.json(res, code, data);
  const route = parsed.pathname;
  let lock, st, mutating = false;
  try {
    if (req.method === "GET") {
      const account = d.getAccountById(parsed.query.id || d.getCurrentAccount()?.id);
      if (!account) return send(404, {ok: false, error: "账户不存在"});
      const live = d.classicLive && Live.eligible(account) ? d.classicLive : null;
      if(route==="/api/v4/desk/leverage"){
        if(!live)return send(200,{ok:true,spec:await d.leverageRules(account)});
        await live.inspect(account);
        const maxLeverage=live.view(account).maxLeverage;
        return send(200,{ok:true,spec:maxLeverage?{market:account.platform+" 永续",step:account.platform==="extended"?.1:1,tiers:[{floor:0,cap:null,maxLeverage}]}:null});
      }
      const classic = d.classicPaper.view(account);
      if (route === "/api/v4/desk/history") {
        const book = live ? live.get(account.id) : d.classicPaper.get(account.id);
        const items = book ? book.trades : historyRows(d.legacyHistory(account)).map(item => ({
          id: item.voucherId || item.id, time: item.exitTime || item.time, side: item.side,
          entryPrice: item.entryPrice ?? item.averagePrice, exitPrice: item.exitPrice, qty: item.closeQty ?? item.filledQty,
          netPnl: item.netPnl, tradingFee: item.tradingFee, reason: item.closeReason, sampleType: item.sampleType
        }));
        const offset = Math.min(Math.max(0, Math.floor(Number(parsed.query.offset) || 0)), items.length);
        return send(200, {ok: true, total: items.length, items: items.slice(offset, offset + 30)});
      }
      if (!["/api/v4/desk", "/api/v4/desk/preflight"].includes(route)) return send(404, {ok: false, error: "接口不存在"});
      st = d.state(account.id);
      if(route==="/api/v4/desk/preflight")return send(200,{ok:true,...await (live?live.preflight(account):preflight(account,st,d))});
      if(live&&!account.archivedAt){await live.inspect(account);}
      else if(!(account.tradeMode==="simulation"&&account.simulationEnabled===true)&&d.readNative){try{await d.readNative(account);}catch{/* Return unavailable fields, not stale cached numbers. */}}
      const liveView = live?.view(account);
      const snapshot = liveView || classic || d.readOnlyStatus(account, st);
      const selected={...accountRow(account,st,classic,liveView),...(snapshot.native&&snapshot.updatedAt?{hasPosition:!!snapshot.positions?.length}:{})};
      return send(200, {ok: true, selected,
        accounts: d.accounts().map(a => a.id===account.id?selected:accountRow(a, d.state(a.id), d.classicPaper.view(a),d.classicLive?.view(a))),
        snapshot, defaultSettings: C.defaults, ledgerBlocked: live ? false : d.classicPaper.corrupt()});
    }
    if (req.method !== "POST" || !["/api/v4/desk/settings", "/api/v4/desk/control"].includes(route)) return send(405, {ok: false, error: "操作不支持"});
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, {ok: false, error: "请在本站操作"});
    const input = await readBody(req);
    const settings = route.endsWith("/settings");
    if (Object.keys(input).some(key => !(settings ? ["id", "settings","strategy","expectedHash"] : ["id", "action", "confirm","settingsHash"]).includes(key))) throw Error("请求字段不支持");
    const account = d.getAccountById(input.id);
    if(account?.archivedAt&&!["pause","close"].includes(input.action))throw Error("账户已移出列表，请先恢复账户");
    const live = d.classicLive && Live.eligible(account) ? d.classicLive : null;
    if (!account || !live && !C.eligible(account)) throw Error("此账户尚未接入经典补仓");
    st = d.state(account.id);
    if (!st || st.tickRunning || st.placingOrder || st.terminalMutating) throw Error("正在处理本轮行情，请稍后重试");
    lock = d.lock(account.id);
    if (!lock) throw Error("账户正在处理其他操作");
    st.terminalMutating = mutating = true;
    if (live) {
      if (settings) {
        if(st.riskLock||st.pendingOrder||st.smartExitPending)throw Error("原账户风险或委托待核对，暂不能切换策略");
        if(live.get(account.id)&&input.expectedHash!==Live.settingsHash(live.get(account.id)))throw Error("参数已被其他页面修改，请刷新后再保存");
        live.configure(account,input.settings,input.strategy||"classic");
      } else if (input.action === "pause") {
        live.pause(account);
      } else {
        if (!["start","close"].includes(input.action) || input.confirm !== true) throw Error("请选择实盘操作并明确确认");
        if (input.action === "start") {
          if (input.settingsHash!==Live.settingsHash(live.get(account.id))) throw Error("已保存的实盘参数发生变化，请重新核对后启动");
          if (st.riskLock || st.legacyLedgerBlocked || st.pendingOrder) throw Error("账户风险、账本或委托状态待核对");
          await live.start(account);
        } else {
          if (!live.get(account.id)?.position) throw Error("没有可由本策略平掉的实盘仓位");
          await live.tick(account,{manual:true});
        }
      }
      return send(200,{ok:true,snapshot:live.view(account)});
    }
    const book = d.classicPaper.get(account.id);
    if (settings) {
      if (!book) d.verifyLegacyFlat(account, st);
      const next=C.normalize(input.settings,Number(account.simulationBalance));
      if(next.leverage>1&&d.leverageRules)Leverage.assertAllowed(next.leverage,await d.leverageRules(account),C.totalNotional(next));
      d.classicPaper.configure(account,next);
    } else if (input.action === "close") {
      if (input.confirm !== true || !book?.position) throw Error("请明确确认平掉已有模拟仓位");
      const price = await d.price(account);
      d.classicPaper.mark(d.getAccountById(account.id), price, Date.now(), true);
    } else {
      if (input.action === "start") {const p=await preflight(account,st,d);if(!p.allowed)throw Error(p.blockers.join("；"));}
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
module.exports = {handle, accountRow, preflight};
