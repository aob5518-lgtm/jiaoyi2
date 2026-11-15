(function(){'use strict';
 const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
 const page=$('page-trading'),primary=el('div',null,'production-primary'),side=el('aside',null,'production-inspector'),grid=el('div',null,'production-grid');
 const price=page.querySelector('.price-panel'),controls=price.querySelector('.control-row'),execution=page.querySelector('.execution-panel'),history=page.querySelector('.history-panel');
 const controlPanel=el('article',null,'panel production-controls');controlPanel.append(el('h2','监控与操作'),controls);side.append(controlPanel);
 const close=controls.querySelector('[data-action=close]'),safety=el('details',null,'production-safety');safety.append(el('summary','手动安全退出'),close);controlPanel.append(safety);
 const summary=el('article',null,'panel production-summary'),head=el('div',null,'panel-heading'),edit=el('button','编辑','text-button');edit.type='button';head.append(el('h2','策略参数'),edit);summary.append(head);const values=el('dl'),note=el('p',null,'muted');summary.append(values,note);side.append(summary);
 primary.append(price,execution,history);grid.append(primary,side);page.append(grid);execution.open=matchMedia('(min-width:1100px)').matches;
 const layout=document.querySelector('.parameter-layout'),home=layout.parentNode,drawer=el('dialog',null,'production-parameter-drawer'),drawerHead=el('div',null,'dialog-head'),closeDrawer=el('button','关闭','icon-button'),notice=el('p',null,'config-hint');drawerHead.append(el('h2','经典策略参数'),closeDrawer);drawer.append(drawerHead,notice);document.body.append(drawer);let submitted=false;
 const dirty=()=>!$('parameterDirty').hidden;
 function restore(){home.append(layout);submitted=false;}
 function dismiss(){if(dirty()&&!confirm('有尚未保存的参数，确认返回工作台？草稿仍保留在参数页。'))return;drawer.close();restore();}
 function open(){if(drawer.open)return;notice.textContent=$('deskConfigHint').textContent;drawer.append(layout);drawer.showModal();submitted=false;}
 edit.onclick=open;closeDrawer.onclick=dismiss;drawer.addEventListener('cancel',e=>{e.preventDefault();dismiss();});drawer.addEventListener('close',()=>{if(layout.parentNode===drawer)restore();});
 for(const button of document.querySelectorAll('.price-panel [data-go=parameters]'))button.onclick=open;
 $('deskSettings').addEventListener('submit',()=>{if(drawer.open&&$('deskSettings').reportValidity())submitted=true;},true);
 function refresh(){
  const configured=$('deskSetupPrompt').hidden;values.replaceChildren();
  if(configured){for(const[key,label,suffix]of[['side','交易方向',''],['leverage','杠杆','x'],['baseAmount','首仓名义金额',''],['addAmount','每次补仓名义金额',''],['maxAdds','最多补仓',' 次'],['addTrigger','反向波动触发补仓','%'],['takeProfit','保证金毛收益止盈目标','%']]){const input=$('deskSettings').elements.namedItem(key);values.append(el('dt',label),el('dd',key==='side'?(input.value==='long'?'做多':'做空'):input.value+suffix));}}
  note.textContent=dirty()?'参数草稿尚未保存，当前持仓不按草稿执行。':configured?$('deskConfigHint').textContent:$('deskSetupPrompt').textContent;
  notice.textContent=$('deskConfigHint').textContent;
  if(drawer.open&&submitted&&!dirty()&&$('deskSaveState').textContent==='当前已保存参数'){drawer.close();restore();}
 }
 const observer=new MutationObserver(refresh);for(const id of ['deskConfigHint','deskSaveState','deskSetupPrompt','parameterDirty'])observer.observe($(id),{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});$('deskSettings').addEventListener('input',refresh);refresh();
 document.addEventListener('just-account-selected',()=>{if(drawer.open){drawer.close();restore();}});
})();
