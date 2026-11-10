(function () {
 "use strict";
 const $ = id => document.getElementById(id);
 const state = {data: null, id: new URLSearchParams(location.search).get("account") || "", view: "overview", busy: false, offline: true, dirty: false, request: 0, offset: 0, trades: []};
 const names = {overview: "交易总览", strategy: "经典策略", history: "交易记录", connections: "账户管理"};
 const labels = {hyperliquid: "Hyperliquid", binance: "Binance", extended: "Extended"};
 const keys = ["side", "leverage", "baseAmount", "addAmount", "maxAdds", "addTrigger", "takeProfit"];
 const format = (value, digits = 2) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("zh-CN", {maximumFractionDigits: digits});
 const time = value => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false}) : String(value);
 };
 const node = (tag, text, cls) => {const el = document.createElement(tag);el.textContent = text ?? "";if (cls) el.className = cls;return el;};
 function message(value) {$("deskMessage").hidden = !value;$("deskMessage").textContent = value;}
 async function api(route, body) {
  const result = await fetch(route, {credentials: "same-origin", cache: "no-store",
   ...(body ? {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {})});
  if (result.status === 401) throw Error("登录已过期，请刷新页面后重新登录。");
  const data = await result.json();
  if (!result.ok || !data.ok) throw Error(data.error || "请求失败");
  return data;
 }
 function show(view) {
  state.view = names[view] ? view : "overview";
  $("pageTitle").textContent = names[state.view];
  for (const section of document.querySelectorAll("[data-page]")) section.hidden = section.dataset.page !== state.view;
  for (const button of document.querySelectorAll(".sidebar [data-view]")) {
   if (button.dataset.view === state.view) button.setAttribute("aria-current", "page");
   else button.removeAttribute("aria-current");
  }
  history.replaceState(null, "", "#" + state.view);
  document.dispatchEvent(new CustomEvent("workspacepage", {detail: state.view}));
  if (state.view === "history") loadTrades();
 }
 function money(id, value, unit, signed = false) {
  const target = $(id), text = format(value);
  target.textContent = text === "—" ? text : (signed && Number(value) > 0 ? "+" : "") + text + (unit ? " " + unit : "");
  target.className = signed && Number(value) !== 0 ? Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "" : "";
 }
 function facts(container, values) {
  container.replaceChildren();
  for (const [key, value] of Object.entries(values)) container.append(node("dt", key), node("dd", value));
 }
 function renderList() {
  const box = $("deskAccounts");
  box.replaceChildren();
  const query = $("deskSearch").value.trim().toLowerCase();
  const all = state.data?.accounts || [];
  const matches = all.filter(a => [a.name, a.platform, a.symbol].join(" ").toLowerCase().includes(query));
  $("deskCount").textContent = all.length + " 个账户 · " + all.filter(a => a.running).length + " 个监控中";
  for (const account of matches) {
   const row = node("tr", "", account.id === state.id ? "current-row" : "");
   const name = node("td"), button = node("button", account.name, "account-select");
   button.title = account.name;
   button.onclick = () => {
    if (state.busy || account.id === state.id) return;
    const select = $("connectionSwitcher");
    if ([...select.options].some(option => option.value === account.id)) {
     select.value = account.id;
     select.dispatchEvent(new Event("change"));
    } else {state.id = account.id;state.dirty = false;state.offset = 0;load();}
   };
   name.append(button);
   row.append(name, node("td", account.symbol + " / " + account.quoteAsset), node("td", account.paper ? "Paper" : "Live"),
    node("td", account.error ? "异常" : account.running ? "运行中" : account.ready ? "已暂停" : "未启用"),
    node("td", account.hasPosition ? "有仓位" : account.paper ? "空仓" : "查看账户"));
   box.append(row);
  }
  if (!matches.length) {
   const row = node("tr"), td = node("td", "未找到账户", "empty-cell");td.colSpan = 5;row.append(td);box.append(row);
  }
 }
 const form = $("deskSettings");
 const field = name => form.elements.namedItem(name);
 function settingsValues() {
  return Object.fromEntries(keys.map(name => [name, name === "side" ? field(name).value : Number(field(name).value) / (["addTrigger", "takeProfit"].includes(name) ? 100 : 1)]));
 }
 function updateBudget() {
  const c = settingsValues();
  const notional = c.baseAmount + c.addAmount * c.maxAdds;
  $("deskBudget").textContent = "最大计划名义仓位 " + format(notional) + " · 计划保证金 " + format(notional / c.leverage);
 }
 function render() {
  const data = state.data;
  $("deskHealth").textContent = state.offline ? "数据未同步" : "服务在线";
  $("deskHealth").className = "connection" + (state.offline ? "" : " ready");
  if (!data) return;
  const a = data.selected, s = data.snapshot, p = s.position, unit = a.quoteAsset;
  $("deskAccount").textContent = a.name;
  $("deskInstrument").textContent = (labels[a.platform] || a.platform) + " · " + a.symbol + " / " + unit;
  $("deskMode").textContent = a.paper ? "Paper · 模拟" : "Live · 原账户";
  $("deskRun").textContent = a.error || s.blocked ? "当前异常" : a.running ? "运行中" : a.ready ? "已暂停" : "未启用经典";
  $("deskMarket").textContent = state.offline ? "连接中断" : a.error ? "行情或执行异常" : s.market;
  $("deskStrategy").textContent = a.strategy;
  money("deskEquity", s.equity, unit);
  money("deskFloating", s.floating, unit, true);
  money("deskRealized", s.realized, unit, true);
  money("deskAvailable", s.available, unit);
  $("deskMargin").textContent = "占用保证金 " + format(s.margin);
  $("deskPositionBadge").textContent = p ? p.side === "long" ? "多仓" : "空头" : a.paper ? "空仓" : "原账户";
  facts($("deskPosition"), {
   "最新价": format(s.mark ?? p?.price, 6),
   "开仓均价": format(p?.entry, 6),
   "持仓数量": format(p?.qty, 8),
   "补仓次数": p && p.adds != null ? p.adds + " / " + s.settings.maxAdds : "—",
   "下次补仓价": format(p?.nextAdd, 6),
   "止盈目标价": format(p?.takeProfit ?? p?.target, 6)
  });
  $("deskNext").textContent = a.error || s.notice || "等待下一次有效行情";
  $("deskLast").textContent = "最近动作 · " + (s.lastAction || "暂无") + "　｜　行情时间 · " + time(s.updatedAt);
  $("deskSafety").hidden = a.ready;
  $("deskSafety").href = "/safety-console.html?account=" + encodeURIComponent(a.id) + "#overview";
  for (const button of document.querySelectorAll("[data-action]")) {
   const action = button.dataset.action;
   button.disabled = state.busy || state.offline || !a.ready || (action === "pause" ? !a.running :
     !a.eligible || s.blocked || (action === "start" ? a.running : !p));
  }
  $("deskConfigAccount").textContent = a.name + " · " + a.symbol + " / " + unit;
  const editable = !state.offline && !state.busy && a.eligible && !a.running && !p && !s.blocked && !data.ledgerBlocked;
  $("deskConfigHint").textContent = data.ledgerBlocked || s.blocked ? "模拟账本或账户配置需核验，已锁定。" : !a.eligible ? "请选择经典模拟账户，或在账户管理新增模拟账户。" :
   p || a.running ? "暂停并结清模拟仓位后再修改参数。" : "保存后保持停止，在交易总览明确启动。";
  if (!state.dirty) {
   const settings = s.settings || data.defaultSettings;
   for (const name of keys) field(name).value = ["addTrigger", "takeProfit"].includes(name) ? Number((settings[name] * 100).toFixed(6)) : settings[name];
   updateBudget();
  }
  for (const name of keys) field(name).disabled = !editable;
  $("deskSave").disabled = !editable;
  renderList();
 }
 async function load() {
  const ticket = ++state.request;
  try {
   const data = await api("/api/v4/desk" + (state.id ? "?id=" + encodeURIComponent(state.id) : ""));
   if (ticket !== state.request) return;
   state.data = data;
   state.id = data.selected.id;
   state.offline = false;
   render();
  } catch (error) {
   if (ticket !== state.request) return;
   state.offline = true;
   message(error.message);
   render();
  }
 }
 async function mutate(route, input, success) {
  if (state.busy || state.offline) return;
  state.busy = true;render();
  try {await api("/api/v4/desk/" + route, {id: state.id, ...input});state.dirty = false;message(success);await load();}
  catch (error) {message(error.message);}
  finally {state.busy = false;render();}
 }
 async function loadTrades() {
  if (!state.id) return;
  const id = state.id, offset = state.offset;
  try {
   const data = await api("/api/v4/desk/history?id=" + encodeURIComponent(id) + "&offset=" + offset);
   if (id !== state.id || offset !== state.offset) return;
   state.trades = data.items;
   $("deskHistoryAccount").textContent = (state.data?.selected.name || "") + " · 已结算记录";
   const box = $("deskTrades");box.replaceChildren();
   for (const item of data.items) {
    const row = node("tr");
    row.append(node("td", time(item.time)), node("td", item.side === "long" ? "多" : item.side === "short" ? "空" : item.side),
      node("td", format(item.entryPrice, 6) + " → " + format(item.exitPrice, 6)),
      node("td", format(item.netPnl, 4), item.netPnl > 0 ? "positive" : item.netPnl < 0 ? "negative" : ""),
      node("td", format(item.tradingFee, 4)), node("td", item.reason || "—"));
    box.append(row);
   }
   if (!data.items.length) {const row = node("tr"), td = node("td", "暂无已结算交易", "empty-cell");td.colSpan = 6;row.append(td);box.append(row);}
   $("deskHistoryCount").textContent = "共 " + data.total + " 笔";
   $("deskPrev").disabled = offset === 0;
   $("deskNextPage").disabled = offset + 30 >= data.total;
   $("deskExport").disabled = !data.items.length;
  } catch (error) {if (id === state.id) message(error.message);}
 }
 $("deskExport").onclick = () => {
  const cell = value => {
   let s = String(value ?? "");
   if (typeof value === "string" && /^[=+\-@\s]/.test(s)) s = "'" + s;
   return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = [["时间","方向","开仓价","平仓价","净盈亏","手续费","退出原因"], ...state.trades.map(t => [time(t.time),t.side,t.entryPrice,t.exitPrice,t.netPnl,t.tradingFee,t.reason])];
  const link = node("a"), url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n")], {type: "text/csv;charset=utf-8"}));
  link.href = url;link.download = "just-agent-trades.csv";link.click();setTimeout(() => URL.revokeObjectURL(url), 1000);
 };
 for (const button of document.querySelectorAll("[data-view]")) button.onclick = () => show(button.dataset.view);
 for (const button of document.querySelectorAll("[data-action]")) button.onclick = () => {
  const action = button.dataset.action, a = state.data?.selected;
  if (!a || button.disabled) return;
  if (action !== "pause" && !confirm((action === "start" ? "启动经典模拟交易" : "平掉全部模拟仓位并暂停") + " · " + a.name + "？")) return;
  mutate("control", {action, ...(action === "close" ? {confirm: true} : {})}, action === "start" ? "已启动经典模拟，等待有效行情。" : action === "pause" ? "已暂停新增交易。" : "模拟仓位已平，策略已暂停。");
 };
 form.oninput = () => {state.dirty = true;updateBudget();};
 form.onsubmit = event => {event.preventDefault();if (form.reportValidity()) mutate("settings", {settings: settingsValues()}, "经典参数已保存。可回到总览启动模拟。");};
 $("deskRefresh").onclick = async () => {message("");await load();if (state.view === "history") loadTrades();};
 $("deskSearch").oninput = renderList;
 $("deskPrev").onclick = () => {state.offset = Math.max(0,state.offset - 30);loadTrades();};
 $("deskNextPage").onclick = () => {state.offset += 30;loadTrades();};
 document.addEventListener("just-account-selected", async event => {
  state.id = event.detail;state.data = null;state.dirty = false;state.offset = 0;state.offline = true;state.trades = [];
  $("deskExport").disabled = true;$("deskSave").disabled = true;
  for (const button of document.querySelectorAll("[data-action]")) button.disabled = true;
  message("");await load();if (state.view === "history") loadTrades();
 });
 const initial = location.hash.slice(1);
 show(initial === "archive" ? "history" : initial);
 load().then(() => {if (state.view === "history") loadTrades();});
 setInterval(() => {if (!state.busy && document.visibilityState === "visible") load();}, 10000);
})();
