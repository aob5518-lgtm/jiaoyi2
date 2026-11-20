(function(){
 "use strict";
 const node=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text??"";if(cls)n.className=cls;return n;};
 const fmt=(n,d=2)=>Number.isFinite(n)?n.toLocaleString("zh-CN",{maximumFractionDigits:d}):"—";
 const date=t=>new Date(t).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
 const result={ENTRY_AND_EXIT_ZONE:"开仓和平仓均落在红框范围",ENTRY_ONLY_EXIT_DIFFERS:"开仓落在红框内，退出与标注不同",
  SIGNAL_ONLY_NOT_EXECUTED:"有信号落在红框内，未形成对应成交",NO_MATCH:"没有匹配到该红框信号"};
 function mount(parent){
  const panel=node("details","","panel swing-review"),summary=node("summary","截图对照回放 · 已见历史研究");
  panel.append(summary);
  const data=window.JustChartSwingSample;
  if(!data){panel.append(node("p","回放资料加载失败，可刷新重试；模拟监控不受影响。","muted"));parent.after(panel);return;}
  panel.append(node("p","46 张截图整理为 39 组目标，7 张重复。红框为近似日期与价格范围，不是精确成交点。此处为独立历史研究，不计入你的模拟账户收益。","muted"));
  const stats=node("div","","swing-stats");
  for(const [label,value] of [["开仓区间匹配",data.counts.entryMatched+"/39"],["完整开平匹配",data.counts.pairsMatched+"/39"],
   ["红框外额外交易",data.counts.extraTrades+" 笔"],["研究净收益",fmt(data.baseline.netPnl)+" U"],
   ["更高成本净收益",fmt(data.stress.netPnl)+" U"],["更早历史已结算",fmt(data.earlier.netPnl)+" U"]]){
   const item=node("section");item.append(node("span",label),node("strong",value));stats.append(item);
  }
  panel.append(stats,node("p","收益尚未验证。标注区间的正收益未在更早历史中延续，不能视为稳定盈利策略。"+(data.earlier.openAtEnd?"更早区间结束时仍有持仓，含浮动损益的期末权益为 "+fmt(data.earlier.endingEquity)+" U。":""),"warning"));
  const tools=node("div","","row wrap"),select=node("select"),previous=node("button","上一张"),next=node("button","下一张");
  previous.type=next.type="button";select.setAttribute("aria-label","选择截图对照");
  data.targets.forEach((target,i)=>{const option=node("option","图 "+target.image+" · "+(target.side==="long"?"做多":"做空")+" · "+
   (target.entryZone.low+"–"+target.entryZone.high)+" → "+target.exitZone.low+"–"+target.exitZone.high);option.value=i;select.append(option);});
  tools.append(previous,select,next);panel.append(tools);
  const status=node("p","","decision"),ranges=node("div","","swing-ranges");
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox","0 0 900 300");svg.setAttribute("role","img");svg.setAttribute("aria-label","历史走势、红框区间和实际研究成交位置");
  const axis=node("div","","row swing-axis"),start=node("span"),end=node("span");axis.append(start,end);
  const legend=node("p","红色区域 = 你的开仓范围　橙色区域 = 你的平仓范围　青色圆点 = 研究开仓　白色叉号 = 研究退出","muted");
  const trades=node("div","","swing-review-trades"),meta=node("details"),metatitle=node("summary","数据来源与模型假设");
  meta.append(metatitle,node("p","Binance USD-M 永续 ETHUSDT，1 小时收盘。假设每边手续费 5bp、滑点 5bp、价差合计 2bp；压力组滑点 10bp、价差 4bp；包括原生历史资金费。小时开盘代理成交、同根止损优先，未重建历史盘口、排队和强平。","muted"),
   node("p","修订 "+data.revision+" · 配置 "+data.configHash+" · 数据 "+data.dataHash,"muted"));
  panel.append(status,ranges,svg,axis,legend,trades,meta);
  const shape=(name,attrs,title)=>{const e=document.createElementNS(svg.namespaceURI,name);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(title){const t=document.createElementNS(svg.namespaceURI,"title");t.textContent=title;e.append(t);}svg.append(e);return e;};
  function render(){
   const i=Number(select.value),target=data.targets[i],a=target.entryZone,z=target.exitZone;
   previous.disabled=i===0;next.disabled=i===data.targets.length-1;
   status.textContent="图 "+target.image+" · "+result[target.outcome];
   ranges.replaceChildren(node("p","标注开仓 "+date(a.from)+" ～ "+date(a.to-1)+" · "+fmt(a.low)+"–"+fmt(a.high)+" USDT"),
    node("p","标注平仓 "+date(z.from)+" ～ "+date(z.to-1)+" · "+fmt(z.low)+"–"+fmt(z.high)+" USDT"));
   const from=Math.min(a.from,z.from)-12*3600000,to=Math.max(a.to,z.to)+12*3600000;
   const rows=data.candles.filter(b=>b[0]>=from&&b[0]<to),matches=data.trades.filter(t=>t.entryAt>=from&&t.entryAt<to);
   svg.replaceChildren();
   if(rows.length){
    const low=Math.min(a.low,z.low,...rows.map(b=>b[3]))*.998,high=Math.max(a.high,z.high,...rows.map(b=>b[2]))*1.002;
    const x=t=>10+(t-from)/(to-from)*880,y=p=>290-(p-low)/(high-low)*280;
    for(const [zone,color] of [[a,"#f17e91"],[z,"#e5b56f"]])shape("rect",{x:x(zone.from),y:y(zone.high),width:x(zone.to)-x(zone.from),height:y(zone.low)-y(zone.high),fill:color,"fill-opacity":.12,stroke:color},fmt(zone.low)+"–"+fmt(zone.high));
    shape("path",{d:rows.map((b,j)=>(j?"L":"M")+x(b[0])+","+y(b[4])).join(" "),fill:"none",stroke:"#91a3b9","stroke-width":2});
    matches.forEach(t=>{
     shape("circle",{cx:x(t.entryAt),cy:y(t.entry),r:4,fill:"#57c9df"},date(t.entryAt)+" "+(t.side==="long"?"开多 ":"开空 ")+fmt(t.entry));
     if(t.exitAt<to){const xx=x(t.exitAt),yy=y(t.exit);shape("path",{d:`M${xx-4},${yy-4}L${xx+4},${yy+4}M${xx+4},${yy-4}L${xx-4},${yy+4}`,stroke:"#e8eef6","stroke-width":2},date(t.exitAt)+" 退出 "+fmt(t.exit));}
    });
   }
   start.textContent=date(from);end.textContent=date(to)+" · 北京时间";
   trades.replaceChildren(...matches.map(t=>node("p",(t.side==="long"?"多":"空")+" · "+date(t.entryAt)+" "+fmt(t.entry)+" → "+date(t.exitAt)+" "+fmt(t.exit)+" · 净收益 "+fmt(t.netPnl)+" U · "+fmt(t.r)+"R")));
   if(!matches.length)trades.append(node("p","该时间范围内没有研究成交。"));
  }
  select.onchange=render;previous.onclick=()=>{select.value=Number(select.value)-1;render();};next.onclick=()=>{select.value=Number(select.value)+1;render();};
  parent.after(panel);render();
 }
 window.JustChartSwingReview={mount};
})();
