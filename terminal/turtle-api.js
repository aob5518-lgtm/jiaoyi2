"use strict";
const crypto=require("crypto"),C=require("../strategy/turtle_4h/config"),B=require("../strategy/turtle_4h/book");
function fields(v,keys){if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error("请求包含不允许的身份、资金或权限字段");}
function body(req){return new Promise((resolve,reject)=>{let text="",large=false;req.on("data",x=>{if(large)return;text+=x;if(Buffer.byteLength(text)>16384){text="";large=true;}});req.on("end",()=>{try{if(large)throw Error();resolve(JSON.parse(text||"{}"));}catch{reject(Error("请求格式无效"));}});req.on("error",reject);});}
async function handle(req,res,parsed,d){
 const send=(code,v)=>d.json(res,code,v);let st,lock;
 try{
  const route=parsed.pathname,q=parsed.query||Object.fromEntries(parsed.searchParams||[]);
  if(req.method==="GET"){
   if(route.endsWith("/accounts"))return send(200,{ok:true,defaults:C.defaults,accounts:d.accounts().map(a=>({id:a.id,name:a.name,symbol:a.symbol,quoteAsset:a.quoteAsset,platform:a.platform,strategyType:a.strategyType,paper:a.tradeMode==="simulation"&&a.simulationEnabled===true,running:a.strategyType===C.ID?!!d.engine.get(a)?.running:!!d.state(a.id)?.running})),revision:C.REVISION});
   const a=d.getAccountById(q.id);C.assertAccount(a);return send(200,{ok:true,snapshot:d.engine.view(a,d.state(a.id))});
  }
  if(req.method!=="POST")return send(405,{ok:false,error:"操作不支持"});
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return send(403,{ok:false,error:"请在本站操作"});
  const input=await body(req);
  if(route.endsWith("/accounts")){
   fields(input,["name","symbol","initialEquity","config"]);const c=C.normalize(input.config),equity=input.initialEquity??10000;
   if(typeof input.name!=="string"||!input.name.trim()||input.name.length>60||!["ETH","BTC"].includes(input.symbol)||typeof equity!=="number"||!Number.isFinite(equity)||equity<100||equity>1e7)throw Error("账户名称、品种或初始模拟权益无效");
   const a={id:crypto.randomUUID(),name:input.name.trim(),platform:"binance",symbol:input.symbol,quoteAsset:"USDT",strategyType:C.ID,strategyMode:"海龟趋势 4H · Paper",turtleConfig:c,running:false,tradeMode:"simulation",simulationEnabled:true,simulationBalance:equity,interval:15000,side:"long",leverage:c.leverage,maxAdds:0,baseAmount:1,addAmount:1,takeProfit:.01,addTrigger:.01};
   C.assertAccount(a);const before=d.configuration(),next=structuredClone(before);next.accounts.push(a);
   // The independent empty book may safely precede account registration; failed registration never starts a strategy.
   d.engine.commit(a,B.initial(a));d.save(next);return send(200,{ok:true,id:a.id,message:"独立模拟账户已创建，保持停止；无需交易密钥"});
  }
  fields(input,["id","config","expectedHash","action","confirm"]);
  const a=d.getAccountById(input.id);C.assertAccount(a);st=d.state(a.id);
  if(!st||st.tickRunning||st.terminalMutating||d.engine.busy(a.id))throw Error("正在更新账户，请稍后重试");
  lock=d.lock(a.id);if(!lock)throw Error("账户操作繁忙");st.terminalMutating=true;
  if(route.endsWith("/preflight")){
   if(input.config||input.action)throw Error("检查接口不接受参数修改");
   await d.engine.refresh(a);st.activeError="";return send(200,{ok:true,preflight:d.engine.preflight(a,st),snapshot:d.engine.view(a,st)});
  }
  if(route.endsWith("/config")){
   fields(input,["id","config","expectedHash"]);const c=C.normalize(input.config),meta=d.engine.configure(a,c,input.expectedHash),next=d.configuration();
   next.accounts.find(v=>v.id===a.id).turtleConfig=c;d.save(next);return send(200,{ok:true,...meta,message:meta.nextCycleOnly?"已保存为下一轮参数；持仓与待成交委托仍按原快照执行":"参数已保存，未自动启动"});
  }
  if(route.endsWith("/control")){
   fields(input,["id","action","confirm","expectedHash"]);
   if(input.action==="close"){if(input.confirm!==true)throw Error("请明确确认平掉模拟仓位");d.engine.control(a,st,"pause");await d.engine.tick(a,st,{manual:true});return send(200,{ok:true,message:"已暂停新增，退出委托等待模拟成交"});}
   if(input.action==="start"){
    if(input.confirm!==true||input.expectedHash!==C.hash(a.turtleConfig))throw Error("请确认当前已保存的参数后再启动");
    await d.engine.refresh(a);
   }
   d.engine.control(a,st,input.action);return send(200,{ok:true,snapshot:d.engine.view(a,st),message:input.action==="start"?"4H 模拟监控已启动；等待下一根已收盘信号":"已暂停新开仓；已有仓位继续受到止损和通道退出保护"});
  }
  throw Error("接口不存在");
 }catch(e){return send(400,{ok:false,error:e.message});}finally{if(lock){st.terminalMutating=false;d.unlock(lock);}}
}
module.exports={handle};
