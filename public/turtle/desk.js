(function(){
 "use strict";
 const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text??"";if(cls)e.className=cls;return e;};
 const keys=["entryBars","exitBars","atrPeriod","stopAtr","riskPerTrade","leverage","direction"],form=$("config-form");
 const state={id:new URLSearchParams(location.search).get("account")||"",accounts:[],defaults:null,data:null,busy:false,dirty:false,hash:null,confirmHash:null,confirmAllowed:false,online:false,ticket:0};
 const fmt=(x,n=2)=>x==null||!Number.isFinite(Number(x))?"—":Number(x).toLocaleString("zh-CN",{maximumFractionDigits:n}),time=x=>x?new Date(x).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—",percent=x=>fmt(x*100)+"%";
 const codes={MONITOR_STOPPED:"未启动",WAIT_BREAKOUT:"等待突破",BREAKOUT:"突破信号",ORDER_SUBMITTED:"委托已提交",WAIT_NEW_QUOTE:"等待新报价",POSITION_MANAGED:"持仓保护中",ORDER_FILLED:"已成交",MARKET_UNAVAILABLE:"行情阻断",RISK_BLOCK:"风险阻断",PORTFOLIO_BLOCK:"组合风险阻断",DAILY_LOSS_BLOCK:"日亏损限制",ENTRY_CANCELLED:"开仓已取消",SIZE_BLOCK:"规格阻断"};
 const reasons={hard_sl:"保护止损",channel_exit:"通道退出",manual_close:"手动退出"};
 async function api(route,body){const r=await fetch("/api/v4/turtle/"+route,{credentials:"same-origin",cache:"no-store",...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});if(r.status===401)throw Error("登录已过期，请重新登录");const v=await r.json();if(!r.ok||!v.ok)throw Error(v.error||"请求失败");return v;}
 function msg(s){$("message").textContent=s;$("message").hidden=!s;}
 function money(id,value){$(id).textContent=fmt(value)+" USDT";$(id).className=value>0?"positive":value<0?"negative":"";}
 function values(){const c={};for(const k of keys)c[k]=k==="direction"?form.elements[k].value:Number(form.elements[k].value);c.riskPerTrade/=100;return c;}
 function setFields(c){for(const k of keys)form.elements[k].value=k==="riskPerTrade"?Number((c[k]*100).toFixed(6)):c[k];preview();}
 function preview(){const c=values();$("preview").textContent="草稿 · 每轮按已结算资金计算 "+percent(c.riskPerTrade)+" 风险；入场 "+c.entryBars+" 根，退出 "+c.exitBars+" 根，止损 "+fmt(c.stopAtr)+" ATR。不做亏损补仓。";}
 function details(target,entries){const box=$(target);box.replaceChildren();for(const [label,value] of entries){const section=node("section");section.append(node("span",label),node("strong",value));box.append(section);}}
 function rail(){const term=$("search").value.trim().toLowerCase(),box=$("accounts");box.replaceChildren();for(const a of state.accounts.filter(a=>[a.name,a.symbol,a.strategyType==="turtle_4h_v1"?"海龟趋势4H":a.strategyType].join(" ").toLowerCase().includes(term))){
  const b=node("button",null,"account"+(a.id===state.id?" selected":""));b.type="button";b.title=a.name;b.append(node("strong",a.name),node("span",a.symbol+"/"+a.quoteAsset+" · "+(a.strategyType==="turtle_4h_v1"?"海龟趋势 4H":"已有账户")),node("span",(a.paper?"Paper":"原 Live")+" · "+(a.running?"运行中":"已暂停")));b.onclick=()=>select(a);box.append(b);
 }}
 async function select(a){if(state.busy)return;if(state.dirty&&!confirm("放弃尚未保存的参数并切换账户？"))return;if(a.strategyType!=="turtle_4h_v1"){location.href="/?account="+encodeURIComponent(a.id);return;}
  state.ticket++;state.id=a.id;state.data=null;state.dirty=false;state.hash=null;document.body.classList.remove("open");$("backdrop").hidden=true;history.replaceState(null,"","?account="+encodeURIComponent(a.id));await load();
 }
 function render(){
  for(const e of document.querySelectorAll("#config-form input,#config-form select,#config-form button,#create-form input,#create-form select,#create-form button"))e.disabled=state.busy;
  $("confirm-start").disabled=state.busy||!state.confirmAllowed||state.confirmHash!==state.data?.configHash;
  if($("confirm").open&&state.confirmHash!==state.data?.configHash)$("start-error").textContent="已保存参数发生变化，请取消并重新检查后确认。";
  const s=state.data;$("empty").hidden=!!s;$("desk").hidden=!s;rail();if(!s)return;
  $("title").textContent=s.name;$("instrument").textContent="Binance USD-M 永续 · "+s.symbol+" / USDT · 海龟趋势 4H";
  $("run").textContent=s.running?"RUNNING · 运行中":"PAUSED · 已暂停";$("run").className="tag"+(s.running?" healthy":"");
  $("market").textContent=state.online&&s.fresh?"原生行情新鲜":"原生行情待恢复";$("market").className="tag"+(state.online&&s.fresh?" healthy":" warning");
  $("updated").textContent="评估 "+time(s.updatedAt)+" · 北京时间";
  $("equity").textContent=fmt(s.equity)+" USDT";money("floating",s.floating);money("realized",s.realized);$("risk").textContent=fmt(s.balance*s.config.riskPerTrade)+" USDT";
  $("price").textContent=fmt(s.price,6);$("decision").textContent=s.decision.reason;$("decision-code").textContent=codes[s.decision.code]||s.decision.code;
  $("upper").textContent=fmt(s.analysis?.upper,6);$("lower").textContent=fmt(s.analysis?.lower,6);$("next").textContent=s.analysis?.closedAt?new Date(s.analysis.closedAt+4*3600000).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})+" 北京时间":"等待有效 K 线";
  const p=s.position;$("position-state").textContent=p?(p.side==="long"?"LONG · 多仓":"SHORT · 空头持仓"):"FLAT · 当前空仓";$("side").textContent=p?(p.side==="long"?"LONG":"SHORT"):"FLAT";
  details("position",p?[["方向",p.side==="long"?"做多":"做空"],["数量",fmt(p.qty,6)+" "+s.symbol],["实际开仓价",fmt(p.entry,6)],["当前保护止损",fmt(p.stop,6)],["初始止损",fmt(p.initialStop,6)],["本轮计划风险",fmt(p.budget)+" USDT"],["实际价格与成本风险",fmt(p.actualRisk)+" USDT"],["开仓时间",time(p.openedAt)]]:[["仓位","当前空仓"],["补仓","本策略不补仓"]]);
  $("pending").textContent=s.pending?"当前委托："+(s.pending.kind==="open"?"开仓":"退出")+" · "+s.pending.status+"；等待新盘口确认":"当前无待成交委托";
  const c=s.activeConfig||s.config;details("config-summary",[["当前参数来源",s.activeConfig?"本轮锁定快照":"下一轮已保存"],["每笔计划风险",percent(c.riskPerTrade)],["入场 / 退出通道",c.entryBars+" / "+c.exitBars+" 根"],["初始止损",c.stopAtr+" × ATR"+c.atrPeriod],["模拟杠杆",c.leverage+"x"],["方向",c.direction==="both"?"双向":c.direction==="long"?"仅做多":"仅做空"]]);
  $("config-state").textContent=state.dirty?"有未保存草稿，启动前须保存或放弃。":s.configDiffers?"下一轮参数已更新；本轮持仓与委托不受修改影响。":"参数已保存。";
  $("start").disabled=state.busy||!state.online||state.dirty||s.running||s.riskLock||!!s.pending;
  $("pause").disabled=state.busy||!state.online||!s.running;$("close").disabled=state.busy||!state.online||!s.fresh||!p||!!s.pending;$("edit").disabled=state.busy;
  $("control-note").textContent=state.dirty?"先保存参数，再检查启动。":s.riskLock?"风险锁定，不能启动。":s.pending?"委托尚未结束，请等待确认。":s.running?"监控运行中；只有新信号通过全部检查才提交模拟委托。":"启动前将重新核对原生行情、交易规格与风险状态。";
  const trades=$("trades");trades.replaceChildren();for(const t of s.history){const tr=node("tr");const entries=[time(t.time),t.side==="long"?"多 LONG":"空 SHORT",fmt(t.entryPrice,6)+" → "+fmt(t.exitPrice,6),fmt(t.netPnl)+" USDT",reasons[t.reason]||t.reason];entries.forEach((v,i)=>{const td=node("td",v,i===3?(t.netPnl>0?"positive":t.netPnl<0?"negative":""):"");td.dataset.label=["时间","方向","开仓 → 平仓","净收益","退出原因"][i];tr.append(td);});trades.append(tr);}
  if(!s.history.length){const tr=node("tr"),td=node("td","暂无已结算模拟交易","empty-cell");td.colSpan=5;tr.append(td);trades.append(tr);}
  if(!state.dirty&&!$("parameters").open)state.hash=s.configHash;
 }
 async function load(){
  const ticket=++state.ticket;
  try{const a=await api("accounts");if(ticket!==state.ticket)return;state.accounts=a.accounts;state.defaults=a.defaults;
   if(!state.id||!a.accounts.some(v=>v.id===state.id&&v.strategyType==="turtle_4h_v1"))state.id=a.accounts.find(v=>v.strategyType==="turtle_4h_v1")?.id||"";
   const data=state.id?await api("status?id="+encodeURIComponent(state.id)):null;if(ticket!==state.ticket)return;state.data=data?.snapshot||null;state.online=true;render();
  }catch(e){if(ticket!==state.ticket)return;state.online=false;if(state.data)state.data={...state.data,fresh:false,price:null,decision:{code:"MARKET_UNAVAILABLE",reason:e.message}};msg(e.message);render();}
 }
 async function run(fn,errorId){if(state.busy)return;state.busy=true;render();try{await fn();}catch(e){if(errorId)$(errorId).textContent=e.message;else msg(e.message);}finally{state.busy=false;render();}}
 function edit(){if(!state.data)return;state.hash=state.data.configHash;state.dirty=false;setFields(state.data.config);$("config-error").textContent="";$("config-note").textContent=state.data.activeConfig?"已有持仓或待成交委托：编辑仅对下一轮生效，当前轮次仍使用锁定快照。":"保存只更新本账户参数，不会自动启动。";$("parameters").showModal();}
 function cancelEdit(){if(state.dirty&&!confirm("放弃本次尚未保存的参数修改？"))return;state.dirty=false;$("parameters").close();render();}
 $("edit").onclick=edit;$("cancel-edit").onclick=cancelEdit;$("parameters").addEventListener("cancel",e=>{e.preventDefault();cancelEdit();});
 form.oninput=()=>{state.dirty=true;preview();render();};
 form.onsubmit=e=>{e.preventDefault();if(state.busy||!form.reportValidity())return;const c=values();if(c.exitBars>=c.entryBars){$("config-error").textContent="退出通道必须短于入场通道。";return;}run(async()=>{const r=await api("config",{id:state.id,config:c,expectedHash:state.hash});state.dirty=false;$("parameters").close();msg(r.message);await load();},"config-error");};
 $("reset").onclick=()=>{setFields(state.defaults);state.dirty=true;render();};
 for(const b of document.querySelectorAll("[data-create]"))b.onclick=()=>{if(state.busy)return;$("create-error").textContent="";$("create").showModal();};
 $("cancel-create").onclick=()=>{if(!state.busy)$("create").close();};
 $("create-form").onsubmit=e=>{e.preventDefault();if(state.busy)return;const f=e.currentTarget;run(async()=>{const r=await api("accounts",{name:f.elements.name.value,symbol:f.elements.symbol.value,initialEquity:Number(f.elements.initialEquity.value),config:state.defaults});state.id=r.id;state.dirty=false;history.replaceState(null,"","?account="+encodeURIComponent(r.id));$("create").close();msg(r.message);await load();},"create-error");};
 $("start").onclick=()=>run(async()=>{const r=await api("preflight",{id:state.id});state.data=r.snapshot;const p=r.preflight;state.confirmHash=p.configHash;state.confirmAllowed=p.allowed;details("preflight",[["行情来源","Binance USDT 永续原生"],["模式","Paper · 无真实交易权限"],["行情核对时间",time(p.checkedAt)],["启动检查",p.allowed?"通过":p.blockers.join("；")]]);$("start-summary").textContent=state.data.name+" · "+percent(state.data.config.riskPerTrade)+" 单笔风险 · "+state.data.config.leverage+"x";$("start-error").textContent="";$("confirm").showModal();});
 $("confirm-start").onclick=()=>run(async()=>{await api("control",{id:state.id,action:"start",confirm:true,expectedHash:state.confirmHash});$("confirm").close();msg("已启动当前模拟账户；等待新的已收盘突破。");await load();},"start-error");
 $("cancel-start").onclick=()=>{if(!state.busy)$("confirm").close();};
 $("pause").onclick=()=>run(async()=>{const r=await api("control",{id:state.id,action:"pause"});msg(r.message);await load();});
 $("close").onclick=()=>{if(!confirm("仅平掉 "+state.data.name+" 的模拟仓位并暂停新开仓？"))return;run(async()=>{const r=await api("control",{id:state.id,action:"close",confirm:true});msg(r.message);await load();});};
 $("refresh").onclick=()=>{if(!state.busy)load();};$("search").oninput=rail;
 $("toggle").onclick=()=>{if(matchMedia("(max-width:760px)").matches){const open=document.body.classList.toggle("open");$("backdrop").hidden=!open;$("toggle").setAttribute("aria-expanded",String(open));}else document.body.classList.toggle("collapsed");};
 $("backdrop").onclick=()=>{document.body.classList.remove("open");$("backdrop").hidden=true;};
 window.addEventListener("beforeunload",e=>{if(state.dirty){e.preventDefault();e.returnValue="";}});
 load();setInterval(()=>{if(!state.busy&&document.visibilityState==="visible")load();},10000);
})();
