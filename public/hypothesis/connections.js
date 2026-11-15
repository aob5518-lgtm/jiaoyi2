(function () {
 "use strict";
 const $ = id => document.getElementById(id);
 const form = $("connectionForm");
 const desk=!!$("deskStarter");
 const keys = ["address", "privateKey", "apiKey", "apiSecret", "starkPrivateKey", "publicKey", "vault"];
 const state = {accounts: [], current: "", editing: "", busy: false, loaded: false, dirty: false};
 const field = name => form.elements.namedItem(name);
 function node(tag, text) {const item = document.createElement(tag);item.textContent = text;return item;}
 function message(text) {$("connectionStatus").textContent = text;}
 async function request(path, input) {
  const response = await fetch(path, {
   method: input === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
   headers: input === undefined ? {} : {"Content-Type": "application/json"},
   ...(input === undefined ? {} : {body: JSON.stringify(input)})
  });
  let data;
  try {data = await response.json();} catch {throw Error("账户模块未就绪，请刷新或重新登录");}
  if (!response.ok || data.ok === false) throw Error(data.error || "账户操作失败");
  return data;
 }
 function changePlatform() {
  for (const label of form.querySelectorAll("[data-exchanges]")) {
   label.hidden = !label.dataset.exchanges.split(" ").includes(field("platform").value);
  }
 }
 function selectEditor(id, internal = false) {
  if (state.busy && !internal) return;
  if (state.dirty && !confirm("有未保存的连接配置，确认放弃本次修改？")) return;
  state.editing = id;
  state.dirty = false;
  const account = state.accounts.find(item => item.id === id);
  form.reset();
  for (const key of keys) field(key).value = "";
  field("platform").disabled = !!account;
  field("symbol").disabled = !!account;
  $("connectionEquityLabel").hidden = !!account;
  $("checkConnection").disabled = !account || state.busy;
  $("selectConnection").disabled = !account || state.busy;
  if ($("connectionToSettings")) $("connectionToSettings").disabled = !account || state.busy;
  $("connectionFormTitle").textContent = account ? account.name + " · 连接配置" : "新增交易所账户";
  if(desk){
   form.querySelector('[type="submit"]').textContent=account?"保存账户配置":"创建并配置策略";
   form.querySelector(".connection-credentials").open=false;
  }
  $("connectionMode").textContent = account
   ? (account.simulationEnabled && account.tradeMode === "simulation" ? "Paper" : "Live") + " · " + (account.running ? "监控运行中，更新连接前需停止并核对风险" : "已停止") + (account.connectionOnly ? " · 未绑定交易策略" : "")
   : "新增账户默认 Paper、停止状态，未绑定交易策略。";
  if (account) {
   field("name").value = account.name;
   field("platform").value = account.platform;
   field("symbol").value = account.symbol;
   field("address").value = account.address || "";
   for (const key of keys.filter(key => key !== "address")) {
    const configured = account["has" + key[0].toUpperCase() + key.slice(1)];
    field(key).placeholder = configured ? "已配置，留空则不修改" : "尚未配置";
   }
  } else {
   for (const key of keys.filter(key => key !== "address")) field(key).placeholder = "选填；不会自动开启真实交易";
  }
  changePlatform();
  renderList();
  if (!internal && typeof matchMedia === "function" && matchMedia("(max-width:760px)").matches) form.parentElement.scrollIntoView({block: "start"});
 }
 function renderList() {
  const box = $("connectionList");
  if (!box) return;
  const query = $("connectionSearch").value.toLowerCase();
  box.replaceChildren();
  for (const account of state.accounts.filter(item => [item.name, item.platform, item.symbol].join(" ").toLowerCase().includes(query))) {
   const button = node("button", "");
   button.className = "connection-item" + (account.id === state.editing ? " selected" : "");
   button.append(node("strong", account.name), node("small", account.platform + " · " + account.symbol + " / " + account.quoteAsset), node("small", account.simulationEnabled && account.tradeMode === "simulation" ? "Paper · 模拟账户" : "Live · 保留原权限"));
   button.onclick = () => selectEditor(account.id);
   box.append(button);
  }
 }
 async function load(preferredId) {
  const data = await request("/api/v4/connections");
  state.accounts = data.accounts;
  state.current = data.currentAccountId;
  state.loaded = true;
  const select = $("connectionSwitcher");
  select.replaceChildren();
  for (const account of state.accounts) {
   const option = node("option", account.name + " · " + account.platform);
   option.value = account.id;
   select.append(option);
  }
  const currentView=desk?(preferredId||new URLSearchParams(location.search).get("account")||state.current):state.current;
  select.value = state.accounts.some(a=>a.id===currentView)?currentView:state.current;
  renderList();
  if (!state.dirty && (state.editing || !$("page-accounts")?.open)) selectEditor(state.editing || currentView || state.accounts[0]?.id || "", true);
  message("已加载 " + state.accounts.length + " 个账户。密钥仅显示配置状态，留空保存会保留原值。");
 }
 async function chooseCurrent(id) {
  if (state.busy) return;
  const guard = new CustomEvent("just-account-selecting", {detail: id, cancelable: true});
  if (!document.dispatchEvent(guard)) {$("connectionSwitcher").value = state.current;document.dispatchEvent(new CustomEvent("just-account-switch-finished", {detail: {success: false, cancelled: true}}));return;}
  state.busy = true;
  let success = false;
  try {
   await request("/api/account/select", {id});
   state.current = id;
   success = true;
   $("connectionSwitcher").value = id;
   state.dirty = false;
   selectEditor(id, true);
   document.dispatchEvent(new CustomEvent("just-account-selected", {detail: id}));
   message("当前账户已切换。可直接在工作台查看该账户的参数和持仓。");
  } catch (error) {
   $("connectionSwitcher").value = state.current;
   message(error.message);
  } finally {state.busy = false;$("checkConnection").disabled = !state.editing;$("selectConnection").disabled = !state.editing;if ($("connectionToSettings")) $("connectionToSettings").disabled = !state.editing;document.dispatchEvent(new CustomEvent("just-account-switch-finished", {detail: {success}}));}
  return success;
 }
 if ($("connectionSearch")) $("connectionSearch").oninput = renderList;
 $("newConnection").onclick = () => selectEditor("");
 $("connectionSwitcher").onchange = event => chooseCurrent(event.target.value);
 $("selectConnection").onclick = () => chooseCurrent(state.editing);
 if ($("connectionToSettings")) $("connectionToSettings").onclick = async () => {
  if (!state.editing || state.busy) return;
  if (await chooseCurrent(state.editing)) document.dispatchEvent(new CustomEvent("just-go-page", {detail: "parameters"}));
 };
 field("platform").onchange = changePlatform;
 form.oninput = () => {state.dirty = true;};
 form.onsubmit = async event => {
  event.preventDefault();
  if (state.busy || !form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  const creating=!state.editing;
  let createdId;
  state.busy = true;button.disabled = true;
  try {
   const input = {name: field("name").value.trim()};
   for (const key of keys) if (field(key).value.trim()) input[key] = field(key).value.trim();
   if (state.editing) input.id = state.editing;
   else Object.assign(input, {platform: field("platform").value, symbol: field("symbol").value, initialEquity: Number(field("initialEquity").value)});
   const data = await request("/api/v4/connections/" + (state.editing ? "update" : "create"), input);
   state.editing = data.account.id;
   if(creating)createdId=data.account.id;
   state.dirty = false;
   for (const key of keys.filter(key => key !== "address")) field(key).value = "";
   await load();
   message(data.message);
  } catch (error) {message(error.message);}
  finally {state.busy = false;button.disabled = false;$("checkConnection").disabled = !state.editing;$("selectConnection").disabled = !state.editing;if ($("connectionToSettings")) $("connectionToSettings").disabled = !state.editing;}
  if(desk&&createdId&&await chooseCurrent(createdId))document.dispatchEvent(new CustomEvent("just-go-page",{detail:"parameters"}));
 };
 $("checkConnection").onclick = async () => {
  if (!state.editing || state.busy) return;
  state.busy = true;$("checkConnection").disabled = true;
  message("正在通过原生只读接口核验已保存的连接…");
  try {
   const data = await request("/api/v4/connections/check", {id: state.editing});
   message(data.message + " · " + new Date(data.checkedAt).toLocaleString("zh-CN"));
  } catch (error) {message(error.message);}
  finally {state.busy = false;$("checkConnection").disabled = false;}
 };
 document.addEventListener("workspacepage", event => {
  if(event.detail!=="connections")return;
  if(!state.loaded)load().catch(error=>message(error.message));
  else if(desk&&!state.dirty)selectEditor($("connectionSwitcher").value||state.current,true);
 });
 document.addEventListener("just-reload-accounts",event=>load(event.detail).catch(error=>message(error.message)));
 document.addEventListener("just-account-selecting", event => {
  if (state.busy || state.dirty && !confirm("有未保存的账户配置，确认放弃修改并切换账户？")) event.preventDefault();
 });
 document.addEventListener("just-workspace-leaving", event => {
  if (event.detail.from !== "accounts") return;
  if (state.busy || state.dirty && !confirm("有未保存的账户配置，确认放弃本次修改并离开？")) return event.preventDefault();
  if (state.dirty) {state.dirty = false;selectEditor(state.editing, true);}
 });
 window.addEventListener("beforeunload", event => {if (state.dirty) {event.preventDefault();event.returnValue = "";}});
 load().catch(error => message(error.message));
})();
