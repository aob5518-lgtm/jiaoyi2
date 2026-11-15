(function(){
 "use strict";
 function mount(root, {accountId, embedded=false, mode="turtle", onCreated, onState}={}){
 const $=id=>root.getElementById(id),node=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text??"";if(cls)e.className=cls;return e;};
 const reversal=mode==="reversal",form=$("config-form");
 const labels={riskPerTrade:"单笔计划风险",leverage:"模拟杠杆",direction:"方向",entryBars:"入场通道",exitBars:"退出通道",atrPeriod:"ATR 周期",stopAtr:"初始止损倍数",
  bandBars:"布林带周期",bandWidth:"布林带宽度",maxAdx:"ADX 上限",minNetR:"最低净收益风险比",maxHoldBars:"最长持仓根数"};
 const reversalFields=[
  ["bandBars","15","50","1"],["bandWidth","1.5","3","any"],["maxAdx","15","30","any"],
  ["minNetR","1.2","3","any"],["maxHoldBars","4","24","1"]
 ];
 const keys=reversal?["riskPerTrade","direction",...reversalFields.map(([key])=>key)]:
  ["entryBars","exitBars","atrPeriod","stopAtr","riskPerTrade","leverage","direction"];
 if(reversal){
  $("empty").querySelector("h2").textContent="创建找底摸顶 4H 模拟账户";
  $("empty").querySelector(".features").replaceChildren(...["极值后等收盘确认","结构止损 · 回归中轨止盈","固定 1 倍 · 单笔默认风险 0.5%"].map(value=>node("span",value)));
  $("create-form").elements.name.value="找底摸顶 4H · ETH Paper";
  form.elements.leverage.closest("label").remove();
  form.elements.direction.options[0].textContent="双向反转";
  const advanced=form.querySelector("details");
  advanced.querySelector("summary").textContent="高级参数 · 区间、成本与持仓";
  advanced.querySelector(".fields").replaceChildren(...reversalFields.map(([key,min,max,step])=>{
   const label=node("label",labels[key]),input=node("input");
   Object.assign(input,{name:key,type:"number",min,max,step,required:true});
   label.append(input);
   return label;
  }));
  const levels=$("desk").querySelectorAll(".levels section");
  const setLevel=(i,label,hint)=>{
   levels[i].querySelector("span").textContent=label;
   levels[i].querySelector("small").textContent=hint;
  };
  setLevel(0,"找底观察价","收盘越过下轨，等待反向确认");
  setLevel(1,"摸顶观察价","收盘越过上轨，等待反向确认");
  const oscillators=node("p","","muted");
  oscillators.id="reversal-indicators";
  $("decision").after(oscillators);
  $("position").parentElement.querySelector("p:last-child").textContent="结构止损、中轨目标与到期退出。暂停新增后，持仓保护继续。";
 }
 const state={id:accountId??new URLSearchParams(location.search).get("account")??"",accounts:[],defaults:null,data:null,busy:false,dirty:false,editBase:null,hash:null,confirmHash:null,confirmAllowed:false,online:false,loaded:false,ticket:0,filter:"all"};
 let disposed=false;
 const fmt=(x,n=2)=>x==null||!Number.isFinite(Number(x))?"—":Number(x).toLocaleString("zh-CN",{maximumFractionDigits:n}),time=x=>x?new Date(x).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—",percent=x=>fmt(x*100,6)+"%";
 const direction={both:"双向",long:"仅做多",short:"仅做空"};
 let railKey="";
 const codes={MONITOR_STOPPED:"未运行",WAIT_BREAKOUT:"等待突破",BREAKOUT:"突破信号",ORDER_SUBMITTED:"委托已提交",WAIT_NEW_QUOTE:"等待新报价",POSITION_MANAGED:"持仓保护中",ORDER_FILLED:"已成交",MARKET_UNAVAILABLE:"行情阻断",RUNTIME_ERROR:"执行异常",RISK_BLOCK:"风险阻断",PORTFOLIO_BLOCK:"组合风险阻断",DAILY_LOSS_BLOCK:"日亏损限制",ENTRY_CANCELLED:"开仓已取消",SIZE_BLOCK:"规格阻断"};
 Object.assign(codes,{WAIT_REVERSAL:"等待极值",WAIT_CONFIRMATION:"等待收盘确认",TREND_BLOCK:"趋势过强",REVERSAL_CONFIRMED:"反转已确认",DIRECTION_BLOCK:"方向限制",COST_BLOCK:"收益空间不足",STRUCTURE_RISK:"结构止损不合格"});
 const reasons={hard_sl:"保护止损",channel_exit:"通道退出",manual_close:"手动退出"};
 async function api(route,body){const r=await fetch("/api/v4/"+(reversal?"reversal":"turtle")+"/"+route,{credentials:"same-origin",cache:"no-store",...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});if(r.status===401)throw Error("登录已过期，请重新登录");const v=await r.json();if(!r.ok||!v.ok){const error=Error(v.error||"请求失败");error.snapshot=v.snapshot;throw error;}return v;}
 function msg(s){$("message").textContent=s;$("message").hidden=!s;}
 function amount(value){return value==null?"—":fmt(value)+" USDT";}
 function money(id,value){$(id).textContent=amount(value);$(id).className=value>0?"positive":value<0?"negative":"";}
 function values(){const c={};for(const k of keys)c[k]=k==="direction"?form.elements[k].value:Number(form.elements[k].value);c.riskPerTrade/=100;return c;}
 function setFields(c){for(const k of keys)form.elements[k].value=k==="riskPerTrade"?Number((c[k]*100).toPrecision(15)):c[k];preview();}
 function setting(key,value){if(key==="direction")return direction[value];if(key==="riskPerTrade")return percent(value);if(key==="leverage")return value+"x";if(key==="stopAtr")return fmt(value,6)+" ATR";if(key==="minNetR")return value+"R";if(["maxAdx","bandWidth"].includes(key))return fmt(value,4);return value+" 根";}
 function differences(from,to){return keys.filter(k=>k==="riskPerTrade"?Math.abs(from[k]-to[k])>1e-15:from[k]!==to[k]).map(k=>labels[k]+" "+setting(k,from[k])+" → "+setting(k,to[k]));}
 function list(id,rows){const box=$(id);box.replaceChildren(...rows.map(value=>node("li",value)));box.hidden=!rows.length;}
 function preview(){
  const c=values(),valid=keys.every(k=>form.elements[k].validity.valid)&&(reversal||c.exitBars<c.entryBars);
  const changes=state.editBase?differences(state.editBase,c):[];
  state.dirty=changes.length>0;
  const invalid=keys.find(key=>!form.elements[key].validity.valid);
  $("preview").textContent=invalid?labels[invalid]+"："+form.elements[invalid].validationMessage:
   !valid?"退出通道须短于入场通道。":!state.dirty?"当前参数已保存。修改后即可保存。":
   "草稿单笔计划风险 "+amount(state.data?.balance*c.riskPerTrade)+"（"+percent(c.riskPerTrade)+"）。";
  list("config-changes",valid?changes:[]);
  $("save").disabled=state.busy||!state.online||!valid||!state.dirty;
  $("save-start").hidden=!!(state.data?.running||state.data?.pending||state.data?.riskLock);
  $("save-start").textContent=embedded?"保存并启动模拟":"保存并检查启动";
  $("save-start").disabled=$("save").disabled;
 }
 function details(target,entries){const box=$(target);box.replaceChildren();for(const [label,value] of entries){const section=node("section");section.append(node("span",label),node("strong",value));box.append(section);}}
 function rail(){
  const term=$("search").value.trim().toLowerCase(),box=$("accounts");
  const visible=state.accounts.filter(a=>{
   if(state.filter==="turtle"&&a.strategyType!=="turtle_4h_v1"||state.filter==="running"&&!a.running)return false;
   return [a.name,a.platform,a.symbol,a.symbol+"/"+a.quoteAsset,a.strategyType==="turtle_4h_v1"?"海龟趋势 4H":a.strategyType].join(" ").toLowerCase().includes(term);
  });
  const key=JSON.stringify([state.id,visible,state.loaded]);
  if(key===railKey)return;
  railKey=key;
  const focused=box.contains(document.activeElement)?document.activeElement.dataset.accountId:null,scroll=box.scrollTop;
  const rows=visible.map(a=>{
   const button=node("button",null,"account"+(a.id===state.id?" selected":""));
   button.type="button";button.title=a.name;button.dataset.accountId=a.id;
   if(a.id===state.id)button.setAttribute("aria-current","true");
   button.append(node("strong",a.name),node("span",a.symbol+"/"+a.quoteAsset+" · "+(a.strategyType==="turtle_4h_v1"?"海龟趋势 4H":"已有账户")),node("span",(a.paper?"Paper":"原 Live")+" · "+(a.running?"运行中":"已暂停")));
   button.onclick=()=>select(a);
   return button;
  });
  box.replaceChildren(...(rows.length?rows:[node("p",state.loaded?"没有匹配的账户":"正在读取账户…","muted")]));
  box.scrollTop=scroll;
  rows.find(button=>button.dataset.accountId===focused)?.focus({preventScroll:true});
 }
 function rememberAccount(){
  const url=new URL(location.href);url.searchParams.set("account",state.id);history.replaceState(null,"",url);
 }
 async function select(a){if(state.busy)return;if(state.dirty&&!confirm("放弃尚未保存的参数并切换账户？"))return;if(a.strategyType!=="turtle_4h_v1"){location.href="/?account="+encodeURIComponent(a.id);return;}
  state.ticket++;state.id=a.id;state.data=null;state.dirty=false;state.hash=null;closeRail();rememberAccount();render();await load();
 }
 function render(){
  for(const e of root.querySelectorAll("#config-form input,#config-form select,#config-form button,#create-form input,#create-form select,#create-form button"))e.disabled=state.busy;
  if($("parameters").open)preview();
  $("recheck-start").disabled=state.busy;
  $("confirm-start").disabled=state.busy||!state.online||!state.confirmAllowed||state.confirmHash!==state.data?.configHash;
  if($("confirm").open&&state.confirmHash!==state.data?.configHash)$("start-error").textContent="已保存参数发生变化，请取消并重新检查后确认。";
  const s=state.data;$("empty").hidden=!state.loaded||!!state.id;$("desk").hidden=!s;
  onState?.({snapshot:s,accounts:state.accounts,loaded:state.loaded,busy:state.busy,online:state.online,dirty:state.dirty});
  if(!embedded)rail();
  if(!s)return;
  if(!embedded){$("title").textContent=s.name;$("instrument").textContent="Binance 永续 · "+s.symbol+" / USDT";}
  $("run").textContent=s.running?"RUNNING · 运行中":"PAUSED · 已暂停";$("run").className="tag"+(s.running?" healthy":"");
  const marketText={fresh:"原生行情新鲜",unchecked:"等待原生行情",stale:"原生报价过期",unavailable:"原生行情不可用"};
  $("market").textContent=state.online?marketText[s.market?.state]||"等待原生行情":"页面连接中断";
  $("market").className="tag"+(state.online&&s.fresh?" healthy":" warning");
  $("updated").textContent=s.market?.quoteTime?`${s.fresh?"报价":"上次报价"} ${time(s.market.quoteTime)} · 北京时间`:"尚无原生报价";
  $("equity").textContent=amount(s.equity);money("floating",s.floating);money("realized",s.realized);$("risk").textContent=amount(s.balance*s.config.riskPerTrade);
  $("price").textContent=fmt(s.price,6);$("decision").textContent=s.decision.reason;$("decision-code").textContent=codes[s.decision.code]||s.decision.code;
  if(reversal)$("reversal-indicators").textContent=s.fresh&&s.analysis?.closedAt?"已收盘 4H · RSI "+fmt(s.analysis.rsi)+" · ADX "+fmt(s.analysis.adx):"";
  const next=s.nextEntry;
  $("upper").textContent=next?.direction==="short"?"方向关闭":fmt(reversal?next?.lower:next?.upper,6);
  $("lower").textContent=next?.direction==="long"?"方向关闭":fmt(reversal?next?.upper:next?.lower,6);
  $("next").textContent=next?new Date(next.closesAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,hour:"2-digit",minute:"2-digit"}):"—";
  const p=s.position;$("position-state").textContent=p?(p.side==="long"?"LONG · 多仓":"SHORT · 空头持仓"):"FLAT · 当前空仓";$("side").textContent=p?(p.side==="long"?"LONG":"SHORT"):"FLAT";
  details("position",p?[["方向",p.side==="long"?"做多":"做空"],["数量",fmt(p.qty,6)+" "+s.symbol],["实际开仓价",fmt(p.entry,6)],["当前保护止损",fmt(p.stop,6)],["初始止损",fmt(p.initialStop,6)],["本轮计划风险",fmt(p.budget)+" USDT"],["实际价格与成本风险",fmt(p.actualRisk)+" USDT"],["开仓时间",time(p.openedAt)]]:[["仓位","当前空仓"],["补仓","本策略不补仓"]]);
  $("pending").textContent=s.pending?"当前委托："+(s.pending.kind==="open"?"开仓":"退出")+" · "+s.pending.status+"；等待新盘口确认":"当前无待成交委托";
  if(reversal&&p){
   const extra=node("section");
   extra.append(node("span","目标价 / 计划净 R"),node("strong",fmt(p.target,6)+" / "+fmt(p.plannedNetR)+"R"));
   $("position").append(extra);
  }
  const c=s.config;
  const summary=[["生效范围",s.activeConfig?"下一轮":"下次开仓"],["每笔计划风险",percent(c.riskPerTrade)],["模拟杠杆",(c.leverage??1)+"x"],["方向",direction[c.direction]]];
  details("config-summary",[...summary,...(reversal?[
   ["布林带",c.bandBars+" 根 · "+c.bandWidth+" 倍标准差"],["ADX 上限",fmt(c.maxAdx)],["最低净收益风险比",fmt(c.minNetR)+"R"],["最长持仓",c.maxHoldBars*4+" 小时"]
  ]:[["入场 / 退出通道",c.entryBars+" / "+c.exitBars+" 根"],["初始止损",c.stopAtr+" × ATR"+c.atrPeriod]])]);
  const cycleDiff=s.activeConfig?differences(s.activeConfig,s.config):[];
  $("config-state").textContent=state.dirty?"有未保存草稿，启动前须保存或放弃。":cycleDiff.length?"本轮 → 下一轮："+cycleDiff.join("、"):"参数已保存。";
  $("start").disabled=state.busy||!state.online||state.dirty||s.running||s.riskLock||!!s.pending;
  $("start").hidden=s.running;$("pause").hidden=!s.running;
  $("pause").disabled=state.busy||!state.online||!s.running;$("close").disabled=state.busy||!state.online||!p||!!s.pending;
  $("edit").disabled=$("quick-edit").disabled=state.busy||!state.online;
  $("exit-actions").hidden=!p;
  $("control-note").textContent=state.busy?"正在处理，请稍候…":state.dirty?"先保存参数，再检查启动。":s.riskLock?"风险锁定，不能启动。":s.pending?"委托尚未结束，请等待确认。":s.running?"监控运行中，等待新的有效 4H 信号。":"检查原生行情、交易规格与风险状态后启动。";
  if(!embedded){
   const trades=$("trades");trades.replaceChildren();for(const t of s.history){const tr=node("tr");const entries=[time(t.time),t.side==="long"?"多 LONG":"空 SHORT",fmt(t.entryPrice,6)+" → "+fmt(t.exitPrice,6),fmt(t.netPnl)+" USDT",reasons[t.reason]||t.reason];entries.forEach((v,i)=>{const td=node("td",v,i===3?(t.netPnl>0?"positive":t.netPnl<0?"negative":""):"");td.dataset.label=["时间","方向","开仓 → 平仓","净收益","退出原因"][i];tr.append(td);});trades.append(tr);}
   if(!s.history.length){const tr=node("tr"),td=node("td","暂无已结算模拟交易","empty-cell");td.colSpan=5;tr.append(td);trades.append(tr);}
  }
  if($("parameters").open){
   if(state.hash!==s.configHash){$("config-error").textContent="已保存参数发生变化。草稿已保留，请关闭编辑后重新核对。";$("save").disabled=$("save-start").disabled=true;}
  }
 }
 async function load(){
  if(disposed)return;
  const ticket=++state.ticket;
  try{const a=await api("accounts");if(ticket!==state.ticket)return;state.accounts=a.accounts;state.defaults=a.defaults;
   if(!embedded&&(!state.id||!a.accounts.some(v=>v.id===state.id&&v.strategyType==="turtle_4h_v1")))state.id=a.accounts.find(v=>v.strategyType==="turtle_4h_v1")?.id||"";
   const data=state.id?await api("status?id="+encodeURIComponent(state.id)):null;if(ticket!==state.ticket)return;state.data=data?.snapshot||null;state.online=true;state.loaded=true;render();
  }catch(e){if(ticket!==state.ticket)return;state.online=false;if(state.data)state.data={...state.data,fresh:false,price:null,nextEntry:null,floating:state.data.position?null:0,equity:state.data.position?null:state.data.equity,decision:{code:"MARKET_UNAVAILABLE",reason:e.message}};msg(e.message);render();}
 }
 async function run(fn,errorId){if(state.busy||disposed)return;state.ticket++;state.busy=true;render();try{await fn();}catch(e){if(e.snapshot?.id===state.id)state.data=e.snapshot;if(errorId)$(errorId).textContent=e.message;else msg(e.message);}finally{state.busy=false;if(!disposed)render();}}
 function edit(){if(!state.data)return;state.hash=state.data.configHash;state.editBase=state.data.config;setFields(state.data.config);$("config-error").textContent="";$("config-progress").textContent="";$("config-title").textContent=state.data.name;$("config-note").textContent=state.data.activeConfig?"当前仓位或委托使用锁定参数。本次保存从下一轮生效。":"保存参数后，下次开仓使用新设置。";$("parameters").showModal();}
 function cancelEdit(){if(state.busy||state.dirty&&!confirm("放弃本次尚未保存的参数修改？"))return;state.dirty=false;state.editBase=null;$("parameters").close();render();}
 $("edit").onclick=$("quick-edit").onclick=edit;$("cancel-edit").onclick=cancelEdit;$("parameters").addEventListener("cancel",e=>{e.preventDefault();cancelEdit();});
 form.oninput=()=>{$("config-error").textContent="";render();};
 async function saveConfig(input){
  const busyErrors=["正在更新账户，请稍后重试","账户操作繁忙"];
  const deadline=performance.now()+16000;
  for(;;){
   try{return await api("config",input);}
   catch(error){
    if(!busyErrors.includes(error.message))throw error;
    if(performance.now()>=deadline)throw Error("行情同步仍在进行，修改已保留。请再次点击「保存参数」。");
    $("config-progress").textContent="正在等待本轮行情同步结束，随后自动保存…";
    await new Promise(resolve=>setTimeout(resolve,500));
    if(disposed)throw error;
   }
  }
 }
 form.onsubmit=async e=>{
  e.preventDefault();
  if($("save").disabled||!form.reportValidity())return;
  const input={id:state.id,config:values(),expectedHash:state.hash};
  const andCheck=e.submitter?.id==="save-start";
  let saved=false;
  $("config-error").textContent="";
  $("config-progress").textContent="正在保存参数…";
  await run(async()=>{
   const r=await saveConfig(input);
   state.dirty=false;state.editBase=null;$("parameters").close();
   msg(r.message);await load();saved=true;
  },"config-error");
  $("config-progress").textContent="";
  if(saved&&andCheck&&!$("start").disabled){if(embedded)startDirect();else checkStart();}
 };
 $("reset").onclick=()=>{setFields(state.defaults);render();};
 async function openCreate(){
  if(state.busy||disposed||$("create").open)return;
  $("create-error").textContent="";
  $("create").showModal();
 }
 for(const b of root.querySelectorAll("[data-create]"))b.onclick=openCreate;
 $("cancel-create").onclick=()=>{if(!state.busy)$("create").close();};
 $("create-form").onsubmit=e=>{e.preventDefault();if(state.busy||!e.currentTarget.reportValidity())return;const f=e.currentTarget;run(async()=>{const r=await api("accounts",{name:f.elements.name.value,symbol:f.elements.symbol.value,initialEquity:Number(f.elements.initialEquity.value),config:state.defaults});state.id=r.id;state.dirty=false;if(!embedded)rememberAccount();$("create").close();msg(r.message);await load();onCreated?.(r.id);},"create-error");};
 function checkStart(){
  const open=$("confirm").open;
  state.confirmAllowed=false;
  $("start-error").textContent="";
  return run(async()=>{
   const result=await api("preflight",{id:state.id});
   state.data=result.snapshot;
   const check=result.preflight;
   state.confirmHash=check.configHash;
   state.confirmAllowed=check.allowed;
   details("preflight",[["合约",state.data.symbol+"USDT · Binance 永续"],["模式","Paper 模拟"],["行情核对时间",time(check.checkedAt)],["启动检查",check.allowed?"通过":"存在阻断"]]);
   list("start-blockers",check.blockers);
   $("start-summary").textContent=state.data.name+" · "+percent(state.data.config.riskPerTrade)+" 单笔计划风险 · "+(state.data.config.leverage??1)+"x";
   if(!open)$("confirm").showModal();
  },open?"start-error":null);
 }
 $("start").onclick=checkStart;
 $("recheck-start").onclick=checkStart;
 $("confirm-start").onclick=()=>run(async()=>{const r=await api("control",{id:state.id,action:"start",confirm:true,expectedHash:state.confirmHash});$("confirm").close();msg(r.message);await load();},"start-error");
 $("cancel-start").onclick=()=>{if(!state.busy)$("confirm").close();};
 for(const id of ["confirm","create"])$(id).addEventListener("cancel",e=>{if(state.busy)e.preventDefault();});
 $("pause").onclick=()=>run(async()=>{const r=await api("control",{id:state.id,action:"pause"});msg(r.message);await load();});
 function startDirect(){
  if(!state.data||$("start").disabled)return;
  const {id,configHash}=state.data;
  return run(async()=>{
   msg("正在检查原生行情并启动模拟…");
   try{
    const result=await api("control",{id,action:"start",confirm:true,expectedHash:configHash});
    if(result.snapshot)state.data=result.snapshot;
    msg(result.message);
   }catch(error){
    msg("启动未完成："+error.message);
   }
   await load();
  });
 }
 $("close").onclick=()=>{const s=state.data;if(!s?.position||!confirm("平掉 "+s.name+" 的模拟仓位并暂停新开仓？"))return;run(async()=>{const r=await api("control",{id:s.id,action:"close",confirm:true,positionId:s.position.id});msg(r.message);await load();});};
 if(!embedded){
 $("refresh").onclick=()=>{if(!state.busy)load();};$("search").oninput=rail;
 for(const button of root.querySelectorAll("[data-filter]"))button.onclick=()=>{
  state.filter=button.dataset.filter;
  for(const other of root.querySelectorAll("[data-filter]"))other.setAttribute("aria-pressed",String(other===button));
  rail();
 };
 const mobile=matchMedia("(max-width:760px)");
 $("toggle").onclick=()=>{
  if(mobile.matches){
   const open=document.body.classList.toggle("open");
   $("backdrop").hidden=!open;$("toggle").setAttribute("aria-expanded",String(open));
   if(open)$("rail").querySelector('[aria-pressed="true"]').focus({preventScroll:true});
  }else{
   const collapsed=document.body.classList.toggle("collapsed");
   $("toggle").setAttribute("aria-expanded",String(!collapsed));
  }
 };
 $("backdrop").onclick=()=>{closeRail();$("toggle").focus();};
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&document.body.classList.contains("open")){closeRail();$("toggle").focus();}});
 mobile.addEventListener("change",closeRail);
 closeRail();
 window.addEventListener("beforeunload",e=>{if(state.dirty){e.preventDefault();e.returnValue="";}});
 }
 function closeRail(){
  if(embedded)return;
  const mobile=matchMedia("(max-width:760px)");
  document.body.classList.remove("open");$("backdrop").hidden=true;
  $("toggle").setAttribute("aria-expanded",String(!mobile.matches&&!document.body.classList.contains("collapsed")));
 }
 load();
 const timer=setInterval(()=>{if(!state.busy&&document.visibilityState==="visible")load();},10000);
 return {
  edit,openCreate,start:startDirect,pause:()=>$("pause").click(),
  canLeave:()=>!state.busy&&(!state.dirty||confirm("放弃尚未保存的策略参数？")),
  refresh:()=>{if(!state.busy)load();},
  dispose(){disposed=true;state.ticket++;clearInterval(timer);for(const dialog of root.querySelectorAll("dialog[open]"))dialog.close();}
 };
 }
 window.JustTurtleDesk={mount};
 if(document.getElementById("config-form")&&document.getElementById("rail"))mount(document);
})();
