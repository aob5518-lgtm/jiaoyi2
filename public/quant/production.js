(function(){
 "use strict";
 const page=document.getElementById("page-trading");
 const price=page.querySelector(".price-panel");
 const execution=page.querySelector(".execution-panel");
 const controls=price.querySelector(".control-row");
 const element=(tag,cls,text)=>{
  const node=document.createElement(tag);
  node.className=cls;
  if(text)node.textContent=text;
  return node;
 };
 const grid=element("div","production-grid");
 const primary=element("div","production-primary");
 const side=element("aside","production-inspector");
 const safety=element("article","panel production-controls");
 const close=controls.querySelector('[data-action="close"]');
 const safetyTitle=element("h2","","持仓操作");
 safety.append(safetyTitle,close);
 // The main toolbar owns start and pause. Keep their existing handlers and state.
 controls.hidden=true;
 primary.append(price,execution);
 side.append(safety);
 grid.append(primary,side);
 page.append(grid);
 execution.open=matchMedia("(min-width:1100px)").matches;
 const positionObserver=new MutationObserver(()=>{safety.hidden=close.hidden;grid.classList.toggle("single-column",close.hidden);});
 positionObserver.observe(close,{attributes:true,attributeFilter:["hidden"]});
 close.hidden=true;
 safety.hidden=true;
 grid.classList.add("single-column");
})();
