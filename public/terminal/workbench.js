(function(A){'use strict';
 const amount=(v,unit='')=>A.value(v)===null?'暂无数据':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})+unit;
 const priceValue=v=>A.value(v)===null?'暂无数据':Math.abs(Number(v))>=.01?amount(v):Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:10});
 const quantity=v=>A.value(v)===null?'暂无数据':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:6});
 const tone=v=>A.value(v)===null?'muted':Number(v)>0?'profit':Number(v)<0?'loss':'neutral';
 const stamp=v=>v?new Date(v).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未更新';
 const badge=(text,kind='neutral')=>A.el('span',text,'status-tag '+kind);
 const title=(box,text,note,action)=>{const head=A.el('div',null,'section-head'),labels=A.el('div');labels.append(A.el('h2',text));if(note)labels.append(A.el('p',note));head.append(labels);if(action)head.append(action);box.append(head);};
 const cell=(box,label,value,cls='')=>{const c=A.el('div',null,'data-cell');c.append(A.el('span',label),A.el('strong',value,cls));box.append(c);return c;};
 const previousHeader=A.renderHeader;
 A.renderHeader=()=>{previousHeader();const d=A.state.data,r=d.h06;A.$('feedBadge').textContent=r?(r.market.fresh?'报价有效':'报价不可用'):d.overview.health.market||'报价待确认';A.$('feedBadge').className='badge '+(r?.market.fresh?'good':'caution');A.$('dataUpdated').textContent='状态更新 '+stamp(r?.market.updatedAt||d.overview.updatedAt);A.$('runBadge').classList.toggle('good',!!d.overview.health.running);if(r){A.$('modeBadge').textContent=({Paper:'模拟 · Paper',Shadow:'影子研究 · Shadow',Research:'历史研究 · Research'})[r.mode]||r.mode;A.$('runBadge').textContent=d.overview.health.running?'监控运行中':'已暂停新增';}};

 A.openParameters=()=>{
  const dialog=A.$('parameterDrawer'),box=A.$('parameterDrawerBody');box.replaceChildren();A.configForm(box);
  const form=box.querySelector('form');if(form){const submit=form.onsubmit;form.onsubmit=async e=>{if(!form.reportValidity()){e.preventDefault();return;}A.state.dirty=true;await submit(e);const message=A.$('parameterResult');if(!A.state.dirty){dialog.close();A.$('workbenchToast').textContent='参数已保存。当前订单与轮次继续使用锁定配置。';A.$('workbenchToast').hidden=false;}else{message.textContent=A.$('error').textContent||'参数尚未保存，请检查输入。';message.hidden=false;}};}
  A.$('parameterResult').hidden=true;dialog.showModal();
 };
 A.closeParameters=()=>{if(!A.guardDraft())return;A.state.dirty=false;A.$('parameterDrawer').close();};

 const previousOverview=A.renderOverview;
 A.renderOverview=()=>{
  const d=A.state.data,r=d.h06;A.$('workbenchQuickParameters').hidden=!r;A.$('page-overview').classList.toggle('h06-cockpit',!!r);A.$('recentExecutions').hidden=!r;if(!r)return previousOverview();
  const p=r.cycle,active=p?.config||r.pending?.meta?.config||r.activeConfig||r.config,next=r.config,base=p?.baseEquity??r.pending?.meta?.baseEquity??r.book.equity,quote=r.market.fresh?r.market.price:null;
  const metrics=A.$('overviewCards');metrics.replaceChildren();
  for(const[label,value,note,color]of[['账户净权益',r.equity,'已结算权益 + 本轮预计净收益',''],['本轮预计净收益',r.totalNetPnl,'含分批退出、费用及已知资金费',tone(r.totalNetPnl)],['累计已结算净收益',r.book.realizedNetPnl,'已完成轮次 · 独立账本',tone(r.book.realizedNetPnl)],['本轮投入保证金',p?.marginUsed??0,'实际已成交金额，不含待成交委托','']]){const e=A.el('div',null,'metric');e.append(A.el('span',label),A.el('strong',amount(value),'metric-number '+color),(()=>{const text=A.el('small','USDT · '+note);text.title=note;return text;})());metrics.append(e);}

  const decision=A.$('decision');decision.replaceChildren();const market=A.el('div',null,'market-heading'),pair=A.el('div',null,'market-pair'),coin=A.el('span',d.account.symbol.slice(0,1),'coin-avatar');pair.append(coin,A.el('h2',d.account.symbol+' / '+d.account.quoteAsset),badge('USD-M 永续'));market.append(pair,badge(r.market.fresh?'报价有效':'报价不可用',r.market.fresh?'good':'caution'));decision.append(market);
  const price=A.el('div',null,'market-price');price.append(A.el('strong',priceValue(quote)),A.el('span',d.account.quoteAsset));decision.append(price);
  const line=A.el('div',null,'market-reference');line.append(A.el('span','持仓均价 '+priceValue(p?.averagePrice)),A.el('span','保护止损 '+priceValue(p?.stopPrice)),A.el('span','状态更新 '+stamp(r.market.updatedAt)));decision.append(line);
  const plan=A.el('div',null,'decision-callout');plan.append(A.el('span','下一步'),A.el('strong',r.decision.reason));decision.append(plan);
  const details=A.el('details',null,'signal-details');details.append(A.el('summary','查看信号与执行依据'));const i=r.analysis?.indicators||{};A.rows(details,{'当前状态':A.phase(r.phase),'执行状态':r.decision.code,'DIF':A.fmt(i.dif),'DEA':A.fmt(i.dea),'MACD 柱值（2倍）':A.fmt(i.histogram),'最新信号收盘（UTC+8）':r.analysis?.signal?.closedTime?new Date(r.analysis.signal.closedTime).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'暂无信号','信号是否已使用':r.signalUsed?'是':'否','真实交易权限':'禁止'});decision.append(details);

  const position=A.$('position');position.replaceChildren();title(position,'当前持仓',p?'只统计实际成交数量':null,p?badge(A.direction(p.side),p.side==='long'?'good':'short'):badge('空仓'));
  if(p){const grid=A.el('div',null,'position-grid');cell(grid,'加权开仓均价',priceValue(p.averagePrice));cell(grid,'持仓数量',quantity(p.qty)+' '+d.account.symbol);cell(grid,'当前名义仓位',amount(quote===null?null:p.qty*quote,' USDT'));cell(grid,'本轮净收益',amount(r.totalNetPnl,' USDT'),tone(r.totalNetPnl));cell(grid,'保证金净 ROI',amount(r.roi,'%'),tone(r.roi));cell(grid,'当前保护止损',priceValue(p.stopPrice),'stop-value');position.append(grid);}else{const empty=A.el('div',null,'position-empty');empty.append(A.el('span','—','flat-symbol'),A.el('div'));empty.lastChild.append(A.el('strong',r.pending?'委托待确认，尚未计入持仓':'当前没有持仓'),A.el('p',r.market.fresh?'等待策略条件与执行检查通过后开仓。':'原生报价不可用，保持空仓并等待数据恢复。'));position.append(empty);}

  const orders=A.$('orderSummary');orders.replaceChildren();title(orders,'开仓与补仓计划','信号驱动 · 保证金预算与实际成交分开显示',badge(active.leverage+'x · 最多补仓 '+active.maxAdds+' 次'));
  const list=A.el('div',null,'execution-list'),head=A.el('div',null,'execution-row execution-header');for(const text of ['层级 / 触发条件','成交均价','计划保证金','实际成交','执行状态'])head.append(A.el('span',text));list.append(head);
  const percentages=[active.firstMarginPct,active.add1MarginPct,active.add2MarginPct,active.add3MarginPct];
  for(let n=0;n<4;n++){const l=p?.layers[n],enabled=n<=active.maxAdds,waiting=r.pending&&['open','add'].includes(r.pending.kind)&&r.pending.meta.layer===n,filled=(l?.filledQty||0)>0,row=A.el('div',null,'execution-row'+(filled?' executed':'')+(!enabled?' disabled-layer':'')),name=A.el('div',null,'execution-name');name.append(A.el('span','L'+n,'layer-index'),A.el('div'));name.lastChild.append(A.el('strong',n?'第 '+n+' 次补仓':'首次开仓'),A.el('small',!enabled?'超出配置上限':n?'整体亏损 + 新同向信号':'新的已收盘 MACD 信号'));row.append(name);
   const entry=p?.entries.find(v=>v.layer===n),status=!enabled?'已禁用':waiting?'待模拟执行':filled?(l.status==='FILLED'?'已成交':'部分成交 · 余量终结'):'等待信号';
   const values=[['成交均价',filled?priceValue(l.price):'信号触发后确定'],['计划保证金',amount(enabled?(l?.marginBudget??base*percentages[n]):0)+' USDT'],['实际成交',filled?quantity(l.filledQty)+' '+d.account.symbol:'尚未成交']];
   for(const[label,value]of values){const v=A.el('div',null,'execution-value');v.dataset.label=label;v.append(A.el('span',value));if(label==='实际成交'&&filled)v.append(A.el('small','保证金 '+amount(entry?.margin)+' USDT'));row.append(v);}const state=A.el('div',null,'execution-state');state.append(badge(status,waiting?'caution':filled?'good':'neutral'));row.append(state);list.append(row);
  }orders.append(list,A.el('p','未成交层级的成交价由有效信号后的模拟执行确定；此处没有预挂固定价格的限价单。','table-note'));

  const summary=A.$('cycleSummary');summary.replaceChildren();title(summary,'策略参数','当前订单 / 轮次的生效快照',A.button('编辑',A.openParameters,'text-button'));
  A.rows(summary,{'当前策略':'H06 · MACD 分层补仓','交易方向':{LONG_ONLY:'只做多',SHORT_ONLY:'只做空',BOTH:'双向（同轮不对冲）'}[active.tradeDirection],'信号周期':'1 小时 · 已收盘','杠杆':active.leverage+'x','单轮净亏损上限':amount(active.maxCycleLossPct*100)+'%','分批止盈目标':amount(active.takeProfitRoiPct)+'% 净 ROI','达到目标后平仓':amount(active.partialClosePct)+'%'});
  if(r.configuration?.different)summary.append(A.el('p','已有下一轮新配置。当前委托与持仓继续使用锁定参数。','notice warning'));
  const risk=A.el('details',null,'risk-section');const riskTitle=A.el('summary','风险预算与保护');riskTitle.append(badge(r.book.riskLock?'风控锁定':r.pending?'委托待确认':d.overview.health.error?'当前异常':'状态正常',r.book.riskLock||d.overview.health.error?'danger':r.pending?'caution':'good'));risk.append(riskTitle);risk.open=!!r.book.riskLock;
  A.rows(risk,{'本轮风险预算':amount(p?.riskBudget??base*active.maxCycleLossPct)+' USDT','剩余风险额度':p?amount(r.remainingRisk,' USDT'):'尚未建仓','累计保证金上限':amount(base*active.maxMarginPct)+' USDT','已投入保证金':amount(p?.marginUsed??0)+' USDT','当前保护止损':priceValue(p?.stopPrice),'日亏损熔断':r.day?.locked?'已触发':'未触发'});summary.append(risk);
  const tp=A.el('div',null,'target-progress'),progress=A.el('div',null,'progress-track'),fill=A.el('span');fill.style.width=(A.value(r.roi)===null?0:Math.max(0,Math.min(100,r.roi/active.takeProfitRoiPct*100)))+'%';progress.append(fill);tp.append(A.el('span',p?.partialTpDone?'已完成分批止盈，停止补仓':'分批止盈进度'),progress,A.el('small',p?(r.market.fresh?amount(r.roi)+'% / '+active.takeProfitRoiPct+'% 净 ROI':'报价过期，暂停估算进度'):'建仓后按实际投入保证金计算'));summary.append(tp);
  if(r.book.riskLock)summary.append(A.el('p',r.book.riskLockReason,'notice error'));
  const actions=A.$('primaryActions');actions.replaceChildren();const start=A.button('启动 '+r.mode+' 监控',()=>A.control('start'),'primary'),pause=A.button('暂停新开与补仓',()=>A.control('pause'));start.disabled=!!d.overview.health.running||r.book.riskLock||!!r.pending;pause.disabled=!d.overview.health.running;actions.append(start,pause,A.button('完整参数配置',A.openParameters,'quiet'));
  const management=A.$('positionManagement');management.replaceChildren();management.hidden=!p&&!r.pending;if(!management.hidden)management.append(A.el('summary','持仓明细与安全退出'),A.button('查看轮次与订单明细',()=>A.detail('H06 完整轮次与锁定配置',p||r.pending)),A.button('手动安全退出',()=>A.control('close'),'danger'));

  const recent=A.$('recentExecutions');recent.replaceChildren();title(recent,'委托与成交记录','当前账户 · 最近 5 条',A.button('全部交易',()=>A.tab('history'),'text-button'));
  const history=(r.orders||[]).slice(-5).reverse();if(!history.length)recent.append(A.el('p','暂无委托记录。等待真实策略信号，不生成演示成交。','empty'));for(const order of history){const row=A.el('div',null,'order-event'),name={open:'首次开仓',add:'信号补仓',partial:'分批止盈',exit:'退出仓位'}[order.kind]||'委托';row.append(A.el('span',stamp(order.lastFillTime||order.submittedAt)),A.el('strong',name),badge({SUBMITTED:'待模拟执行',FILLED:'全部成交',PARTIALLY_FILLED:'部分成交',PARTIALLY_FILLED_CANCELLED:'部分成交 · 余量终结',CANCELLED:'已取消',REJECTED:'已拒绝',UNKNOWN:'结果未知'}[order.status]||order.status),A.el('span',quantity(order.filledQty)+' / '+quantity(order.qty)+' '+d.account.symbol),A.button('明细',()=>A.detail('委托与成交证据',order),'text-button'));recent.append(row);}
 };
 A.$('parameterClose').onclick=A.closeParameters;A.$('parameterDrawer').addEventListener('cancel',e=>{e.preventDefault();A.closeParameters();});
 A.$('workbenchQuickParameters').onclick=A.openParameters;
})(window.SA);
