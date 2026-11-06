"use strict";
const fs=require("fs"),path=require("path"),crypto=require("crypto"),C=require("./config"),B=require("./book"),M=require("./market"),A=require("./analytics"),R=require("./registry"),D=require("./data"),Research=require("./research");
const projections=b=>({id:b.id,symbol:b.symbol,mode:b.mode,running:b.running,scope:C.scope(b.config,b.symbol,b.mode,b.experimentId),config:b.config,equity:b.equity,position:b.position,pending:b.pending,riskLock:b.riskLock,riskReason:b.riskReason,lastSnapshot:b.lastSnapshot,alerts:(b.alerts||[]).slice(-20),metrics:A.metrics(b),orders:b.orders.slice(-50),history:b.history.slice(-50),decisions:b.decisions.slice(-50),equityCurve:b.equityCurve.slice(-1000),hypotheses:R.hypotheses,gate:"UNVALIDATED_NO_LIVE"});
function createService({directory,data=D.adapter(),now=Date.now}){
 const dir=path.resolve(directory),file=path.join(dir,"runtime.json");let books={},timer=null,busy=false,loadError="";
 try{if(fs.existsSync(file)){const saved=JSON.parse(fs.readFileSync(file,"utf8"));if(saved.schema!==1||!saved.books||Array.isArray(saved.books))throw Error("状态版本无效");books=saved.books;for(const b of Object.values(books)){C.scope(b.config,b.symbol,b.mode,b.experimentId);if(!b.id||!Number.isFinite(b.equity)||!Array.isArray(b.orders)||!Array.isArray(b.history))throw Error("研究账本损坏");}}}catch(e){loadError="V5_STATE_CORRUPT: "+e.message;books={};}
 const writable=()=>{if(loadError)throw Error(loadError);};
 function save(){writable();fs.mkdirSync(dir,{recursive:true,mode:0o700});const temp=file+".tmp",fd=fs.openSync(temp,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,persistedAt:now(),books}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}
 function get(id){writable();if(!books[id])throw Error("研究账户不存在");return books[id];}
 function create(input){writable();if(!input||Object.keys(input).some(k=>!["symbol","mode","config","initialEquity"].includes(k)))throw Error("不允许账户/凭据/权限字段");if(input.mode&&input.mode!=="Shadow")throw Error("在线服务仅支持Shadow");const b=B.create({id:crypto.randomUUID(),symbol:input.symbol||"ETH",mode:"Shadow",equity:input.initialEquity??10000,config:input.config||{}});Research.appendExperiment(path.join(dir,"audit"),{type:"CREATE_SHADOW",at:now(),scope:C.scope(b.config,b.symbol,b.mode,b.experimentId)});books[b.id]=b;try{save();}catch(error){delete books[b.id];throw error;}return projections(b);}
 async function tick(){
  if(busy)return;writable();busy=true;
  try{for(const b of Object.values(books)){if(!b.running&&!b.position&&!b.pending)continue;try{
   const e=await data.snapshot(b.symbol);const s=M.evaluate({bars:e.bars,symbol:b.symbol,now:e.time,quote:e.quote,config:b.config});
   B.step(b,{...e,signal:s},Object.values(books));b.lastError=null;const observed=A.metrics(b);if(observed.trades>=10&&(observed.expectancyR<0||observed.maxDrawdown>=b.config.dailyLossLimit)){b.alerts||=[];if(b.alerts.at(-1)?.code!=="STRATEGY_DEVIATION")b.alerts.push({time:now(),code:"STRATEGY_DEVIATION",message:"前向表现不支持稳定优势；需要研究审查，禁止自动调整风险"});}
  }catch(e){b.lastError="MARKET_DATA_UNAVAILABLE";b.lastSnapshot={...(b.lastSnapshot||{}),decision:{time:now(),signalPermission:"blocked",executionPermission:"blocked",finalDecision:"DATA_ERROR",blockers:["MARKET_DATA_UNAVAILABLE"]}};b.alerts||=[];b.alerts.push({time:now(),code:"MARKET_DATA_UNAVAILABLE"});b.alerts=b.alerts.slice(-100);if(b.pending){const o=b.orders.find(o=>o.id===b.pending.id);if(o&&o.status!=="UNKNOWN"){o.status="CANCELLED";b.pending=null;}}}}save();}finally{busy=false;}
 }
 function startTimer(){if(!timer){timer=setInterval(()=>tick().catch(()=>{}),15000);timer.unref?.();}}
 function control(id,action){
  const b=get(id);if(busy)throw Error("行情评估中，请稍后重试");
  if(!["start","pause"].includes(action))throw Error("不支持权限升级、解锁或删除");
  if(action==="start"&&b.riskLock)throw Error("风险锁定，禁止自动恢复");
  b.running=action==="start";save();if(b.running)startTimer();return projections(b);
 }
 const list=()=>({schema:1,allowLive:false,error:loadError||null,accounts:Object.values(books).map(projections),hypotheses:R.hypotheses,experiments:R.experiments,preregistration:R.preregistration});
 function stop(){if(timer)clearInterval(timer);timer=null;if(!loadError&&fs.existsSync(file))save();}
 if(Object.values(books).some(b=>b.running||b.position||b.pending))startTimer();
 return{list,create,control,tick,get,save,stop,status:()=>({busy,loadError})};
}
function safeJson(v){const blocked=/private.?key|api.?key|api.?secret|password|token|signature|credential|wallet|vault|address/i;return JSON.parse(JSON.stringify(v,(key,value)=>blocked.test(key)?undefined:value));}
function researchSummary(){
 const file=path.resolve(__dirname,"../../docs/HYPOTHESIS_V5_RESULTS_20261106.json");if(!fs.existsSync(file))return{available:false,reason:"尚未载入真实研究报告"};
 const report=JSON.parse(fs.readFileSync(file,"utf8"));return{available:true,kind:report.kind,limitations:report.additionalLimitations,assets:Object.fromEntries(Object.entries(report.assets).map(([k,v])=>[k,{dataHash:v.dataHash,source:v.source,rows:v.rows,parameters:v.parameters,gate:v.gate,oosDecay:v.oosDecay,splits:Object.fromEntries(Object.entries(v.results).map(([segment,result])=>[segment,{from:result.from,to:result.to,metrics:result.experiments[0].metrics,curve:result.baselineCurveSample}])),weekendComparison:v.results.outOfSample.experiments.filter(x=>x.scope.experimentId.startsWith("WEEKEND")).map(x=>({mode:x.scope.experimentId,metrics:x.metrics})),walkForward:v.walkForward.map(x=>({trainUntil:x.trainUntil,metrics:x.result.metrics}))}]))};
}
async function handle(req,res,url,service){
 const send=(code,v)=>{res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(safeJson(v)));};
 try{if(req.method==="GET"&&url.pathname==="/api/v5/status")return send(200,{ok:true,...service.list()});
  if(req.method==="GET"&&url.pathname==="/api/v5/research")return send(200,{ok:true,...researchSummary()});
  if(req.method!=="POST"||!["/api/v5/accounts","/api/v5/control"].includes(url.pathname))return send(405,{ok:false,error:"研究只读或受限操作"});
  let text="";for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16384)return send(413,{ok:false,error:"请求过大"});}
  const input=JSON.parse(text||"{}");let result;
  if(url.pathname==="/api/v5/accounts")result=service.create(input);
  else{if(Object.keys(input).some(k=>!["id","action"].includes(k)))throw Error("操作字段不允许");result=service.control(input.id,input.action);}
  return send(200,{ok:true,account:result});
 }catch(e){return send(400,{ok:false,error:e.message.startsWith("V5_STATE")?"研究账本损坏，已禁止执行":String(e.message).slice(0,180)});}
}
module.exports={createService,handle,safeJson,projections,researchSummary};
