/* Research presentation only. Existing strategy configs and ledgers remain authoritative. */
(function () {
 "use strict";

 const $ = id => document.getElementById(id);
 const state = {
  accounts: [], id: "", busy: false, writing: false, connected: false,
  access: "", research: null, page: "overview", updatedAt: null,
  archive: [], archiveLoaded: false, archiveBusy: false, archiveSelectedId: ""
 };
 const pageNames = {
  overview: "研究总览", plan: "策略规划", experiments: "实验管理",
  history: "研究记录", analysis: "证据与验证", archive: "历史归档", connections: "账户管理"
 };
 const marketLabels = {
  TREND_UP: "上涨趋势", TREND_DOWN: "下跌趋势", RANGE: "震荡",
  EXTREME_VOLATILITY: "极端波动", UNKNOWN: "数据不足"
 };
 const decisionLabels = {
  NO_SIGNAL: "等待有效信号", ORDER_SUBMITTED: "研究订单已提交",
  ORDER_FILLED: "模拟成交", POSITION_MANAGED: "管理已有仓位",
  DATA_ERROR: "行情读取失败", ORDER_WAITING: "等待模拟成交",
  ORDER_REJECTED: "模拟订单被拒绝", UNKNOWN_ORDER: "订单待核对",
  ORDER_CANCELLED: "研究订单已取消", ORDER_EXPIRED: "研究订单已过期"
 };
 function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
 }
 const fmt = value => value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))
  ? "暂无数据" : typeof value === "number" ? value.toLocaleString("zh-CN", {maximumFractionDigits: 4}) : String(value);
 const time = value => value ? new Date(value).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"}) + " UTC+8" : "尚未评估";
 const current = () => state.accounts.find(account => account.id === state.id);
 function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
 }
 function showPage(page) {
  if (!pageNames[page]) page = "overview";
  state.page = page;
  for (const section of document.querySelectorAll?.("[data-page]") || []) section.hidden = section.dataset.page !== page;
  for (const button of document.querySelectorAll?.("[data-view]") || []) {
   if (button.dataset.view === page) button.setAttribute("aria-current", "page");
   else button.removeAttribute("aria-current");
  }
  $("pageTitle").textContent = pageNames[page];
  if (typeof CustomEvent !== "undefined") document.dispatchEvent?.(new CustomEvent("workspacepage", {detail: page}));
  if (typeof history !== "undefined" && typeof location !== "undefined") history.replaceState(null, "", "#" + page);
  if (page === "archive" && !state.archiveLoaded) loadArchive();
 }
 function rows(id, values) {
  const node = $(id);
  node.replaceChildren();
  for (const [label, value] of Object.entries(values)) node.append(el("dt", label), el("dd", fmt(value)));
 }
 async function request(path, body, research = false) {
  const response = await fetch(path, {
   method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
   headers: {
    ...(research && state.access ? {Authorization: "Bearer " + state.access} : {}),
    ...(body === undefined ? {} : {"Content-Type": "application/json"})
   },
   ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  let data;
  try { data = await response.json(); } catch { throw Error("模块暂不可用，请检查服务或登录状态"); }
  if (!response.ok || data.ok === false) throw Error(response.status === 401 ? "登录已过期或研究凭据缺失，请刷新登录或连接独立服务。" : data.error || "请求失败，请稍后重试");
  return data;
 }
 const api = (route, body) => request("/api/v5/" + route, body, true);
 function renderOverview() {
  const positions = state.accounts.filter(account => account.position).length;
  const orders = state.accounts.filter(account => account.pending).length;
  const running = state.accounts.filter(account => account.running).length;
  const trades = state.accounts.reduce((sum, account) => sum + (Number(account.metrics?.trades) || 0), 0);
  $("connection").textContent = state.connected ? "研究服务已连接" : "研究服务未连接";
  $("connection").className = "connection" + (state.connected ? " ready" : "");
  $("researchStatus").textContent = state.connected ? "规则定义中" : "等待连接";
  $("experimentCount").textContent = state.connected ? String(state.accounts.length) : "—";
  $("experimentNote").textContent = state.connected ? running + " 个运行 · " + (state.accounts.length - running) + " 个停止" : "无法确认运行状态";
  $("openCount").textContent = state.connected ? String(positions) : "—";
  $("openNote").textContent = state.connected ? positions + " 个仓位 · " + orders + " 个待确认订单" : "请恢复连接后核对";
  $("tradeCount").textContent = state.connected ? String(trades) : "—";
  $("overviewMode").textContent = state.connected ? "Shadow 基线研究" : "连接中断";
  $("lastUpdated").textContent = state.updatedAt ? "最近同步 " + time(state.updatedAt) : "尚未成功同步";
  if (!state.connected) $("activity").textContent = "研究服务连接未就绪。运行与仓位状态暂无法确认，操作已禁用。";
  else if (!state.accounts.length) $("activity").textContent = "暂无参考实验。可先在策略规划中审查新候选的规则和验证条件。";
  else if (!running && !positions && !orders) $("activity").textContent = "现有 " + state.accounts.length + " 个基线实验已停止，当前无仓位或挂单。新候选仍处于规则定义阶段。";
  else $("activity").textContent = running + " 个基线实验正在评估，" + positions + " 个仓位接受模拟保护。请在实验管理中核对最新判断。";
 }
 function renderAccount() {
  const account = current();
  const metrics = $("metrics");
  metrics.replaceChildren();
  $("start").disabled = !state.connected || !account || account.entryAllowed === false || account.running || account.riskLock || state.writing;
  $("pause").disabled = !state.connected || !account || !account.running || state.writing;
  $("create").querySelector?.('[type="submit"]')?.toggleAttribute("disabled", !state.connected || state.writing);
  $("empty").hidden = !!account || !state.connected;
  if (!account) {
   $("mode").textContent = state.connected ? "尚无参考实验" : "连接未就绪";
   $("decision").textContent = "选择基线实验后读取执行诊断";
   for (const id of ["market", "position", "report", "audit", "trades", "hypotheses"]) $(id).replaceChildren();
   $("trades").append(el("p", "当前没有可展示的研究记录。"));
   renderResearch();
   return;
  }
  const m = account.metrics;
  const signal = account.lastSnapshot?.signal;
  const decision = account.lastSnapshot?.decision;
  const position = account.position;
  const mark = account.lastSnapshot?.markPrice ?? signal?.referencePrice;
  $("mode").textContent = account.running ? "Shadow · 评估运行中" : "Shadow · 已停止";
  if (account.riskLock) $("mode").textContent += " · 风控锁定";
  for (const [label, value] of Object.entries({
   "已结算研究权益": account.equity,
   "累计虚拟净收益": m.trades ? m.netPnl : null,
   "最大回撤": m.maxDrawdown === null ? null : (m.maxDrawdown * 100).toFixed(2) + "%",
   "当前净 R": position && mark ? (mark - position.entryPrice) * (position.side === "long" ? 1 : -1) / position.distance : null
  })) {
   const card = el("article", undefined, "metric");
   card.append(el("span", label), el("strong", fmt(value)));
   metrics.append(card);
  }
  const reasons = decision?.blockers?.length ? decision.blockers : signal?.blockers;
  const versionWarning = account.engineRevision && account.scope.strategyRevision !== account.engineRevision ? "旧版本仅保留保护与审查。" : "";
  $("decision").textContent = versionWarning + (reasons?.join("；") || decisionLabels[decision?.finalDecision] || "尚未评估") + " · " + (decision?.finalDecision || "NOT_EVALUATED");
  rows("market", {
   "交易对": account.symbol + " / USDT", "环境": marketLabels[signal?.regime?.state] || signal?.regime?.state,
   "方向": ({long: "做多", short: "做空", none: "待确认"})[signal?.direction],
   "ADX": signal?.regime?.adx, "1H ATR": signal?.atr,
   "突破确认": signal?.breakout?.passed ? "已确认" : "尚未确认",
   "信号许可": signal?.signalPermission, "计划状态": decision?.planDecision,
   "执行许可": decision?.executionPermission, "评估时间": time(decision?.time),
   "周末模式": account.config.weekendMode, "风险预算": account.config.riskPerTrade * 100 + "%"
  });
  rows("position", {
   "持仓方向": position ? position.side === "long" ? "做多" : "做空" : "空仓",
   "模拟数量": position?.qty, "入场价格": position?.entryPrice, "当前止损": position?.stop,
   "模拟保护": position?.protection, "初始风险": position?.initialRiskAmount,
   "移动保护": position?.trailing ? "已启动" : "未启动", "风险锁": account.riskReason || "无"
  });
  rows("report", {
   "样本类型": "独立 Shadow 前向", "完成交易": m.trades, "胜率": m.trades ? (m.winRate * 100).toFixed(1) + "%" : null,
   "净期望 R": m.expectancyR, "Profit Factor": m.profitFactor, "交易费用": m.totalFees,
   "资金费": m.fundingPnl, "置信区间": m.netRConfidence95?.join(" ~ "),
   "实验编号": account.scope.experimentId, "配置哈希": account.scope.configHash
  });
  $("audit").textContent = JSON.stringify({scope: account.scope, config: account.config, lastSnapshot: account.lastSnapshot, metrics: m}, null, 2);
  renderTrades("trades", account.history);
  renderResearch();
  const hypotheses = $("hypotheses");
  hypotheses.replaceChildren();
  for (const h of account.hypotheses || []) {
   const block = el("article");
   block.append(el("h3", h.id + " · " + h.status), el("p", h.hypothesis));
   hypotheses.append(block);
  }
 }
 function renderTrades(id, trades) {
  const box = $(id);
  box.replaceChildren();
  if (!trades?.length) box.append(el("p", "暂无交易记录。尚未发生的成交不计入研究收益。"));
  for (const trade of [...(trades || [])].reverse()) {
   const net = trade.netPnl;
   const row = el("article", undefined, "trade");
   row.append(
    el("strong", (trade.side === "long" ? "多" : trade.side === "short" ? "空" : "方向未记录") + " · " + fmt(net) + " USDT", net < 0 ? "loss" : "profit"),
    el("p", time(trade.entryTime) + " → " + time(trade.exitTime || trade.time)),
    el("p", fmt(trade.entryPrice) + " → " + fmt(trade.exitPrice) + " · " + fmt(trade.netR ?? trade.rMultiple) + " R"),
    el("small", "原始退出原因 " + (trade.closeReason || "旧记录未采集"))
   );
   box.append(row);
  }
 }
 function renderResearch() {
  const symbol = current()?.symbol || "ETH";
  const research = state.research?.assets?.[symbol];
  $("researchGate").textContent = research
   ? "H01 基线 · " + symbol + " · 未通过研究门槛。新候选尚无收益结果。"
   : "历史报告尚未加载，无法评价验证结论。";
  if (!research) { $("backtest").textContent = "报告暂不可用"; return; }
  const segment = research.splits.outOfSample;
  rows("backtest", {
   "数据来源": research.source + " · 2024",
   "结论": research.gate.status, "未通过原因": research.gate.reasons.join(" / "),
   "样本外交易": segment.metrics.trades, "样本外净收益": segment.metrics.netPnl,
   "样本外净期望 R": segment.metrics.expectancyR,
   "最大回撤": (segment.metrics.maxDrawdown * 100).toFixed(2) + "%"
  });
  $("weekendResults").textContent = "周末对照 · " + research.weekendComparison.map(item => item.mode + " / " + item.metrics.trades + " 笔 / " + fmt(item.metrics.netPnl) + " U").join("；") + "。当前 A/C 底层条件等价，未证明独立增益。";
  const points = segment.curve || [];
  const box = $("curve");
  box.replaceChildren();
  if (points.length < 2 || !document.createElementNS) return;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const line = document.createElementNS(ns, "polyline");
  const low = Math.min(...points.map(point => point.equity));
  const high = Math.max(...points.map(point => point.equity));
  svg.setAttribute("viewBox", "0 0 600 150");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "H01 样本外历史净值");
  line.setAttribute("points", points.map((point, index) => (10 + index / (points.length - 1) * 580) + "," + (140 - (point.equity - low) / Math.max(.00001, high - low) * 125)).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#73d9cd");
  line.setAttribute("stroke-width", "2");
  svg.append(line);
  box.append(el("p", "样本外历史净值 · 非当前前向表现"), svg);
 }
 function render() {
  renderOverview();
  renderAccount();
 }
 async function load() {
  if (state.busy) return;
  state.busy = true;
  try {
   const data = await api("status");
   state.connected = !data.error;
   state.accounts = data.accounts || [];
   state.updatedAt = Date.now();
   if (!state.accounts.some(account => account.id === state.id)) state.id = state.accounts[0]?.id || "";
   const select = $("accounts");
   select.replaceChildren();
   for (const account of state.accounts) {
    const option = el("option", account.symbol + " / USDT · H01 基线 · " + account.scope.configHash.slice(0, 8));
    option.value = account.id;
    select.append(option);
   }
   select.value = state.id;
   showError(data.error || "");
   if (!state.research) {
    try { state.research = await api("research"); } catch { $("researchGate").textContent = "验证报告读取失败，请刷新重试。"; }
   }
  } catch (error) {
   state.connected = false;
   showError(error.message);
  } finally {
   state.busy = false;
   $("accessPanel").hidden = state.connected;
   render();
  }
 }
 async function control(action) {
  if (state.writing || state.busy || !state.connected || !current()) return;
  if (action === "start" && typeof confirm === "function" && !confirm("仅启动未通过收益验证的 H01 基线 Shadow 研究？新候选仍处于规划阶段，不会开启真实交易。")) return;
  state.writing = true;
  renderAccount();
  try {
   await api("control", {id: state.id, action});
   await load();
  } catch (error) { showError(error.message); }
  finally { state.writing = false; renderAccount(); }
 }
 function renderArchive() {
  const query = $("archiveSearch").value.trim().toLowerCase();
  const box = $("archiveAccounts");
  box.replaceChildren();
  const accounts = state.archive.filter(account => [account.name, account.symbol, account.platform].join(" ").toLowerCase().includes(query));
  $("archiveStatus").textContent = state.archiveLoaded ? "共 " + state.archive.length + " 个历史账户，当前匹配 " + accounts.length + " 个。只读检索不会选择或启动原账户。" : "归档尚未加载";
  for (const account of accounts) {
   const card = el("button", undefined, "archive-item");
   card.append(el("strong", account.name), el("small", account.platform + " · " + account.symbol + " / " + (account.quoteAsset || "")), el("small", account.running ? "原监控仍在运行 · 可查看风险处理" : "原监控已停止"));
   card.onclick = () => loadArchiveHistory(account);
   box.append(card);
  }
  if (!accounts.length) box.append(el("p", "没有符合搜索条件的历史账户。"));
 }
 async function loadArchive() {
  if (state.archiveBusy) return;
  state.archiveBusy = true;
  $("archiveStatus").textContent = "正在只读读取历史账户…";
  try {
   const data = await request("/api/v4/terminal");
   state.archive = data.accounts || [];
   state.archiveLoaded = true;
   renderArchive();
  } catch (error) { $("archiveStatus").textContent = error.message; }
  finally { state.archiveBusy = false; }
 }
 async function loadArchiveHistory(account) {
  state.archiveSelectedId = account.id;
  $("archiveDetail").hidden = false;
  $("archiveTitle").textContent = account.name + " · 原历史账本";
  $("safetyLink").href = "/safety-console.html?account=" + encodeURIComponent(account.id) + "#overview";
  $("archiveHistory").textContent = "正在读取历史…";
  try {
   const data = await request("/api/v4/history?id=" + encodeURIComponent(account.id) + "&limit=50");
   if (state.archiveSelectedId === account.id) renderTrades("archiveHistory", data.items);
  } catch (error) { if (state.archiveSelectedId === account.id) $("archiveHistory").textContent = error.message; }
 }
 for (const button of document.querySelectorAll?.("[data-view]") || []) button.onclick = () => showPage(button.dataset.view);
 $("setup").onclick = () => showPage("plan");
 $("connect").onclick = () => { state.access = $("access").value; $("access").value = ""; load(); };
 $("refresh").onclick = load;
 $("accounts").onchange = () => { state.id = $("accounts").value; renderAccount(); };
 $("start").onclick = () => control("start");
 $("pause").onclick = () => control("pause");
 $("archiveRefresh").onclick = loadArchive;
 $("archiveSearch").oninput = renderArchive;
 $("create").onsubmit = async event => {
  event.preventDefault();
  if (state.writing || !state.connected) return;
  const values = new FormData(event.target);
  state.writing = true;
  renderAccount();
  try {
   const result = await api("accounts", {symbol: values.get("symbol"), mode: "Shadow", initialEquity: Number(values.get("initialEquity")), config: {weekendMode: values.get("weekendMode"), riskPerTrade: Number(values.get("risk")) / 100}});
   state.id = result.account.id;
   await load();
  } catch (error) { showError(error.message); }
  finally { state.writing = false; renderAccount(); }
 };
 const initial = typeof location !== "undefined" ? location.hash.slice(1) : "overview";
 showPage(pageNames[initial] ? initial : initial === "settings" ? "experiments" : "overview");
 load();
 setInterval(load, 15000);
})();
