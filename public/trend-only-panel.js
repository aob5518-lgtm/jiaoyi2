(() => {
  'use strict';
  const root = document.createElement('section');
  root.style.cssText = 'max-width:1100px;margin:24px auto;padding:20px;background:#102030;color:#e6edf3;border:1px solid #36506a;border-radius:14px;font:14px/1.7 system-ui';
  const h = document.createElement('h2'); h.textContent = 'Trend Only V1 · 推荐'; root.append(h);
  const description = document.createElement('p'); description.textContent = '只做趋势 · 单仓 · 无 DCA · 默认 10 倍 · UTC 周末禁开。停止后仍管理已有仓位。'; root.append(description);
  const summary = document.createElement('pre'); summary.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:inherit'; root.append(summary);
  const reasons = document.createElement('ul'); root.append(reasons);
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px'; root.append(actions);
  const details = document.createElement('details'); details.innerHTML = '<summary>趋势参数配置（首次启用默认 Paper）</summary>'; root.append(details);
  const form = document.createElement('div'); form.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:15px 0'; details.append(form);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); root.append(status);
  document.body.append(root);
  const labels = { enabled:'启用趋势策略',leverage:'杠杆（最高 10）',allowWeekendOpen:'允许周末开新仓',weekendMode:'周末保护模式',weekendExitHourUTC:'周五保护开始（UTC 小时）',riskPerTrade:'单笔风险比例（0.01=1%）',maxPositionRatio:'最大保证金比例',maxDailyLossRatio:'日亏损限制比例',maxConsecutiveLosses:'连续亏损次数',cooldownHoursAfterLossLimit:'亏损暂停小时',atrPeriod:'ATR 周期',adxPeriod:'ADX 周期',chopPeriod:'CHOP 周期',emaFast:'EMA 快线',emaMid:'EMA 中线',emaSlow:'EMA 慢线',minAdxToTrade:'最低 ADX',maxChopToTrade:'最高 CHOP',stopLossAtrMultiplier:'初始止损 ATR 倍数',trailingAtrMultiplier:'移动止盈 ATR 倍数',breakEvenAtR:'保本启动 R',trailStartAtR:'移动止盈启动 R',timeStopBars:'时间止损 K 线数',minProfitForTimeStopR:'时间止损最低 R',breakoutLookback:'突破回看 K 线数',requireMultiTimeframeConfirm:'要求多周期确认',entryTimeframe:'入场周期',trendTimeframe:'趋势周期',higherTimeframe:'高周期' };
  let data, loadedAccount, inputs = {};
  const n = x => Number.isFinite(Number(x)) ? Number(x).toFixed(3) : '—';
  async function api(url, payload) {
    const r = await fetch(url, payload ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)} : {});
    const d = await r.json(); if (!r.ok || !d.ok) throw Error(d.error || '请求失败'); return d;
  }
  function button(text, parent, fn) {
    const b = document.createElement('button'); b.type='button'; b.textContent=text; b.style.cssText='padding:9px 14px;border-radius:8px;border:1px solid #6482a0;background:#173b51;color:white;cursor:pointer';
    b.onclick=async()=>{ b.disabled=true; try { await fn(); status.textContent='操作完成'; await refresh(); } catch(e) { status.textContent=e.message; } finally { b.disabled=false; } }; parent.append(b); return b;
  }
  button('启动趋势监控',actions,async()=>{if(!data.active) throw Error('请先保存并启用趋势配置'); await api('/api/start',{});});
  button('停止新开仓',actions,async()=>{await api('/api/stop',{});});
  const confirm = button('确认本次 Live 开仓',actions,async()=>{
    const p=data.state.preview;
    if(!p) throw Error('当前没有可确认的趋势信号');
    if(!window.confirm(`${data.accountName}：实盘${p.side==='long'?'做多':'做空'}，${p.leverage} 倍，数量 ${p.qty}，预计名义金额 ${n(p.positionValue)}，风险预算 ${n(p.riskAmount)}。确认仅对当前信号有效，继续？`)) return;
    await api('/api/trend-only/confirm',{accountId:data.accountId,signalTime:p.signal.signalTime,configHash:p.configHash,confirmLive:true});
  });
  button('平掉趋势仓位',actions,async()=>{
    if(!data.active || !data.state.position) throw Error('当前没有趋势仓位');
    if(!window.confirm(`确认平掉 ${data.accountName} 的全部趋势仓位？`)) return;
    await api('/api/trend-only/close',{accountId:data.accountId});
  });
  button('保存并启用 Trend Only V1',details,async()=>{
    const config={}; for(const [k,input] of Object.entries(inputs)) config[k]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;
    await api('/api/trend-only/config',{accountId:data.accountId,config}); loadedAccount=null;
  });
  async function refresh(){
    data=await api('/api/trend-only'); const s=data.state,p=s.position,i=s.indicators||{},sig=s.signal||{};
    const regimes={trend:'趋势行情',chop:'震荡行情',unclear:'不明确行情'}, directions={long:'做多趋势',short:'做空趋势',none:'无方向'};
    summary.textContent=`账户：${data.accountName} ｜ ${data.paper?'Paper 模拟':'Live 实盘'} ｜ ${data.active?'Trend Only V1':'未启用趋势模式'}\n市场：${regimes[sig.regime]||'等待行情'} ｜ ${directions[sig.direction]||'无方向'} ｜ 评分 ${sig.score??'—'}\n${s.weekendBlocked?'周末禁止新开仓':'当前允许交易（仍需通过趋势与风控）'}\nCHOP ${n(i.chop)} ｜ ADX ${n(i.adx)} ｜ ATR ${n(i.atr)}\n当前 R ${p?n(p.rMultiple):'—'} ｜ 止损价 ${p?n(p.currentStopLossPrice):'—'} ｜ 保本 ${p?.breakEvenActivated?'已启用':'未启用'} ｜ 移动止盈 ${p?.trailingActive?'已启用':'未启用'}\n下一步：${data.lastAction||'等待趋势'}\n订单：${s.pendingOrder?.status||'无待确认订单'}`;
    reasons.replaceChildren(); for(const text of sig.reasons||[]) { const li=document.createElement('li');li.textContent=text;reasons.append(li); }
    confirm.disabled=data.paper||!data.active||!s.preview||!!s.pendingOrder||!!p;
    if(loadedAccount!==data.accountId){ form.replaceChildren();inputs={};
      for(const [k,v] of Object.entries(data.config)){
        const label=document.createElement('label');label.textContent=labels[k]||k;label.style.cssText='display:flex;flex-direction:column;gap:4px';
        let input;
        if(k==='weekendMode'||k.endsWith('Timeframe')){
          input=document.createElement('select');const options=k==='weekendMode'?['no_new_position','force_flat_before_weekend']:['1m','5m','15m','1h','4h','1d'];
          for(const value of options){const o=document.createElement('option');o.value=value;o.textContent=value==='no_new_position'?'周末只管理持仓':value==='force_flat_before_weekend'?'周五进入平仓保护':value;input.append(o);} input.value=v;
        } else {input=document.createElement('input');input.type=typeof v==='boolean'?'checkbox':'number';if(input.type==='checkbox')input.checked=v;else{input.step='any';input.value=v;}}
        input.style.cssText='padding:7px;color:#e6edf3;background:#172d40;border:1px solid #6482a0;border-radius:5px';inputs[k]=input;label.append(input);form.append(label);
      } loadedAccount=data.accountId;
    }
  }
  refresh().catch(e=>status.textContent=e.message);
  setInterval(()=>{ if(!document.hidden) refresh().catch(e=>status.textContent=e.message); },5000);
})();
