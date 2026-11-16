(function () {
 "use strict";
 const $ = id => document.getElementById(id);
 const form = $("connectionForm");
 const desk=!!$("deskStarter");
 const keys = ["address", "privateKey", "apiKey", "apiSecret", "starkPrivateKey", "publicKey", "vault"];
 const state = {accounts: [], current: "", editing: "", busy: false, loaded: false, dirty: false};
 const field = name => form.elements.namedItem(name);
 function node(tag, text) {const item = document.createElement(tag);item.textContent = text;return item;}
 function message(text) {$("connectionStatus").textContent = text;if($("connectionInlineStatus"))$("connectionInlineStatus").textContent=text;}
 function buttons(){
  const a=state.accounts.find(a=>a.id===state.editing),inactive=!a||!!a.archivedAt;
  $("checkConnection").disabled=state.busy||inactive;$("selectConnection").disabled=state.busy||inactive;
  if($("deleteConnection"))$("deleteConnection").disabled=state.busy||!a;
  if($("connectionToSettings"))$("connectionToSettings").disabled=state.busy||inactive||a?.tradeMode==="live";
  if($("connectionToSettings"))$("connectionToSettings").textContent=a?.tradeMode==="live"?"当前研究策略未开放实盘执行":"配置该账户策略 →";
  $("checkConnection").textContent=a?.tradeMode==="live"?"读取真实账户与持仓":"测试已保存连接";
  form.querySelector('[type="submit"]').disabled=state.busy||!!a?.archivedAt;
 }
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
  const mode=field("accountMode")?.value||"paper",existing=state.accounts.find(a=>a.id===state.editing);
  const hotcoin=field("platform").querySelector('option[value="hotcoin"]');
  if(hotcoin){
   hotcoin.disabled=mode!=="live";
   if(hotcoin.disabled&&field("platform").value==="hotcoin")field("platform").value="hyperliquid";
  }
  for (const label of form.querySelectorAll("[data-exchanges]")) {
   label.hidden = !label.dataset.exchanges.split(" ").includes(field("platform").value);
   for(const input of label.querySelectorAll("input"))input.disabled=label.hidden;
  }
  const credentials=form.querySelector(".connection-credentials");
  if(!existing){
   $("connectionMode").textContent=mode==="live"?"真实账户连接 · 停止状态 · 未启用策略":"模拟账户 · 停止状态";
   form.querySelector('[type="submit"]').textContent=mode==="live"?"创建真实账户连接":"创建并配置经典模拟";
   if(credentials)credentials.open=mode==="live";
  }
  const summary=credentials?.querySelector("summary");
  if(summary)summary.textContent=mode==="live"?"交易所 API 配置":"交易所连接（选填）";
  $("connectionEquityLabel").hidden=!!existing||mode==="live";
  field("initialEquity").disabled=!!existing||mode==="live";
  if($("connectionModeHelp"))$("connectionModeHelp").textContent=field("platform").value==="hotcoin"?"使用具有合约读取权限的 API Key 和 Secret。可查看权益、持仓和所选合约委托。":mode==="live"?"保存真实交易所连接，不会自动启用实盘策略；账户资金从交易所读取。":"模拟账本与真实账户资金分开，策略启动前仍需保存参数。";
 }
 function selectEditor(id, internal = false) {
  if (state.busy && !internal) return false;
  state.editing = id;
  state.dirty = false;
  const account = state.accounts.find(item => item.id === id);
  form.reset();
  for(const control of form.querySelectorAll("input,select,button"))control.disabled=false;
  for (const key of keys) field(key).value = "";
  field("platform").disabled = !!account;
  field("symbol").disabled = !!account;
  if(field("accountMode")){field("accountMode").disabled=!!account;field("accountMode").value=account&&!(account.simulationEnabled&&account.tradeMode==="simulation")?"live":"paper";}
  $("connectionEquityLabel").hidden = !!account;
  $("checkConnection").disabled = !account || state.busy;
  $("selectConnection").disabled = !account || state.busy;
  if ($("connectionToSettings")) $("connectionToSettings").disabled = !account || state.busy;
  $("connectionFormTitle").textContent = account ? account.name + " · 连接配置" : "新增交易所账户";
  if($("deleteConnection")){$("deleteConnection").disabled=!account||state.busy;$("deleteConnection").textContent=account?.archivedAt?"恢复账户":"删除账户";}
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
  if(account?.archivedAt){
   for(const input of form.querySelectorAll("input,select,button"))input.disabled=true;
   $("deleteConnection").disabled=state.busy;
   $("connectionMode").textContent="已移出日常列表，历史和账本保留；恢复后不会自动启动。";
  }
  renderList();
  buttons();
  if (!internal && typeof matchMedia === "function" && matchMedia("(max-width:760px)").matches) form.parentElement.scrollIntoView({block: "start"});
  return true;
 }
 async function editAccount(id,{live=false}={}) {
  if(state.busy||state.dirty&&!await JustDialogs.discard("账户配置尚未保存。"))return false;
  if(!id&&$("connectionSearch"))$("connectionSearch").value="";
  if(!selectEditor(id))return false;
  if(live){field("accountMode").value="live";changePlatform();}
  return true;
 }
 function renderList() {
  const box = $("connectionList");
  const query = $("connectionSearch")?.value.toLowerCase()||"";
  const matching=state.accounts.filter(item=>[item.name,item.platform,item.symbol,item.archivedAt?"已删除":"",item.tradeMode==="live"?"真实":"模拟"].join(" ").toLowerCase().includes(query));
  if(desk){const select=$("connectionSwitcher"),value=state.editing||select.value;
   select.replaceChildren(...matching.map(a=>{const o=node("option",a.name+" · "+a.platform+" · "+(a.archivedAt?"已删除":a.tradeMode==="live"?"真实":"模拟"));o.value=a.id;return o;}));
   if(matching.some(a=>a.id===value))select.value=value;
  }
  if (!box) return;
  box.replaceChildren();
  for (const account of matching) {
   const button = node("button", "");
   button.className = "connection-item" + (account.id === state.editing ? " selected" : "");
   button.append(node("strong", account.name), node("small", account.platform + " · " + account.symbol + " / " + account.quoteAsset), node("small", account.simulationEnabled && account.tradeMode === "simulation" ? "Paper · 模拟账户" : "Live · 保留原权限"));
   button.onclick = () => editAccount(account.id);
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
  if (!await JustDialogs.guard("just-account-selecting",id)) {$("connectionSwitcher").value = state.editing||state.current;return;}
  state.busy = true;
  let success = false;
  try {
   await request("/api/account/select", {id});
   state.current = id;
   success = true;
   $("connectionSwitcher").value = id;
   state.dirty = false;
   selectEditor(id, true);
   const selectedEvent=new CustomEvent("just-account-selected",{detail:id});
   selectedEvent.account=state.accounts.find(a=>a.id===id);
   document.dispatchEvent(selectedEvent);
   message("当前账户已切换。可直接在工作台查看该账户的参数和持仓。");
  } catch (error) {
   $("connectionSwitcher").value = state.current;
   message(error.message);
  } finally {state.busy = false;buttons();document.dispatchEvent(new CustomEvent("just-account-switch-finished", {detail: {success}}));}
  return success;
 }
 if ($("connectionSearch")) $("connectionSearch").oninput = renderList;
 $("newConnection").onclick = () => editAccount("");
 if($("newLiveConnection"))$("newLiveConnection").onclick=()=>editAccount("",{live:true});
 $("connectionSwitcher").onchange = async event => {
  const a=state.accounts.find(account=>account.id===event.target.value);
  if(a?.archivedAt){
   if(!await editAccount(a.id))event.target.value=state.editing||state.current;
  }else if(a)await chooseCurrent(a.id);
 };
 $("selectConnection").onclick = () => chooseCurrent(state.editing);
 if ($("connectionToSettings")) $("connectionToSettings").onclick = async () => {
  if (!state.editing || state.busy) return;
  if (await chooseCurrent(state.editing)) document.dispatchEvent(new CustomEvent("just-go-page", {detail: "parameters"}));
 };
 field("platform").onchange = changePlatform;
 if(field("accountMode"))field("accountMode").onchange=changePlatform;
 form.oninput = () => {state.dirty = true;};
 form.onsubmit = async event => {
  event.preventDefault();
  if (state.busy || !form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  const creating=!state.editing;
  const live=creating&&field("accountMode")?.value==="live";
  if(live&&!await JustDialogs.show({title:"创建真实账户连接？",message:"保存后可读取交易所账户。策略保持停止。",action:"创建连接"}))return;
  let createdId;
  state.busy = true;button.disabled = true;
  try {
   const input = {name: field("name").value.trim()};
   for (const key of keys) if (!field(key).disabled&&field(key).value.trim()) input[key] = field(key).value.trim();
   if (state.editing) input.id = state.editing;
   else Object.assign(input, {platform: field("platform").value, symbol: field("symbol").value,accountMode:live?"live":"paper",
    ...(live?{confirmLive:true}:{initialEquity:Number(field("initialEquity").value)})});
   const data = await request("/api/v4/connections/" + (state.editing ? "update" : "create"), input);
   state.editing = data.account.id;
   if(creating)createdId=data.account.id;
   state.dirty = false;
   if($("connectionSearch"))$("connectionSearch").value="";
   for (const key of keys.filter(key => key !== "address")) field(key).value = "";
   await load();
   message(data.message);
  } catch (error) {message(error.message);}
  finally {state.busy = false;buttons();}
  if(desk&&createdId&&await chooseCurrent(createdId)&&!live)document.dispatchEvent(new CustomEvent("just-go-page",{detail:"parameters"}));
 };
 $("checkConnection").onclick = async () => {
  if (!state.editing || state.busy) return;
  state.busy = true;$("checkConnection").disabled = true;
  message("正在通过原生只读接口核验已保存的连接…");
  try {
   const data = await request("/api/v4/connections/check", {id: state.editing});
   message(data.message + " · " + new Date(data.checkedAt).toLocaleString("zh-CN"));
   const box=node("div","");
   box.id="connectionNativeSummary";
   box.className="batch-results";
   const summary=data.summary;
   const amount=value=>value==null?"未返回":Number(value).toLocaleString("zh-CN",{maximumFractionDigits:8});
   box.append(node("p",(summary.valuationBasis==="native_equity"?"交易所权益 ":"交易所余额 ")+amount(summary.balance)+" · 可用 "+amount(summary.available)+" · 持仓 "+(summary.positionCount??"未知")+" 笔"));
   if(summary.ordersMarket)box.append(node("p",summary.ordersMarket+" 普通未完成委托 "+(summary.openOrderCount??"未能核验")));
   for(const p of summary.positions||[])box.append(node("p",(p.market||p.symbol)+" "+(p.side==="long"?"多":"空")+" · 均价 "+amount(p.entry)+" · 杠杆 "+(p.leverage>0?p.leverage+"×":"未返回")+" · 数量 "+amount(p.qty)+" "+(p.qtyUnit||p.symbol)));
   document.dispatchEvent(new CustomEvent("just-connection-checked",{detail:{id:state.editing,summary:data.summary}}));
   await JustDialogs.show({title:"交易所连接核验通过",content:box,info:true});
  } catch (error) {message(error.message);await JustDialogs.show({title:"交易所连接核验失败",message:error.message,info:true});}
  finally {state.busy = false;buttons();}
 };
 if($("deleteConnection"))$("deleteConnection").onclick=async()=>{
  if(state.busy||!state.editing)return;
  const a=state.accounts.find(a=>a.id===state.editing);if(!a)return;
  if(state.dirty)return JustDialogs.show({title:"账户配置尚未保存",message:"请先保存修改，再处理删除或恢复。",info:true});
  state.busy=true;$("deleteConnection").disabled=true;
  try{
   let version=a.lifecycleVersion;
   if(!a.archivedAt){
    message("正在核对运行状态、持仓和订单；真实账户会读取交易所…");
    const {review}=await request("/api/v4/connections/archive-preview",{id:a.id});
    if(!review.allowed){
     const reason=review.blockers.map(b=>"• "+b.message).join("\n");
     message("暂不能删除：\n"+reason);
     await JustDialogs.show({title:"此账户暂不能删除",message:reason,info:true});
     return;
    }
    version=review.version;
   }
   if(!await JustDialogs.show({
    title:(a.archivedAt?"恢复":"删除")+"「"+a.name+"」？",
    message:a.archivedAt?"账户将重新显示，保持原运行状态。":"账户将移出日常列表，历史、密钥和账本保留。可在「已删除」恢复。",
    action:a.archivedAt?"恢复账户":"删除账户",danger:!a.archivedAt
   }))return;
   const result=await request("/api/v4/connections/"+(a.archivedAt?"restore":"archive"),{id:a.id,confirm:true,expectedVersion:version});
   state.dirty=false;await load(a.id);message(result.message);
   document.dispatchEvent(new CustomEvent("just-accounts-updated"));
  }catch(e){message(e.message);await JustDialogs.show({title:"账户操作失败",message:e.message,info:true});}
  finally{state.busy=false;buttons();}
 };
 document.addEventListener("workspacepage", event => {
  if(event.detail!=="connections")return;
  if(!state.loaded)load().catch(error=>message(error.message));
  else if(desk&&!state.dirty)selectEditor($("connectionSwitcher").value||state.current,true);
 });
 document.addEventListener("just-reload-accounts",event=>load(event.detail).catch(error=>message(error.message)));
 document.addEventListener("just-account-selecting", event => {
  if (state.busy) return event.preventDefault();
  if(state.dirty)event.check(()=>JustDialogs.discard("切换后，本次账户配置修改将丢失。"));
 });
 document.addEventListener("just-workspace-leaving", event => {
  if (event.detail.from !== "accounts") return;
  if (state.busy) return event.preventDefault();
  if (state.dirty) {
   event.check(()=>JustDialogs.discard("关闭后，本次账户配置修改将丢失。"));
   event.onAllowed(()=>selectEditor(state.editing,true));
  }
 });
 window.JustAccountBatch?.mount({request,canOpen:async()=>{
  if(state.busy||state.dirty&&!await JustDialogs.discard("打开批量管理前，需放弃未保存的账户配置。"))return false;
  if(state.dirty)selectEditor(state.editing,true);
  return true;
 },onChanged:async()=>{
  document.dispatchEvent(new CustomEvent("just-accounts-updated"));
  await load();
 }});
 window.addEventListener("beforeunload", event => {if (state.dirty) {event.preventDefault();event.returnValue = "";}});
 load().catch(error => message(error.message));
})();
