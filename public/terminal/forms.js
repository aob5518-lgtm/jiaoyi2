(function(A){"use strict";
 // Bounds mirror backend normalize(); backend remains authoritative.
 A.compoundFields=[
  ["layerNotionalPct","每层名义仓位上限",.0001,.01,.0001,"权益比例，默认0.01=1%；不是保证金再乘杠杆"],
  ["maxAdds","最多补仓次数",0,3,1,"次，默认3；绝不翻倍"],
  ["atrPeriod","ATR周期",7,50,1,"根4H，默认14"],
  ["zoneAtr","反转区域宽度",.25,2,.05,"ATR，默认0.6"],
  ["layerSpacingAtr","层间距离",.1,1,.05,"ATR，默认0.25"],
  ["stopBufferAtr","结构止损缓冲",.25,2,.05,"ATR，默认0.5"],
  ["gradeA","A级评分门槛",82,100,1,"分，默认82"],["gradeB","B级评分门槛",74,99,1,"分，默认74，必须低于A级"],
  ["orderTtlBars","挂单有效期",1,12,1,"根4H，默认3"],["minimumNetRR","最低净收益空间",1,10,.1,"R，默认1.5"],
  ["stopSlippageBps","止损滑点假设",1,100,1,"bps，默认5；平台费用沿用后端保守估算"],
  ["fundingReserveRate","资金费预留",0,.01,.0001,"比例，默认0.0001；不是实际结算费率"],
  ["maxDailyLossRatio","日净亏损限制",.001,.02,.001,"权益比例，默认0.02"],["maxConsecutiveLosses","连续亏损限制",1,3,1,"轮，默认3"],
  ["cooldownBars","结算后冷却",1,12,1,"根4H，默认1"],
 ];
 A.field=(parent,key,title,value,bounds,description)=>{const label=A.el("label",title),input=A.el("input");input.name=key;input.value=value??"";if(bounds){input.type="number";[input.min,input.max,input.step]=bounds;}label.append(input);if(description)label.append(A.el("small",description));parent.append(label);return input;};
 A.select=(parent,key,title,value,options)=>{const label=A.el("label",title),select=A.el("select");select.name=key;for(const [v,t]of options){const e=A.el("option",t);e.value=v;select.append(e);}select.value=value;label.append(select);parent.append(label);return select;};
 A.configForm=(parent)=>{const d=A.state.data;if(!["trend_only_v3","compound_4h_v1"].includes(d.account.strategyType))return;const form=A.el("form",null,"config-form"),basic=A.el("div",null,"form-grid"),c={...d.config},locked=d.operations.configurationLocked;
  A.field(basic,"accountName","账户名称",d.account.name,null,"保存不更改密钥或历史记录");
  if(d.compound){const initial=A.field(basic,"initialEquity","模拟初始资金",c.initialEquity,[100,10000000,100],"USDC，默认10000；已有账本不可重写");initial.disabled=true;const tier=A.select(basic,"riskPerCycle","风险档位",c.riskPerCycle,[[.005,"Standard · 每轮最多0.5%"],[.0025,"Conservative · 每轮最多0.25%"]]);if(![.005,.0025].includes(c.riskPerCycle)){const opt=A.el("option","当前自定义 · "+A.fmt(c.riskPerCycle*100)+"%");opt.value=c.riskPerCycle;tier.append(opt);tier.value=c.riskPerCycle;}
   for(const f of A.compoundFields.slice(0,2))A.field(basic,f[0],f[1],c[f[0]],f.slice(2,5),f[5]+"；范围 "+f[2]+"–"+f[3]);A.select(basic,"exitVariant","止盈方式",c.exitVariant,[["PARTIAL_TRAIL","净1R / 2R分段 + 移动保护（默认）"],["FIXED_TARGET","固定净2R退出（研究对照）"],["TRAIL_ONLY","仅移动保护（研究对照）"]]);A.select(basic,"compoundMode","复利方式",c.compoundMode,[["FULL_EQUITY","全部已结算权益（默认）"],["FIXED_BASE","固定本金（亏损后按较低权益）"],["PARTIAL_PROFIT","部分已实现利润参与复利"]]);
  }else{A.field(basic,"riskPerTrade","单笔风险比例",c.riskPerTrade,[.0001,.02,.0001],"权益比例；0.01=1%，按当前账户参数载入，不自动放宽");const leverage=A.field(basic,"leverage","杠杆上限",c.leverage,[1,10,1],"最高10，不等于实际下单风险");leverage.disabled=true;}
  form.append(basic);const advanced=A.el("details"),title=A.el("summary","高级参数与风险说明"),grid=A.el("div",null,"form-grid");advanced.append(title,grid);if(d.compound){for(const f of A.compoundFields.slice(2))A.field(grid,f[0],f[1],c[f[0]],f.slice(2,5),f[5]+"；范围 "+f[2]+"–"+f[3]);advanced.append(A.el("p","移动保护使用既有1R/2R阶段及ATR/确认结构；只收紧、不放宽。当前版本不开放ROI_PERCENT或Live。","hint"));}else{for(const [key,title]of [["chopIdealMax","CHOP优质阈值"],["chopTransitionMax","CHOP过渡阈值"],["chopHardBlock","CHOP禁止阈值"],["adxTrendStart","ADX启动阈值"],["adxTrendValid","ADX有效阈值"],["adxStrong","ADX强趋势阈值"],["minimumPotentialR","最低净结构空间 R"],["maxAllowedCostR","最高成本 R"]])if(c[key]!==undefined)A.field(grid,key,title,c[key],[0,100,.01],"沿用当前已保存参数；后端normalize()决定有效范围");}
  form.append(advanced,A.el("p",locked?"本轮参数快照已锁定；请暂停新交易，待订单与持仓完全结算后，为下一轮保存参数。":"保存仅对后续新计划生效，不改变历史参数快照。","hint"));const save=A.el("button","保存参数","primary");save.type="submit";form.append(save);for(const el of form.querySelectorAll("input,select,button"))if(locked)el.disabled=true;form.oninput=()=>{A.state.dirty=true;};form.onsubmit=async event=>{event.preventDefault();if(!form.reportValidity())return;save.disabled=true;try{const values=new FormData(form),next={...c};for(const [k,v]of values)if(k!=="accountName")next[k]=typeof c[k]==="number"?Number(v):v;await A.api("/api/v4/config",{id:A.state.id,name:values.get("accountName"),config:next});A.state.dirty=false;await A.load();}catch(error){A.error(error.message);}finally{save.disabled=false;}};parent.append(form);
 };
 A.newAccount=()=>{const dialog=A.$("createAccount"),form=A.$("createForm");form.reset();dialog.showModal();};
 A.setupCreation=()=>{const form=A.$("createForm");form.onsubmit=async e=>{e.preventDefault();if(!form.reportValidity())return;const submit=form.querySelector('[type="submit"]');submit.disabled=true;try{const v=Object.fromEntries(new FormData(form));v.initialEquity=Number(v.initialEquity);const result=await A.api("/api/v4/accounts",v);A.$("createAccount").close();A.state.dirty=false;await A.selectAccount(result.id);}catch(error){A.error(error.message);}finally{submit.disabled=false;}};};
})(window.SA);
