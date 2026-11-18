(function () {
 "use strict";
 const $ = id => document.getElementById(id);
 const trade = window.JustTradeLabels;
 const query = new URLSearchParams(location.search);
 const strategies = {classic:"经典补仓",turtle:"海龟趋势 4H",reversal:"找底摸顶 4H",carry:"资金费率对冲",pullback:"短线顺势回踩",swing:"图示波段 1H",history:"真实与历史账户"};
 const paperStrategies = {turtle:"turtle_4h_v1",reversal:"reversal_4h_v1",carry:"funding_carry_v1",pullback:"pullback_15m_v1",swing:"chart_swing_1h_v1"};
 const isPaperMode = mode => Object.hasOwn(paperStrategies,mode);
 const fromAccount = account => Object.keys(paperStrategies).find(mode=>paperStrategies[mode]===account.strategyType) || (account.eligible?"classic":"history");
 const state = {data:null,id:query.get("account")||"",mode:Object.hasOwn(strategies,query.get("strategy"))?query.get("strategy"):"",empty:false,lastAccounts:{},busy:false,offline:true,dirty:false,request:0,offset:0,trades:[],filter:"all",switching:false,drawer:"",queuedDrawer:"",turtle:null};
 let liveChoice="",liveChoiceAccount="",liveFieldsVersion="";
 const profileForMode={classic:"classic",turtle:"turtle_4h_v1",reversal:"reversal_4h_v1",
  pullback:"pullback_15m_v1",swing:"chart_swing_1h_v1",carry:"funding_carry_v1"};
 const labels = {hyperliquid: "Hyperliquid", binance: "Binance", extended: "Extended", hotcoin: "Hotcoin"};
 const keys = ["side", "leverage", "baseAmount", "addAmount", "maxAdds", "addTrigger", "takeProfit"];
 const format = (value, digits = 2) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("zh-CN", {maximumFractionDigits: digits});
 const time = value => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false}) : String(value);
 };
 const node = (tag, text, cls) => {const el = document.createElement(tag);el.textContent = text ?? "";if (cls) el.className = cls;return el;};
 function message(value,tone="error") {
  $("deskMessage").hidden=!value;
  $("deskMessage").textContent=value;
  $("deskMessage").dataset.tone=tone;
  $("deskConfigError").hidden=!value||tone!=="error";
  $("deskConfigError").textContent=value;
 }
 function closeRail() {document.body.classList.remove("rail-open");$("railBackdrop").hidden = true;$("toggleAccounts").setAttribute("aria-expanded", String(!matchMedia("(max-width:760px)").matches && !document.body.classList.contains("rail-collapsed")));}
 async function closeDrawer() {
  if (!state.drawer || state.busy || state.switching) return !state.drawer;
  if (!await JustDialogs.guard("just-workspace-leaving",{from:state.drawer,to:"trading"})) return false;
  $("page-"+state.drawer).close();
  state.drawer="";
  return true;
 }
 async function openDrawer(page, {newAccount=false}={}) {
  if (!["parameters","accounts","history"].includes(page)) return;
  if(state.busy||state.switching||state.turtle?.busy)return;
  if(state.drawer===page)return;
  if(!await closeDrawer()||state.drawer)return;
  if(page==="parameters"&&isPaperMode(state.mode)){
   if(state.turtle?.snapshot)turtleDesk.edit();
   else if(!state.empty)state.queuedDrawer="parameters";
   return;
  }
  if(page==="parameters"&&(state.mode!=="classic"||state.empty||!state.data?.selected.eligible))return;
  if(page==="history"&&!state.id)return;
  state.drawer=page;
  message("");
  closeRail();
  $("page-"+page).showModal();
  if(page==="accounts")document.dispatchEvent(new CustomEvent("workspacepage",{detail:"connections"}));
  if(page==="parameters")loadLeverage();
  if(page==="history"){state.offset=0;loadTrades();}
  if(newAccount)$("newConnection").click();
 }
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
  $("deskPriceLabel").textContent = state.offline || !(snapshot.mark > 0) && price > 0 ? "上次价格" : "最新价格";
  $("deskPriceUnit").textContent = account.quoteAsset;
  $("deskOpenPrice").textContent = format(plan?.first.price ?? plan?.first.reference, 6);
  $("deskOpenStatus").textContent = plan ? p && plan.first.price != null ? "实际首仓成交价" : account.paper && plan.first.reference ? "当前报价估算，启动后市价模拟成交" : plan.first.status : "保存参数后生成开仓计划";
  $("deskOpenAmount").textContent = amount(plan?.first.amount);
  $("deskAverage").textContent = format(p?.entry, 6);
  $("holdingEntry").textContent=p?format(p.entry,6):"当前空仓";
  $("holdingEntryHint").textContent=p?account.quoteAsset+" · 成交后的加权持仓均价":"开仓成交后显示，不使用计划价替代";
  $("holdingLeverage").textContent=p?.leverage>0?format(p.leverage,2)+"×":p?"待核验":"无持仓";
  $("holdingLeverageHint").textContent=p?.leverage>0?(account.paper?"本轮锁定配置":"交易所原生读取"):"下一轮设置不代表当前持仓杠杆";
  $("holdingSize").textContent=p?format(p.qty,8)+" "+(p.qtyUnit||account.symbol):snapshot.native?"—":"0 "+account.symbol;
  $("holdingNotional").textContent=p?.notional>0?"当前名义金额 "+amount(p.notional):p?.qtyUnit?"交易所合约张数":p&&price>0?"当前名义金额 "+amount(p.qty*price):"持仓金额随行情更新";
  if(snapshot.native&&(snapshot.positions?.length>1||!p&&snapshot.positions?.length)){
   $("holdingEntryHint").textContent="共有 "+snapshot.positions.length+" 笔原生持仓，逐笔明细见下方";
   if(!p){
    $("holdingEntry").textContent="查看逐笔持仓";
    $("holdingLeverage").textContent="逐笔查看";
    $("holdingLeverageHint").textContent="按交易所各笔持仓分别展示";
    $("holdingSize").textContent=snapshot.positions.length+" 笔持仓";
    $("holdingNotional").textContent="数量见下方明细";
   }
  }
  if(snapshot.native&&!snapshot.updatedAt){
   $("holdingEntry").textContent="待同步";$("holdingEntryHint").textContent="原生账户数据尚未通过读取";
   $("holdingLeverage").textContent="待核验";$("holdingSize").textContent="待同步";
  }
  $("deskAddPrice").textContent = format(plan?.add.price, 6);
  $("deskAddPrice").dataset.tone = !state.offline && plan?.add.price > 0 ? "warning" : "";
  $("deskAddStatus").textContent = plan?.add.status || "等待经典参数";
  $("deskAddAmount").textContent = amount(plan?.add.amount);
  $("deskAddQty").textContent = plan?.add.contracts != null ? format(plan.add.contracts)+" 张（估算）" : plan?.add.quantity == null || !account.paper ? "—" : format(plan.add.quantity, 8) + " " + account.symbol + "（估算）";
  $("deskTargetPrice").textContent = format(plan?.exit.price, 6);
  $("deskTargetPrice").dataset.tone = !state.offline && plan?.exit.price > 0 ? "target" : "";
  $("deskExitStatus").textContent = plan?.exit.status || "暂无计划";
  const exitMove = !state.offline && snapshot.mark > 0 && plan?.exit.price > 0 ? (plan.exit.price / snapshot.mark - 1) * 100 : null;
  $("deskTargetDistance").textContent = exitMove === null || !["long","short"].includes(p?.side) ? "—"
    : (p.side === "long" ? exitMove <= 0 : exitMove >= 0) ? "报价已达目标"
    : "还需" + (p.side === "long" ? "上涨 " : "下跌 ") + format(Math.abs(exitMove), 3) + "%";
  $("deskTargetReturn").textContent = c ? format(c.takeProfit * 100) + "% 保证金" : "—";
  const strip = $("deskPosition");
  strip.replaceChildren();
  for (const [label, value] of Object.entries({
   "方向": p ? trade.side(p.side).action : c?.side === "long" ? "计划做多" : c?.side === "short" ? "计划做空" : "—",
   "持仓数量": p ? format(p.qty, 8) + " " + account.symbol : "0",
   "补仓次数": plan ? plan.add.done + " / " + plan.add.limit : "—",
   "本轮最近成交": format(plan?.add.lastPrice ?? plan?.first.price, 6)
  })) {const item = node("span", label);item.append(node("b", value));strip.append(item);}
  if(snapshot.native){
   strip.replaceChildren(...(snapshot.positions||[]).map(p=>{
    const item=node("div","","native-position-row"), direction=node("small");
    const label=trade.side(p.side);
    trade.badge(direction,label.text,label.tone);
    item.append(node("span",p.market||p.symbol),direction);
    item.append(node("b","均价 "+format(p.entry,6)+" · "+(p.leverage>0?format(p.leverage)+"×":"杠杆待核验")+" · 数量 "+format(p.qty,8)+" "+(p.qtyUnit||p.symbol)));
    return item;
   }));
  }
  const box = $("deskFills");
  box.replaceChildren();
  for (const fill of plan?.fills || []) {
   const row = node("tr");
   row.append(node("td", time(fill.at)), node("td", fill.kind === "open" ? "首仓" : "补仓"), node("td", format(fill.price, 6)),
    node("td", format(fill.qty, 8)), node("td", format(fill.notional)));
   [...row.children].forEach((cell, i) => cell.dataset.label = ["时间", "动作", "成交价", "数量", "金额"][i]);
   box.append(row);
  }
  if (!plan?.fills?.length) {
   const row = node("tr"), cell = node("td", p ? "旧仓位未采集逐笔明细，均价保留在上方" : "暂无本轮成交", "empty-cell");
   cell.colSpan = 5;row.append(cell);box.append(row);
  }
 }
 function renderList() {
  const box = $("deskAccounts");
  const scroll=box.scrollTop;
  const focused=box.contains(document.activeElement)?document.activeElement.dataset.accountId:null;
  box.replaceChildren();
  const query = $("deskSearch").value.trim().toLowerCase();
  const all = accountsFor(state.mode);
  const matches = all.filter(a => [a.name, a.platform, a.symbol, a.strategy].join(" ").toLowerCase().includes(query) &&
   (state.filter === "all" || state.filter === "running" && a.running || state.filter === "position" && a.hasPosition));
  $("deskCount").textContent = all.length + " 个账户 · " + all.filter(a => a.running).length + " 个监控中";
  for (const account of matches) {
   const button = node("button", "", "account-select"), head = node("span", "", "rail-name");
   button.setAttribute("aria-pressed", String(account.id === state.id));
   button.disabled = state.busy || state.switching || !!state.turtle?.busy;
   button.dataset.accountId=account.id;
   const turtle=isPaperMode(fromAccount(account));
   head.append(node("strong", account.name), node("small", turtle?account.running?"运行中":"已暂停":account.error ? "异常" : !account.eligible ? "只读" : account.running ? "运行" : account.ready ? "暂停" : "可配置"));
   const net = account.floating == null ? null : Number(account.floating) + Number(account.realized || 0);
   const foot = node("span","","rail-pnl account-position");
   const snapshot=(turtle?state.turtle?.snapshot:state.data?.snapshot);
   const selectedSnapshot=turtle ? snapshot?.id===account.id : state.data?.selected.id===account.id;
   const uncertain=!account.paper&&!selectedSnapshot;
   const position=selectedSnapshot&&snapshot&&fromAccount(account)!=="carry"?trade.position(snapshot,turtle?state.turtle.online:!state.offline)
     : account.hasPosition?{text:"有持仓",tone:"ok"}:uncertain?{text:"持仓待同步",tone:"warning"}:{text:"当前空仓",tone:"flat"};
   const marker=node("small");
   trade.badge(marker,position.text,position.tone);
   const balance=net==null?account.paper?"模拟":"实盘只读":(net>0?"+":"")+format(net)+" "+account.quoteAsset;
   foot.append(marker,node("small",balance,net>0?"positive":net<0?"negative":""));
   button.append(head, node("span", (labels[account.platform] || account.platform) + " · " + account.symbol + " / " + account.quoteAsset, "rail-pair"), foot);
   button.title = account.name;
   button.onclick = () => {
    if (state.busy || state.switching || state.turtle?.busy) return;
    selectAccount(account.id);
   };
   box.append(button);
  }
  if (!matches.length) {
   box.append(node("p", "此策略下没有匹配的账户", "muted"));
  }
  box.scrollTop=scroll;
  [...box.children].find(button=>button.dataset.accountId===focused)?.focus({preventScroll:true});
 }
 const form = $("deskSettings");
 const field = name => form.elements.namedItem(name);
 let leverageLookup;
 async function loadLeverage(){
  const lookup={id:state.id,pending:true,spec:null};
  leverageLookup=lookup;
  updateBudget();
  try {lookup.spec=(await api("/api/v4/desk/leverage?id="+encodeURIComponent(lookup.id))).spec;}
  catch {lookup.spec=null;}
  finally {
   lookup.pending=false;
   if(leverageLookup===lookup&&lookup.id===state.id)updateBudget();
  }
 }
 function renderLeverage(c){
  const lookup=leverageLookup?.id===state.id?leverageLookup:null;
  const notional=c.baseAmount+c.addAmount*c.maxAdds;
  const tier=lookup?.spec?.tiers.find(t=>notional>=t.floor&&(t.cap===null||notional<t.cap||lookup.spec.capInclusive&&notional===t.cap));
  const input=field("leverage");
  input.removeAttribute("max");
  input.step=lookup?.spec?.step??(state.data?.selected.platform==="extended"?.1:1);
  if(tier){
   input.max=tier.maxLeverage;
   $("deskLeverageHint").textContent=lookup.spec.market+" 当前计划仓位最高 "+tier.maxLeverage+" 倍";
  }else $("deskLeverageHint").textContent=lookup?.pending?"正在读取交易所杠杆档位…":lookup?.spec?
   "计划名义仓位超出交易所分档范围":"交易所档位暂未取得，保存时会重新校验。";
 }
 let turtleDesk, turtleTarget=null, turtleRequest=0;
 function accountsFor(mode,accounts=state.data?.accounts||[]){
  const list=accounts.filter(account=>!account.archivedAt&&fromAccount(account)===mode);
  if(!isPaperMode(mode)||!state.turtle)return list;
  const running=new Map(state.turtle.accounts.map(account=>[account.id,account.running]));
  const snapshot=state.turtle.snapshot;
  return list.map(account=>({...account,running:snapshot?.id===account.id?snapshot.running:running.get(account.id)??account.running,
   hasPosition:snapshot?.id===account.id?!!snapshot.position:account.hasPosition}));
 }
 function preferred(mode,accounts=state.data?.accounts||[]){
  const list=accountsFor(mode,accounts);
  return list.find(a=>a.id===state.lastAccounts[mode])
   ||list.find(a=>a.running)
   ||list.find(a=>a.ready&&!a.error)
   ||list[0];
 }
 async function selectAccount(id){
  const account=state.data?.accounts.find(a=>a.id===id);
  if(!account||state.id===id)return;
  if(!await JustDialogs.guard("just-account-selecting",id)){render();return;}
  state.mode=fromAccount(account);
  resetSelection(id);
 }
 async function selectStrategy(mode){
  if(state.data?.selected.liveStrategy&&mode!=="history"){
   const target=profileForMode[mode],catalog=state.data.snapshot.strategies||[];
   if(!catalog.some(p=>p.id===target)){message("该交易所账户当前缺少此策略所需的实盘执行通道。");return;}
   if(state.busy||state.switching)return;
   if(state.dirty&&!await JustDialogs.discard("切换策略会重置当前未保存参数。"))return;
   liveChoice=target;liveFieldsVersion="";state.dirty=target!==state.data.snapshot.strategy;
   render();await openDrawer("parameters");return;
  }
  if(!state.data||mode===state.mode||!Object.hasOwn(strategies,mode))return;
  const id=preferred(mode)?.id||"";
  if(!await JustDialogs.guard("just-account-selecting",id))return;
  state.mode=mode;
  state.filter="all";
  $("deskSearch").value="";
  for(const element of document.querySelectorAll("[data-filter]"))element.setAttribute("aria-pressed",String(element.dataset.filter==="all"));
  resetSelection(id);
 }
 function rememberAccount(){
  const url=new URL(location.href);
  if(state.id)url.searchParams.set("account",state.id);
  else url.searchParams.delete("account");
  if(state.mode)url.searchParams.set("strategy",state.mode);
  history.replaceState(null,"",url);
 }
 function hideTurtle(){
  if(turtleTarget!==null){
   turtleRequest++;turtleDesk?.dispose();turtleDesk=null;turtleTarget=null;
   $("deskTurtlePane").shadowRoot?.replaceChildren();
  }
  state.turtle=null;
  $("deskTurtlePane").hidden=true;
  $("page-trading").hidden=false;
 }
 async function showTurtle(id){
  if(turtleTarget===id)return;
  turtleDesk?.dispose();
  turtleDesk=null;turtleTarget=id;state.turtle=null;
  const ticket=++turtleRequest;
  $("page-trading").hidden=true;$("deskTurtlePane").hidden=false;
  const pane=$("deskTurtlePane"),root=pane.shadowRoot||pane.attachShadow({mode:"open"});
  root.replaceChildren(node("p","正在读取"+strategies[state.mode]+"工作台…"));
  try{
   const response=await fetch(pane.dataset.template,{credentials:"same-origin"});
   if(!response.ok)throw Error("策略工作台加载失败");
   const source=new DOMParser().parseFromString(await response.text(),"text/html");
   if(ticket!==turtleRequest)return;
   const regions=["message","empty","desk","parameters","create","confirm"].map(id=>source.getElementById(id));
   if(regions.some(region=>!region)||!window.JustTurtleDesk)throw Error("策略工作台资源不完整");
   const styles=[...source.querySelectorAll('link[rel="stylesheet"][data-workbench-style]')].map(source=>document.importNode(source,true));
   const nodes=regions.map(region=>document.importNode(region,true));
   nodes[1].querySelector("a[href='/#accounts']")?.remove();
   nodes[2].querySelector(".history-panel")?.remove();
   const wrap=node("div","","embedded-workbench");
   wrap.append(...nodes);
   root.replaceChildren(...styles,wrap);
   turtleDesk=window.JustTurtleDesk.mount(root,{
    accountId:id,embedded:true,mode:state.mode,
    onState(value){
     if(ticket!==turtleRequest)return;
     state.turtle=value;
     if(state.data){
      renderStarter(state.data.selected,state.data.snapshot);
      renderList();
      if(state.drawer==="history")loadTrades();
     }
     if(value.snapshot&&state.queuedDrawer==="parameters"){
      state.queuedDrawer="";
      openDrawer("parameters");
     }
    },
    onCreated(newId){
     state.id=newId;
     state.empty=false;
     rememberAccount();
     document.dispatchEvent(new CustomEvent("just-reload-accounts",{detail:newId}));
     load();
    }
   });
  }catch(error){
   if(ticket!==turtleRequest)return;
   const retry=node("button","重新加载");
   retry.onclick=()=>{turtleTarget=null;showTurtle(id);};
   root.replaceChildren(node("p",error.message),retry);
  }
 }
 function renderStarter(account,snapshot){
  const turtle=isPaperMode(state.mode),historical=state.mode==="history",paper=state.turtle?.snapshot;
  const blocked=state.busy||state.switching||state.offline||!!state.turtle?.busy;
  const list=accountsFor(state.mode),picker=$("deskAccountPicker");
  const byName=JSON.stringify(list.map(a=>[a.id,a.name,a.symbol,a.quoteAsset]));
  if(picker.dataset.options!==byName){
   picker.dataset.options=byName;
   picker.replaceChildren(...list.map(a=>{const option=node("option",a.name+" · "+a.symbol+"/"+a.quoteAsset);option.value=a.id;return option;}));
   if(!list.length)picker.append(node("option","暂无"+(historical?"历史账户":"模拟账户")));
  }
  picker.value=state.id||picker.options[0]?.value||"";
  picker.disabled=blocked||!list.length;
  picker.labels[0].textContent=historical?"真实与历史账户":turtle?"模拟账户":"交易账户";
  for(const button of document.querySelectorAll("[data-strategy]")){
   button.disabled=blocked;
   button.setAttribute("aria-pressed",String(account.liveStrategy?
    profileForMode[button.dataset.strategy]===(liveChoice||snapshot.strategy||"classic"):button.dataset.strategy===state.mode));
   if(button.dataset.strategy==="history"){button.hidden=!accountsFor("history").length;button.textContent="真实与历史账户";}
  }
  const primary=$("deskPrimaryAction"),pause=$("deskPauseAction"),edit=$("deskEditShortcut"),create=$("deskNewAccount");
  primary.hidden=historical;
  pause.hidden=historical||state.empty;
  pause.disabled=true;
  $("deskHistoryShortcut").disabled=blocked||state.empty||turtle&&!paper;
  edit.hidden=historical||state.empty;
  create.hidden=historical||state.empty;
  edit.disabled=blocked||turtle&&!paper;
  create.disabled=blocked||turtle&&!state.turtle?.loaded;
  const openNew=()=>turtle?turtleDesk?.openCreate():openDrawer("accounts",{newAccount:true});
  create.onclick=openNew;
  let hint="";
  if(historical){
   hint=!account.paper?"真实账户连接：展示交易所原生持仓；当前研究策略未开放实盘执行。":list.length?"查看历史记录。选择上方策略即可回到模拟交易。":"暂无历史账户。";
  }else if(state.empty){
   primary.textContent="新建模拟账户";
   primary.onclick=openNew;
   primary.disabled=create.disabled;
   hint=turtle?"新建 Binance ETH 或 BTC 模拟账户后即可配置。":"新建模拟账户后即可配置经典补仓。";
  }else if(turtle){
   primary.textContent="启动模拟";
   primary.onclick=()=>turtleDesk.start();
   primary.disabled=blocked||!state.turtle?.online||!paper||paper.running||state.turtle.dirty||paper.riskLock||!!paper.pending;
   pause.disabled=blocked||!state.turtle?.online||!paper?.running;
   pause.onclick=()=>turtleDesk.pause();
   const watching={carry:"监控费率与双边盘口",pullback:"监控 1H 方向与 15m 回踩",swing:"监控 1H 波段幅度与收盘转向确认"}[state.mode]||"等待有效的 4H 信号";
   hint=!paper?"正在同步"+strategies[state.mode]+"…":paper.riskLock?"该模拟账户当前风控锁定。":paper.pending?"当前有待核对记录。":state.turtle.dirty?"请先保存参数。":paper.running?"运行中 · "+watching:"已暂停 · 点击「启动模拟」恢复监控";
  }else{
   const startControl=document.querySelector('[data-action="start"]'),pauseControl=document.querySelector('[data-action="pause"]');
   primary.textContent=account.ready?(account.liveStrategy?(account.running?"实盘运行中":"启动实盘"):"启动模拟"):account.liveStrategy?"配置实盘参数":"配置并启动";
   primary.onclick=()=>account.ready?startControl.click():openDrawer("parameters");
   primary.disabled=blocked||(account.ready?startControl.disabled:snapshot.blocked||state.data.ledgerBlocked);
   pause.disabled=blocked||pauseControl.disabled;
   pause.onclick=()=>pauseControl.click();
   hint=snapshot.pendingOrder?snapshot.notice:snapshot.blocked?"当前账户暂时锁定。":state.dirty?"请先保存参数。":account.running?"运行中 · "+account.strategy+"正在监控":account.ready?"已暂停 · 可从此处恢复监控":account.liveStrategy?"选择实盘策略并保存参数后，即可启动。":"填写经典参数后即可启动。";
  }
  $("deskStarterHint").textContent=state.offline?"工作台尚未同步。":hint;
  $("deskStarterHint").hidden=!$("deskStarterHint").textContent;
  document.querySelector(".price-cards").hidden=!account.eligible;
  document.querySelector(".price-panel [data-go=parameters]").hidden=!account.eligible;
 }
 for(const button of document.querySelectorAll("[data-strategy]"))button.onclick=()=>selectStrategy(button.dataset.strategy);
 $("deskAccountPicker").onchange=event=>selectAccount(event.target.value);
 function settingsValues() {
  if(state.data?.selected.liveStrategy&&liveChoice!=="classic"){
   const p=state.data.snapshot.strategies.find(p=>p.id===liveChoice);
   return Object.fromEntries(p.fields.map(f=>{
    const el=$("liveParameterFields").querySelector('[name="live_'+f.key+'"]');
    return [f.key,f.options?el.value:Number(el.value)/(f.percent?100:1)];
   }));
  }
  return Object.fromEntries(keys.map(name => [name, name === "side" ? field(name).value : field(name).value.trim() === "" ? NaN : Number(field(name).value) / (["addTrigger", "takeProfit"].includes(name) ? 100 : 1)]));
 }
 function updateBudget() {
  if(state.data?.selected.liveStrategy&&liveChoice!=="classic"){
   $("parameterDirty").hidden=!state.dirty;
   $("deskSaveState").textContent=state.busy?"正在保存或同步…":state.dirty?"有未保存的参数":"当前已保存参数";
   $("deskResetDraft").disabled=!state.dirty||state.busy||state.switching;
   return;
  }
  const c = settingsValues(), unit = state.data?.selected.quoteAsset || "U";
  renderLeverage(c);
  const preview = window.JustSettingsPreview?.build(c, state.offline ? null : state.data?.snapshot.mark) || {valid: false, rows: []};
  $("parameterDirty").hidden = !state.dirty;
  $("deskSaveState").textContent = state.busy ? "正在保存或同步…" : state.dirty ? "有未保存的参数" : state.data?.selected.ready ? "当前已保存参数" : "尚未保存经典参数";
  $("deskResetDraft").disabled = !state.dirty || state.busy || state.switching;
  for (const element of document.querySelectorAll("[data-quote]")) element.textContent = unit;
  const amount = value => value == null ? "—" : format(value) + " " + unit;
  $("previewFirstMargin").textContent = amount(preview.firstMargin);
  $("previewAddMargin").textContent = preview.valid && c.maxAdds === 0 ? "不补仓" : amount(preview.addMargin);
  $("previewOrderCount").textContent = preview.valid ? preview.orderCount + " 笔（含首仓）" : "—";
  $("previewNotional").textContent = amount(preview.notional);
  $("previewMargin").textContent = amount(preview.margin);
  $("deskBudget").textContent = !preview.valid ? "请填写完整、有效的参数。" : (state.dirty ? "未保存 · " : "") + "首仓 + " + c.maxAdds + " 次补仓，按 " + c.leverage + " 倍杠杆估算。";
  $("baseAmountHelp").textContent = preview.valid ? "名义金额 " + amount(c.baseAmount) + "，预计保证金 " + amount(preview.firstMargin) + "。" : "第一笔仓位的名义金额，不是保证金。";
  $("addAmountHelp").textContent = preview.valid ? c.maxAdds ? "每次名义金额 " + amount(c.addAmount) + "，预计保证金 " + amount(preview.addMargin) + "。" : "补仓次数为 0，本轮不补仓。" : "每次补仓使用相同的名义金额。";
  $("addTriggerHelp").textContent = preview.valid ? "相对最近成交价" + (c.side === "long" ? "下跌 " : "上涨 ") + format(c.addTrigger * 100, 6) + "% 后触发下一次补仓。" : "相对最近成交价，做多下跌补仓，做空上涨补仓。";
  $("takeProfitHelp").textContent = preview.valid ? "保证金毛收益达到 " + format(c.takeProfit * 100, 6) + "% 时整仓止盈；不是币价涨跌幅，净收益需扣除手续费与滑点。" : "以保证金毛收益率计算，不是币价涨跌幅。";
  $("previewReference").textContent = preview.reference ? "以当前报价 " + format(preview.reference, 6) + " " + unit + " 举例 · " + (c.side === "long" ? "做多" : "做空") : "暂无新鲜报价，资金用量仍可预览。";
  const ladder = $("previewLadder");ladder.replaceChildren();
  for (const item of preview.rows) {const row = node("tr");row.append(node("td", item.index ? "补仓 " + item.index : "首仓"), node("td", format(item.price, 6)), node("td", format(item.amount)));ladder.append(row);}
  if (!preview.rows.length) {const row = node("tr"), cell = node("td", preview.valid ? "等待最新行情后显示价格示例" : "请先填写有效参数", "empty-cell");cell.colSpan = 3;row.append(cell);ladder.append(row);}
 }
 function render() {
  const data = state.data;
  $("deskHealth").textContent = state.offline ? "数据未同步" : "服务在线";
  $("deskHealth").className = "connection" + (state.offline ? "" : " ready");
  if (!data) {
   $("page-trading").hidden=true;
   for(const element of document.querySelectorAll("[data-strategy],#deskAccountPicker,#deskPrimaryAction,#deskPauseAction,#deskEditShortcut,#deskHistoryShortcut,#deskNewAccount"))element.disabled=true;
   for (const name of keys) field(name).disabled = true;
   $("deskSave").disabled = $("deskSaveTop").disabled = true;
   return;
  }
  const a = data.selected, s = data.snapshot, p = s.position, unit = a.quoteAsset;
  if(liveChoiceAccount!==a.id){
   liveChoiceAccount=a.id;liveChoice=s.strategy||"classic";liveFieldsVersion="";
  }
  $("liveStrategyGroup").hidden=!a.liveStrategy;
  if(!a.liveStrategy){
   $("liveStrategySelect").disabled=true;
   for(const group of form.querySelectorAll("fieldset:not(#liveStrategyGroup)"))group.hidden=false;
   document.querySelector("#page-parameters .parameter-preview").hidden=false;
   $("deskParameterTitle").textContent="经典策略参数";
  }
  if(state.empty||isPaperMode(state.mode)){
   $("deskAccount").textContent=state.empty?strategies[state.mode]:a.name;
   $("deskInstrument").textContent=state.empty?"请选择或新建账户":(labels[a.platform]||a.platform)+" · "+a.symbol+" / "+unit;
   $("page-trading").hidden=true;
   renderList();renderStarter(a,s);
   return;
  }
  $("page-trading").hidden=false;
  $("deskAccount").textContent = a.name;
  $("deskInstrument").textContent = (labels[a.platform] || a.platform) + " · " + a.symbol + " / " + unit;
  $("deskMode").textContent = a.paper ? "Paper · 模拟" : a.liveStrategy ? "Live · 实盘" : "Live · 原账户";
  const locked = s.blocked || a.eligible && data.ledgerBlocked;
  const runText = locked ? "风控待核对" : a.error ? "当前异常" :
    !a.eligible ? (a.paper ? "只读" : a.running ? "原策略监控中" : "真实账户连接") : a.running ? "运行中" : a.ready ? "已暂停" : "待配置";
  $("deskMarket").textContent = state.offline ? "连接中断" : a.error ? "行情或执行异常" : s.market;
  const held=trade.position(s,!state.offline);
  trade.badge($("deskPositionBadge"),held.text,held.tone);
  trade.badge($("deskRun"),runText,locked||a.error?"risk":state.offline?"neutral":a.running?"ok":a.eligible?"warning":"neutral");
  const market=$("deskMarket");
  trade.badge(market,market.textContent,state.offline||a.error?"risk":s.native?s.updatedAt?"ok":"warning":s.mark>0?"ok":"warning");
  $("deskStrategy").textContent = a.strategy;
  money("deskEquity", s.equity, unit);
  money("deskFloating", s.floating, unit, true);
  money("deskRealized", s.realized, unit, true);
  $("deskRealized").nextElementSibling.textContent=a.liveStrategy?"本策略已平仓损益，扣交易费，未计资金费":"已结算交易";
  money("deskAvailable", s.available, unit);
  $("deskEquity").previousElementSibling.textContent=s.valuationBasis==="native_balance"?"交易所账户余额":s.valuationBasis==="native_equity"?"交易所账户权益":"账户权益";
  $("deskFloating").previousElementSibling.textContent=s.floatingBasis==="native_unrealized"?"交易所未实现盈亏":"浮动净盈亏";
  $("deskFloating").nextElementSibling.textContent=s.floatingBasis==="native_unrealized"?"原生口径，未扣预计退出成本":"预计扣除平仓成本";
  $("deskMargin").textContent = "占用保证金 " + format(s.margin);
  renderPlan(a, s);
  if(a.liveStrategy&&s.strategy&&s.strategy!=="classic"){
   document.querySelector(".price-cards").hidden=false;
   $("deskOpenPrice").textContent=format(p?.entry,6);
   $("deskOpenStatus").textContent=p?"交易所实际成交均价":"等待新的已收盘信号";
   $("deskOpenAmount").textContent=p?format(p.notional)+" "+unit:"按账户权益与计划风险计算";
   $("deskAddPrice").closest("section").querySelector(".card-kicker").textContent="本轮止损保护价";
   $("deskAddPrice").textContent=format(s.protection?.stop,6);
   $("deskAddStatus").textContent=s.protection?.stop?"原生盘口触发后提交退出":"建仓成交后锁定止损";
   $("deskAddAmount").textContent="本策略不补仓";
   $("deskAddQty").textContent="—";
   $("deskTargetPrice").textContent=format(s.protection?.target,6);
   $("deskExitStatus").textContent=s.protection?.target?"按结构目标退出":"按通道或移动保护退出";
   $("deskTargetReturn").textContent=s.settings?.riskPerTrade?format(s.settings.riskPerTrade*100)+"% 每笔计划风险":"—";
  }else{
   $("deskAddPrice").closest("section").querySelector(".card-kicker").textContent="下次补仓价格";
  }
  $("deskNext").textContent = a.error || s.notice || "等待下一次有效行情";
  $("deskLast").textContent = "最近动作 · " + (s.lastAction || "暂无");
  $("deskUpdated").textContent = (s.native?"账户同步":"行情时间") + " · " + time(s.updatedAt);
  $("deskSetupPrompt").hidden = true;
  for (const button of document.querySelectorAll("[data-action]")) {
   const action = button.dataset.action;
   const canClose = !!p && (!a.liveStrategy || s.managedPosition);
   if(action==="start")button.textContent=a.liveStrategy?"启动实盘":"启动模拟";
   if(action==="close")button.textContent=a.liveStrategy?"平掉策略实盘仓":"平掉模拟仓";
   button.hidden=!a.eligible||!a.ready||(action==="start"?a.running:action==="pause"?!a.running:!canClose);
   button.disabled = button.hidden || state.busy || state.switching || state.offline ||
     action !== "pause" && (s.blocked || !!s.pendingOrder || action === "start" && state.dirty);
  }
  $("deskConfigAccount").textContent = a.name + " · " + a.symbol + " / " + unit;
  const editable = !state.offline && !state.busy && !state.switching && a.eligible && !a.running && !p && !s.managedPosition && !s.pendingOrder && !s.blocked && !data.ledgerBlocked;
  $("deskConfigHint").textContent = state.offline ? "连接中断，暂不能保存。已填写的参数仍保留，请恢复连接后重试。" : data.ledgerBlocked || s.blocked ? "当前账户暂时锁定，不能修改参数。" : !a.eligible ? "当前账户只读，不能在这里修改策略。请选择左侧标有「可配置」的模拟账户，或新增一个模拟账户。" :
   s.pendingOrder ? "委托待核对，确认后可修改参数。" : p || s.managedPosition ? (a.paper?"当前有模拟持仓，结清后可修改参数。":"当前有实盘持仓，结清后可修改参数。") : a.running ? "暂停新增后可编辑参数。" :
   a.liveStrategy ? (s.nativeLeverage ? labels[a.platform]+" 当前杠杆 · 多 "+s.nativeLeverage.long+"× / 空 "+s.nativeLeverage.short+"×。确认启动时按已保存参数设置杠杆。" : "保存后，启动前会核对交易所的实际杠杆和合约规格。") :
   "填写 1 表示 1%。保存后可检查并确认启动。";
  $("deskConfigHint").classList.toggle("locked", !editable);
  if (!state.dirty) {
   const settings = s.settings || data.defaultSettings;
   for (const name of keys) field(name).value = ["addTrigger", "takeProfit"].includes(name) ? Number((settings[name] * 100).toFixed(6)) : settings[name];
  }
  updateBudget();
  for (const name of keys) field(name).disabled = !editable;
  if(a.liveStrategy)renderLiveParameters(a,s,editable);
  $("deskSave").disabled = !editable;
  $("deskSaveTop").disabled = !editable;
  $("deskSaveTop").textContent = a.liveStrategy ? "保存并核对实盘" : "保存并启动模拟";
  renderList();
  renderStarter(a,s);
 }
 function renderLiveParameters(account,snapshot,editable){
  const catalog=snapshot.strategies||[],select=$("liveStrategySelect");
  if(select.dataset.account!==account.id||select.options.length!==catalog.length){
   select.replaceChildren(...catalog.map(p=>{const el=node("option",p.label);el.value=p.id;return el;}));
   select.dataset.account=account.id;
  }
  select.value=liveChoice;select.disabled=!editable;
  const custom=liveChoice!=="classic",profile=catalog.find(p=>p.id===liveChoice);
  $("deskParameterTitle").textContent=(profile?.label||"经典补仓")+" · 实盘参数";
  $("liveStrategyInfo").textContent=account.name+" · "+labels[account.platform]+" · "+account.symbol+"/"+account.quoteAsset;
  for(const group of form.querySelectorAll("fieldset:not(#liveStrategyGroup)"))group.hidden=custom;
  if(custom)for(const name of keys)field(name).disabled=true;
  document.querySelector("#page-parameters .parameter-preview").hidden=custom;
  $("liveParameterFields").hidden=!custom;
  const version=[account.id,liveChoice,snapshot.settingsHash].join(":");
  if(!custom){
   for(const input of $("liveParameterFields").querySelectorAll("input,select"))input.disabled=true;
   if(liveFieldsVersion!==version){
    const values=snapshot.strategy==="classic"&&snapshot.settings?snapshot.settings:state.data.defaultSettings;
    for(const name of keys)field(name).value=["addTrigger","takeProfit"].includes(name)?values[name]*100:values[name];
    liveFieldsVersion=version;
   }
   return;
  }
  if(version!==liveFieldsVersion){
   liveFieldsVersion=version;
   const values=(liveChoice===snapshot.strategy?snapshot.settings:null)||profile?.defaults;
   $("liveParameterFields").replaceChildren(...(profile?.fields||[]).map(f=>{
    const label=node("label",f.label),input=document.createElement(f.options?"select":"input");
    input.name="live_"+f.key;
    if(f.options)input.replaceChildren(...f.options.map(value=>{const o=node("option",{long:"只做多",short:"只做空",both:"双向"}[value]||value);o.value=value;return o;}));
    else{input.type="number";input.step="any";input.required=true;}
    input.value=f.percent?values[f.key]*100:values[f.key];
    label.append(input);
    if(f.percent)label.append(node("small","输入百分比，例如 0.5 表示 0.5%。"));
    return label;
   }));
  }
  for(const input of $("liveParameterFields").querySelectorAll("input,select"))input.disabled=!editable;
 }
 $("liveStrategySelect").onchange=()=>{
  liveChoice=$("liveStrategySelect").value;liveFieldsVersion="";state.dirty=true;render();
 };
 async function load() {
  const ticket = ++state.request;
  try {
   const get = id => api("/api/v4/desk" + (id ? "?id=" + encodeURIComponent(id) : ""));
   let data = await get(state.id);
   if (ticket !== state.request) return;
   if(!state.mode){
    const selectedMode=fromAccount(data.selected);
    state.mode=selectedMode!=="history"?selectedMode:accountsFor("classic",data.accounts).length?"classic":(Object.keys(paperStrategies).find(mode=>accountsFor(mode,data.accounts).length)||"classic");
   }
   const list=accountsFor(state.mode,data.accounts);
   const account=list.find(a=>a.id===state.id)||preferred(state.mode,data.accounts);
   if(account&&account.id!==data.selected.id){
    data=await get(account.id);
    if(ticket!==state.request)return;
    if(data.selected.id!==account.id)throw Error("未找到所选账户，请刷新后重试。");
   }
   state.data = data;
   state.id = account?.id||"";
   state.empty = !account;
   if(state.id)state.lastAccounts[state.mode]=state.id;
   rememberAccount();
   const legacyPicker=$("connectionSwitcher");
   if([...legacyPicker.options].some(option=>option.value===state.id))legacyPicker.value=state.id;
   state.offline = false;
   if(isPaperMode(state.mode))showTurtle(state.id);
   else hideTurtle();
   render();
   if(state.drawer==="history"&&!isPaperMode(state.mode))loadTrades();
  } catch (error) {
   if (ticket !== state.request) return;
   state.offline = true;
   message(error.message);
   render();
  }
 }
 async function mutate(route, input, success) {
  if (state.busy || state.switching || state.offline) return false;
  state.request++;state.busy = true;render();
  try {await api("/api/v4/desk/" + route, {id: state.id, ...input});if(route==="settings")state.dirty=false;message(success,"success");await load();return true;}
  catch (error) {message(error.message);return false;}
  finally {state.busy = false;render();}
 }
 const tradeReasons={hard_sl:"保护止损",channel_exit:"通道退出",manual_close:"手动退出",take_profit:"止盈",mean_target:"回归中轨止盈",swing_target:"达到前波段目标",time_stop:"到期退出",swing_momentum_exit:"波段动量确认退出",swing_trailing_exit:"波段移动保护退出",
  hedge_failed:"对冲失败，退出单腿",risk_exit:"风控退出",funding_gap:"资金费待核对",rate_reversed:"资金费率反转"};
 const historyColumns=["平仓时间","方向","开仓 → 平仓","净盈亏","手续费","原因"];
 const carryColumns=["平仓时间","现货 / 永续","资金费","基差损益","单腿损益","交易成本","净盈亏","原因"];
 const historyPageSize=30;
 let historyRequest=0;
 async function loadTrades() {
  if (!state.id) return;
  const {id,offset,mode}=state, ticket=++historyRequest;
  const turtle=isPaperMode(mode),snapshot=turtle?state.turtle?.snapshot:state.data?.snapshot;
  const account=state.data?.selected;
  const columns=mode==="carry"?carryColumns:historyColumns;
  $("deskHistoryColumns").replaceChildren(...columns.map(label=>node("th",label)));
  const current=()=>ticket===historyRequest&&id===state.id&&offset===state.offset&&state.drawer==="history";
  const box=$("deskTrades"), status=$("deskHistoryStatus");
  $("deskHistoryAccount").textContent=(account?.name||"")+" · "+(account?.quoteAsset||"")+" · 北京时间";
  const net=snapshot?.realized;
  $("deskHistoryNet").textContent=net==null?"—":format(net,4)+" "+(account?.quoteAsset||"");
  $("deskHistoryNet").className=net>0?"positive":net<0?"negative":"";
  state.trades=[];
  box.replaceChildren();
  for(const button of ["deskPrev","deskNextPage","deskExport"])$(button).disabled=true;
  $("deskHistoryCount").textContent="—";
  status.textContent="正在读取已结算交易…";
  try {
   if(turtle&&(!snapshot||snapshot.id!==id))throw Error("模拟记录尚未同步，请稍后重试。");
   const records=turtle?snapshot.history:null;
   const data=mode==="turtle"?{total:records.length,items:records.slice(offset,offset+historyPageSize)}:
    await api("/api/v4/"+(turtle?mode:"desk")+"/history?id="+encodeURIComponent(id)+"&offset="+offset);
   if(!current())return;
   state.trades=data.items;
   status.textContent=mode==="turtle"?"显示最近 50 笔已结算交易。":"";
   for(const item of data.items) {
    const row = node("tr");
   if(mode==="carry"){
    const spot=format(item.spotEntry,6)+" → "+format(item.spotExit,6);
    const perp=item.perpEntry==null?"未成交":format(item.perpEntry,6)+" → "+format(item.perpExit,6);
    const amounts=[item.fundingPnl,item.basisPnl,item.unhedgedPnl,item.tradingFee+item.slippageAmount,item.netPnl];
    row.append(node("td",time(item.time)),node("td","现货 "+spot+" / 永续 "+perp),
     ...amounts.map((value,i)=>node("td",format(value,4),i===4?(value>0?"positive":value<0?"negative":""):"")),
     node("td",tradeReasons[item.reason]||item.reason||"—"));
   }else {
    const directionCell=node("td"),marker=node("span"),label=trade.side(item.side);
    trade.badge(marker,label.action,label.tone);
    directionCell.append(marker);
    row.append(node("td", time(item.time)), directionCell,
      node("td", format(item.entryPrice, 6) + " → " + format(item.exitPrice, 6)),
      node("td", format(item.netPnl, 4), item.netPnl > 0 ? "positive" : item.netPnl < 0 ? "negative" : ""),
      node("td", format(item.tradingFee, 4)), node("td", tradeReasons[item.reason]||item.reason||"—"));
   }
    [...row.children].forEach((cell, i) => cell.dataset.label = columns[i]);
    box.append(row);
   }
   if (!data.items.length) {const row = node("tr"), td = node("td", "暂无已结算交易", "empty-cell");td.colSpan = columns.length;row.append(td);box.append(row);}
   $("deskHistoryCount").textContent = "共 " + data.total + " 笔";
   $("deskPrev").disabled = offset === 0;
   $("deskNextPage").disabled = offset + historyPageSize >= data.total;
   $("deskExport").disabled = !data.items.length;
  } catch (error) {
   if(current()){
    status.textContent=error.message;
    $("deskPrev").disabled=offset===0;
   }
  }
 }
 $("deskExport").onclick = () => {
  const cell = value => {
   let s = String(value ?? "");
   if (typeof value === "string" && /^[=+\-@\s]/.test(s)) s = "'" + s;
   return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = state.mode==="carry"?
   [["时间","现货开仓","现货退出","永续开仓","永续退出","资金费","基差损益","单腿损益","手续费","滑点与价差","净盈亏","退出原因"],
    ...state.trades.map(t=>[time(t.time),t.spotEntry,t.spotExit,t.perpEntry,t.perpExit,t.fundingPnl,t.basisPnl,t.unhedgedPnl,t.tradingFee,t.slippageAmount,t.netPnl,t.reason])]:
   [["时间","方向","开仓价","平仓价","净盈亏","手续费","退出原因"], ...state.trades.map(t => [time(t.time),t.side,t.entryPrice,t.exitPrice,t.netPnl,t.tradingFee,t.reason])];
  const link = node("a"), url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n")], {type: "text/csv;charset=utf-8"}));
  link.href = url;link.download = "just-agent-trades.csv";link.click();setTimeout(() => URL.revokeObjectURL(url), 1000);
 };
 async function startClassic(){
  const account=state.data?.selected;
  if(state.mode!=="classic"||!account?.eligible||!account.ready||account.running||state.busy||state.dirty||state.switching||state.offline)return;
  if(account.liveStrategy){
   if(state.data.snapshot.pendingOrder||state.data.snapshot.blocked)return;
   let settingsHash;
   state.busy=true;render();
   try{
    const review=await api("/api/v4/desk/preflight?id="+encodeURIComponent(account.id));
    if(!review.allowed){message(review.blockers.join("；"));return;}
    const c=review.settings,selected=state.data.snapshot;
    const detail=(selected.strategy||"classic")==="classic"?"首仓最多 "+c.baseAmount+" "+account.quoteAsset+" 名义金额，每次补仓最多 "+c.addAmount+"，最多 "+c.maxAdds+" 次。":
     selected.strategyLabel+" · 每笔计划风险 "+format(c.riskPerTrade*100)+"%。";
    const accepted=await JustDialogs.show({title:"启动 "+account.name+" 的实盘策略？",
     message:account.symbol+"/"+account.quoteAsset+" · "+({long:"做多",short:"做空",both:"双向"}[c.side||c.direction])+" · 启动时设定 "+c.leverage+"×。"+detail+"确认后，策略可在有效条件下提交真实委托。",
     action:"确认启动实盘",danger:true});
    if(!accepted||state.id!==account.id)return;
    settingsHash=review.settingsHash;
   }catch(error){message(error.message);return;}
   finally{state.busy=false;render();}
   return mutate("control",{action:"start",confirm:true,settingsHash},"实盘已启动，等待原生委托回报。");
  }
  message("正在核对行情并启动 "+account.name+"…","neutral");
  return mutate("control",{action:"start"},"已启动经典模拟，等待有效行情。");
 }
 for (const button of document.querySelectorAll("[data-action]")) button.onclick = async () => {
  const action = button.dataset.action, a = state.data?.selected;
  if (!a || button.disabled) return;
  if(action==="start")return startClassic();
  if(action==="close"){
   const p=state.data.snapshot.position;
   const title=a.liveStrategy?"市价平掉 "+a.name+" 的策略实盘仓？":"平掉 "+a.name+" 的模拟仓位？";
   const detail=a.liveStrategy?trade.side(p.side).action+" · "+format(p.qty)+" "+(p.qtyUnit||a.symbol)+" · "+a.symbol+"/"+a.quoteAsset+"。提交后暂停新增，实际成交价以交易所回报为准。":"平仓后暂停策略。";
   if(!await JustDialogs.show({title,message:detail,action:a.liveStrategy?"确认实盘平仓":"确认模拟平仓",danger:true}))return;
   if(state.data?.selected.id!==a.id)return;
  }
  mutate("control", {action, ...(action === "close" ? {confirm: true} : {})}, action === "pause" ? "已暂停新增交易。" : a.liveStrategy ? "已提交平仓请求，等待交易所成交核对。" : "模拟仓位已平，策略已暂停。");
 };
 form.oninput = () => {state.dirty=true;render();};
 $("deskResetDraft").onclick = async () => {
  if(!state.dirty||state.busy||!await JustDialogs.discard("恢复上次保存的策略参数。"))return;
  state.dirty=false;
  render();
 };
 form.onsubmit = async event => {
  event.preventDefault();
  if(!form.reportValidity())return;
  const andStart=event.submitter?.id==="deskSaveTop";
  const live=state.data?.selected.liveStrategy;
  if(!await mutate("settings",{settings:settingsValues(),...(live?{strategy:liveChoice,expectedHash:state.data.snapshot.settingsHash}:{})},live?"实盘策略参数已保存。":"经典参数已保存。"))return;
  await closeDrawer();
  if(andStart)startClassic();
 };
 $("deskRefresh").onclick = async () => {message("");await load();turtleDesk?.refresh();};
 $("deskSearch").oninput = renderList;
 $("deskPrev").onclick = () => {state.offset = Math.max(0,state.offset - historyPageSize);loadTrades();};
 $("deskNextPage").onclick = () => {state.offset += historyPageSize;loadTrades();};
 document.addEventListener("just-account-selecting", event => {
  if(state.busy||state.switching||state.turtle?.busy)return event.preventDefault();
  if(turtleDesk)event.check(turtleDesk.canLeave);
  if(state.dirty)event.check(()=>JustDialogs.discard("切换后，本次策略参数修改将丢失。"));
  event.onAllowed(()=>{state.switching=true;state.request++;render();});
 });
 document.addEventListener("just-account-switch-finished", event => {
  state.switching = false;
  if (!event.detail.success) {if (!event.detail.cancelled) message("账户切换失败，已保留原账户和参数。");render();}
 });
 async function resetSelection(id){
  state.switching = false;
  state.id=id;state.data=null;state.dirty=false;state.offset=0;state.offline=true;state.trades=[];
  hideTurtle();rememberAccount();
  closeRail();
  $("deskAccount").textContent = "正在切换账户…";
  for (const id of ["deskEquity","deskFloating","deskRealized","deskAvailable","deskOpenPrice","deskAddPrice","deskTargetPrice"]) $(id).textContent = "—";
  $("deskTrades").replaceChildren();
  $("deskExport").disabled = true;$("deskSave").disabled = true;$("deskSaveTop").disabled = true;
  for (const button of document.querySelectorAll("[data-action]")) button.disabled = true;
  message("");render();await load();
  if(state.queuedDrawer){const drawer=state.queuedDrawer;state.queuedDrawer="";openDrawer(drawer);}
 }
 document.addEventListener("just-accounts-updated",()=>load());
 document.addEventListener("just-connection-checked",()=>load());
 document.addEventListener("just-account-selected",event=>{
  const fromConnection=event.account?{...event.account,eligible:event.account.liveStrategy||event.account.tradeMode==="simulation"&&event.account.simulationEnabled&&event.account.connectionOnly}:null;
  const account=state.data?.accounts.find(a=>a.id===event.detail)||fromConnection;
  state.filter="all";$("deskSearch").value="";
  for(const button of document.querySelectorAll("[data-filter]"))button.setAttribute("aria-pressed",String(button.dataset.filter==="all"));
  // New connection records arrive just before the refreshed account list.
  state.mode=account?fromAccount(account):"classic";
  resetSelection(event.detail);
 });
 $("openConnections").onclick = () => openDrawer("accounts");
 document.addEventListener("just-go-page", event => {
  if(!state.data||state.switching)state.queuedDrawer=event.detail;
  else openDrawer(event.detail);
 });
 for (const button of document.querySelectorAll("[data-go]")) button.onclick = () => openDrawer(button.dataset.go);
 for(const button of document.querySelectorAll("[data-dismiss]"))button.onclick=closeDrawer;
 for(const page of ["parameters","accounts","history"])$("page-"+page).addEventListener("cancel",event=>{event.preventDefault();closeDrawer();});
 $("toggleAccounts").onclick = () => {
  if (matchMedia("(max-width:760px)").matches) {
   document.body.classList.remove("rail-collapsed");
   const open = document.body.classList.toggle("rail-open");$("railBackdrop").hidden = !open;$("toggleAccounts").setAttribute("aria-expanded", String(open));
  } else {document.body.classList.toggle("rail-collapsed");closeRail();}
 };
 $("railBackdrop").onclick = closeRail;
 document.addEventListener("keydown", event => {if (event.key === "Escape") closeRail();});
 window.addEventListener("resize", closeRail);
 function openLegacyLink(){
  const page=location.hash.slice(1);
  if(page)history.replaceState(null,"",location.pathname+location.search);
  openDrawer(page);
 }
 window.addEventListener("hashchange",openLegacyLink);
 window.addEventListener("beforeunload", event => {if (state.dirty||state.busy||state.turtle?.busy||state.turtle?.dirty) {event.preventDefault();event.returnValue = "";}});
 for (const button of document.querySelectorAll("[data-filter]")) button.onclick = () => {
  state.filter = button.dataset.filter;
  for (const option of document.querySelectorAll("[data-filter]")) option.setAttribute("aria-pressed", String(option === button));
  renderList();
 };
 load().then(openLegacyLink);
 setInterval(() => {if (!state.busy && !state.switching && document.visibilityState === "visible") load();}, 10000);
})();
