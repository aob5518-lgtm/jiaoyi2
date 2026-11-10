(function () {
 "use strict";
 const $ = id => document.getElementById(id);
 const state = {data: null, id: new URLSearchParams(location.search).get("account") || "", busy: false, offline: true, dirty: false, request: 0, offset: 0, trades: [], filter: "all", switching: false};
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
 function money(id, value, unit, signed = false) {
  const target = $(id), text = format(value);
  target.textContent = text === "—" ? text : (signed && Number(value) > 0 ? "+" : "") + text + (unit ? " " + unit : "");
  target.className = signed && Number(value) !== 0 ? Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "" : "";
 }
 function renderPlan(account, snapshot) {
  const p = snapshot.position, plan = snapshot.plan, c = snapshot.settings;
  const price = snapshot.mark ?? p?.price;
  const amount = value => value == null ? "—" : format(value) + " " + account.quoteAsset;
  $("deskPrice").textContent = format(price, 6);
  $("deskPriceUnit").textContent = account.quoteAsset;
  $("deskOpenPrice").textContent = format(plan?.first.price ?? plan?.first.reference, 6);
  $("deskOpenStatus").textContent = plan ? p ? plan.first.price == null ? "旧记录未采集首仓价" : "实际首仓成交价" : plan.first.reference ? "当前报价估算，启动后市价模拟成交" : plan.first.status : "保存参数后生成开仓计划";
  $("deskOpenAmount").textContent = amount(plan?.first.amount);
  $("deskAverage").textContent = format(p?.entry, 6);
  $("deskAddPrice").textContent = format(plan?.add.price, 6);
  $("deskAddStatus").textContent = plan?.add.status || "等待经典参数";
  $("deskAddAmount").textContent = amount(plan?.add.amount);
  $("deskAddQty").textContent = plan?.add.quantity == null ? "—" : format(plan.add.quantity, 8) + " " + account.symbol + "（估算）";
  $("deskTargetPrice").textContent = format(plan?.exit.price, 6);
  $("deskExitStatus").textContent = plan?.exit.status || "暂无计划";
  $("deskTargetDistance").textContent = plan?.exit.price > 0 && price > 0 ? format((plan.exit.price / price - 1) * 100) + "%" : "—";
  $("deskTargetReturn").textContent = c ? format(c.takeProfit * 100) + "% 保证金" : "—";
  const strip = $("deskPosition");
  strip.replaceChildren();
  for (const [label, value] of Object.entries({
   "方向": p?.side === "long" ? "做多" : p?.side === "short" ? "做空" : c?.side === "long" ? "计划做多" : c?.side === "short" ? "计划做空" : "—",
   "持仓数量": p ? format(p.qty, 8) + " " + account.symbol : "0",
   "补仓次数": plan ? plan.add.done + " / " + plan.add.limit : "—",
   "本轮最近成交": format(plan?.add.lastPrice ?? plan?.first.price, 6)
  })) {const item = node("span", label);item.append(node("b", value));strip.append(item);}
  const box = $("deskFills");
  box.replaceChildren();
  for (const fill of plan?.fills || []) {
   const row = node("tr");
   row.append(node("td", time(fill.at)), node("td", fill.kind === "open" ? "首仓" : "补仓"), node("td", format(fill.price, 6)),
    node("td", format(fill.qty, 8)), node("td", format(fill.notional)));
   box.append(row);
  }
  if (!plan?.fills?.length) {
   const row = node("tr"), cell = node("td", p ? "旧仓位未采集逐笔明细，均价保留在上方" : "暂无本轮成交", "empty-cell");
   cell.colSpan = 5;row.append(cell);box.append(row);
  }
 }
 function renderList() {
  const box = $("deskAccounts");
  box.replaceChildren();
  const query = $("deskSearch").value.trim().toLowerCase();
  const all = state.data?.accounts || [];
  const matches = all.filter(a => [a.name, a.platform, a.symbol].join(" ").toLowerCase().includes(query) &&
   (state.filter === "all" || state.filter === "running" && a.running || state.filter === "position" && a.hasPosition));
  $("deskCount").textContent = all.length + " 个账户 · " + all.filter(a => a.running).length + " 个监控中";
  for (const account of matches) {
   const button = node("button", "", "account-select"), head = node("span", "", "rail-name");
   button.setAttribute("aria-pressed", String(account.id === state.id));
   button.disabled = state.busy || state.switching;
   head.append(node("strong", account.name), node("small", account.error ? "异常" : account.running ? "运行" : "停止"));
   const net = account.floating == null ? null : Number(account.floating) + Number(account.realized || 0);
   const foot = node("span", (account.paper ? "模拟" : "Live · 只读") + " · " + (net == null ? account.hasPosition ? "有仓位" : "空仓" : "总净盈亏 " + format(net)), "rail-pnl");
   if (net != null) foot.classList.add(net > 0 ? "positive" : net < 0 ? "negative" : "neutral");
   button.append(head, node("span", (labels[account.platform] || account.platform) + " · " + account.symbol + " / " + account.quoteAsset, "rail-pair"), foot);
   button.title = account.name;
   button.onclick = () => {
    if (state.busy || state.switching || account.id === state.id) return;
    const select = $("connectionSwitcher");
    if ([...select.options].some(option => option.value === account.id)) {
     select.value = account.id;
     select.dispatchEvent(new Event("change"));
    } else message("账户切换器尚未就绪，请刷新后重试。");
   };
   box.append(button);
  }
  if (!matches.length) {
   box.append(node("p", "未找到账户", "muted"));
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
  $("deskBudget").textContent = (state.dirty ? "未保存 · " : "") + "最大计划名义仓位 " + format(notional) + " · 计划保证金 " + format(notional / c.leverage);
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
  renderPlan(a, s);
  $("deskNext").textContent = a.error || s.notice || "等待下一次有效行情";
  $("deskLast").textContent = "最近动作 · " + (s.lastAction || "暂无");
  $("deskUpdated").textContent = "行情时间 · " + time(s.updatedAt);
  $("deskSafety").hidden = a.ready;
  $("deskSafety").href = "/safety-console.html?account=" + encodeURIComponent(a.id) + "#overview";
  for (const button of document.querySelectorAll("[data-action]")) {
   const action = button.dataset.action;
   button.disabled = state.busy || state.switching || state.offline || !a.ready || (action === "pause" ? !a.running :
     action === "start" && state.dirty ||
     !a.eligible || s.blocked || (action === "start" ? a.running : !p));
  }
  $("deskConfigAccount").textContent = a.name + " · " + a.symbol + " / " + unit;
  const editable = !state.offline && !state.busy && !state.switching && a.eligible && !a.running && !p && !s.blocked && !data.ledgerBlocked;
  $("deskConfigHint").textContent = data.ledgerBlocked || s.blocked ? "模拟账本或账户配置需核验，已锁定。" : !a.eligible ? "请选择经典模拟账户，或在账户管理新增模拟账户。" :
   p || a.running ? "本轮参数已锁定，暂停并结清模拟仓位后可修改。" : "参数保存后保持停止，点击上方按钮启动。";
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
   loadTrades();
  } catch (error) {
   if (ticket !== state.request) return;
   state.offline = true;
   message(error.message);
   render();
  }
 }
 async function mutate(route, input, success) {
  if (state.busy || state.switching || state.offline) return;
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
   if (id !== state.id || offset !== state.offset || state.switching) return;
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
  } catch (error) {
   if (id === state.id) {state.trades = [];$("deskExport").disabled = true;message(error.message);}
  }
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
 for (const button of document.querySelectorAll("[data-action]")) button.onclick = () => {
  const action = button.dataset.action, a = state.data?.selected;
  if (!a || button.disabled) return;
  if (action !== "pause" && !confirm((action === "start" ? "启动经典模拟交易" : "平掉全部模拟仓位并暂停") + " · " + a.name + "？")) return;
  mutate("control", {action, ...(action === "close" ? {confirm: true} : {})}, action === "start" ? "已启动经典模拟，等待有效行情。" : action === "pause" ? "已暂停新增交易。" : "模拟仓位已平，策略已暂停。");
 };
 form.oninput = () => {state.dirty = true;updateBudget();for (const button of document.querySelectorAll('[data-action="start"]')) button.disabled = true;};
 form.onsubmit = event => {event.preventDefault();if (form.reportValidity()) mutate("settings", {settings: settingsValues()}, "经典参数已保存。可回到总览启动模拟。");};
 $("deskRefresh").onclick = async () => {message("");await load();};
 $("deskSearch").oninput = renderList;
 $("deskPrev").onclick = () => {state.offset = Math.max(0,state.offset - 30);loadTrades();};
 $("deskNextPage").onclick = () => {state.offset += 30;loadTrades();};
 document.addEventListener("just-account-selecting", event => {
  if (state.busy || state.switching || state.dirty && !confirm("当前参数尚未保存，确认放弃修改并切换账户？")) return event.preventDefault();
  state.switching = true;state.request++;render();
 });
 document.addEventListener("just-account-switch-finished", event => {
  state.switching = false;
  if (!event.detail.success) {message("账户切换失败，已保留原账户和参数。");render();}
 });
 document.addEventListener("just-account-selected", async event => {
  state.switching = false;
  state.id = event.detail;state.data = null;state.dirty = false;state.offset = 0;state.offline = true;state.trades = [];
  $("deskAccount").textContent = "正在切换账户…";
  for (const id of ["deskEquity","deskFloating","deskRealized","deskAvailable","deskOpenPrice","deskAddPrice","deskTargetPrice"]) $(id).textContent = "—";
  $("deskTrades").replaceChildren();
  $("deskExport").disabled = true;$("deskSave").disabled = true;
  for (const button of document.querySelectorAll("[data-action]")) button.disabled = true;
  message("");await load();
 });
 const dialog = $("connectionDialog");
 function openConnections() {dialog.showModal();document.dispatchEvent(new CustomEvent("workspacepage", {detail: "connections"}));}
 $("openConnections").onclick = openConnections;
 $("openConnectionsTop").onclick = openConnections;
 $("closeConnections").onclick = () => dialog.close();
 $("newConnectionQuick").onclick = () => $("newConnection").click();
 for (const button of document.querySelectorAll("[data-filter]")) button.onclick = () => {
  state.filter = button.dataset.filter;
  for (const option of document.querySelectorAll("[data-filter]")) option.setAttribute("aria-pressed", String(option === button));
  renderList();
 };
 load();
 setInterval(() => {if (!state.busy && !state.switching && document.visibilityState === "visible") load();}, 10000);
})();
