"use strict";
const crypto=require("crypto"),Turtle=require("../strategy/turtle_4h/config"),B=require("../strategy/turtle_4h/book");
const Leverage=require("../market_leverage");
function fields(v,keys){if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error("请求包含不允许的身份、资金或权限字段");}
function body(req){return new Promise((resolve,reject)=>{let text="",large=false;req.on("data",x=>{if(large)return;text+=x;if(Buffer.byteLength(text)>16384){text="";large=true;}});req.on("end",()=>{try{if(large)throw Error();resolve(JSON.parse(text||"{}"));}catch{reject(Error("请求格式无效"));}});req.on("error",reject);});}
async function handle(req,res,parsed,d){
 const send=(code,v)=>d.json(res,code,v);let st,lock;
 const C=d.profile||Turtle,base="/api/v4/"+(C.route||"turtle")+"/",configKey=C.configKey||"turtleConfig";
 try{
  if(!parsed.pathname.startsWith(base))return send(404,{ok:false,error:"接口不存在"});
  const route=parsed.pathname.slice(base.length),q=parsed.query||Object.fromEntries(parsed.searchParams||[]);
  if(req.method==="GET"){
   if(route==="accounts")return send(200,{ok:true,defaults:C.defaults,accounts:d.accounts().filter(a=>!a.archivedAt).map(a=>({id:a.id,name:a.name,symbol:a.symbol,quoteAsset:a.quoteAsset,platform:a.platform,strategyType:a.strategyType,paper:a.tradeMode==="simulation"&&a.simulationEnabled===true,running:a.strategyType===C.ID?!!d.engine.get(a)?.running:!!d.state(a.id)?.running})),revision:C.REVISION});
   if(!["status","history"].includes(route))return send(404,{ok:false,error:"接口不存在"});
   const a=d.getAccountById(q.id);C.assertAccount(a);
   if(route==="history"){
    const trades=d.engine.get(a)?.trades||[];
    const offset=Math.min(Math.max(0,Math.floor(Number(q.offset)||0)),trades.length),end=trades.length-offset;
    return send(200,{ok:true,total:trades.length,items:trades.slice(Math.max(end-30,0),end).reverse()});
   }
   return send(200,{ok:true,snapshot:d.engine.view(a,d.state(a.id))});
  }
  if(req.method!=="POST")return send(405,{ok:false,error:"操作不支持"});
  if(!["accounts","config","control","preflight"].includes(route))return send(404,{ok:false,error:"接口不存在"});
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return send(403,{ok:false,error:"请在本站操作"});
  const input=await body(req);
  if(route==="accounts"){
   fields(input,["name","symbol","initialEquity","config"]);const c=C.normalize(input.config),equity=input.initialEquity??10000;
   if(typeof input.name!=="string"||!input.name.trim()||input.name.length>60||!["ETH","BTC"].includes(input.symbol)||typeof equity!=="number"||!Number.isFinite(equity)||equity<100||equity>1e7)throw Error("账户名称、品种或初始模拟权益无效");
   const a={id:crypto.randomUUID(),name:input.name.trim(),platform:"binance",symbol:input.symbol,quoteAsset:"USDT",strategyType:C.ID,strategyMode:(C.label||"海龟趋势 4H")+" · Paper",[configKey]:c,running:false,tradeMode:"simulation",simulationEnabled:true,simulationBalance:equity,interval:15000,side:"long",leverage:c.leverage??1,maxAdds:0,baseAmount:1,addAmount:1,takeProfit:.01,addTrigger:.01};
   C.assertAccount(a);
   if(c.leverage>1&&d.leverageRules)Leverage.assertAllowed(c.leverage,await d.leverageRules(a),c.allocationPct?equity*c.allocationPct:0);
   const before=d.configuration(),next=structuredClone(before);next.accounts.push(a);
   // The independent empty book may safely precede account registration; failed registration never starts a strategy.
   d.engine.commit(a,d.engine.initial?d.engine.initial(a):B.initial(a,C));d.save(next);return send(200,{ok:true,id:a.id,message:"独立模拟账户已创建，保持停止；无需交易密钥"});
  }
  fields(input,["id","config","expectedHash","action","confirm","positionId"]);
  const a=d.getAccountById(input.id);C.assertAccount(a);st=d.state(a.id);
  if(a.archivedAt&&!["pause","close"].includes(input.action))throw Error("账户已移出列表，请先恢复账户");
  if(!st||st.tickRunning||st.terminalMutating||d.engine.busy(a.id))throw Error("正在更新账户，请稍后重试");
  lock=d.lock(a.id);if(!lock)throw Error("账户操作繁忙");st.terminalMutating=true;
  if(route==="preflight"){
   fields(input,["id"]);
   // The runtime records failed market reads so they appear alongside the other blockers.
   if(d.engine.get(a)){
    try {await d.engine.refresh(a);} catch {}
   }
   const snapshot=d.engine.view(a,st);
   return send(200,{ok:true,preflight:snapshot.preflight,snapshot});
  }
  if(route==="config"){
   fields(input,["id","config","expectedHash"]);
   const c=C.normalize(input.config),meta=d.engine.configure(a,c,input.expectedHash);
   if(c.leverage>1&&d.leverageRules)Leverage.assertAllowed(c.leverage,await d.leverageRules(a),c.allocationPct?d.engine.get(a).balance*c.allocationPct:0);
   const next=d.configuration(),target=next.accounts.find(v=>v.id===a.id);
   target[configKey]=c;
   target.leverage=c.leverage??1;
   d.save(next);return send(200,{ok:true,...meta,message:meta.nextCycleOnly?"已保存为下一轮参数；持仓与待成交委托仍按原快照执行":"参数已保存，未自动启动"});
  }
  if(route==="control"){
   fields(input,["id","action","confirm","expectedHash","positionId"]);
   if(input.action==="close"){
    if(input.confirm!==true)throw Error("请明确确认平掉模拟仓位");
    const book=d.engine.get(a);
    if(!book?.position)throw Error("当前无模拟持仓");
    if(input.positionId!==undefined&&input.positionId!==book.position.id)throw Error("持仓已变化，请刷新后重新确认");
    if(book.pending)throw Error("已有待成交委托，请等待成交结果后再操作");
    d.engine.control(a,st,"pause");
    try {await d.engine.tick(a,st,{manual:true});}
    catch(error){return send(409,{ok:false,error:"已暂停新增，退出委托未提交："+error.message,snapshot:d.engine.view(a,st)});}
    const snapshot=d.engine.view(a,st);
    const message=!snapshot.position?"已暂停新增，模拟仓位已结算":C.startMessage?snapshot.decision.reason:"已暂停新增，退出委托等待模拟成交";
    return send(200,{ok:true,message,snapshot});
   }
   if(input.action==="start"){
    if(input.confirm!==true||input.expectedHash!==C.hash(a[configKey]))throw Error("请确认当前已保存的参数后再启动");
    if(d.engine.get(a)?.running)return send(200,{ok:true,message:"当前模拟监控已运行",snapshot:d.engine.view(a,st)});
    const c=C.normalize(a[configKey]);
    if(c.leverage>1&&d.leverageRules)Leverage.assertAllowed(c.leverage,await d.leverageRules(a),c.allocationPct?d.engine.get(a).balance*c.allocationPct:0);
    await d.engine.refresh(a);
   }
   d.engine.control(a,st,input.action);return send(200,{ok:true,snapshot:d.engine.view(a,st),message:input.action==="start"?(C.startMessage||"4H 模拟监控已启动；等待下一根已收盘信号"):"已暂停新开仓；已有仓位继续执行退出保护"});
  }
  throw Error("接口不存在");
 }catch(e){return send(400,{ok:false,error:e.message});}finally{if(lock){st.terminalMutating=false;d.unlock(lock);}}
}
module.exports={handle};
