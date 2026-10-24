"use strict";
const fs=require("fs"),path=require("path"),crypto=require("crypto"),P=require("./policy");
const clone=v=>JSON.parse(JSON.stringify(v));
function write(file,data){const tmp=file+".tmp",fd=fs.openSync(tmp,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify(data,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
const REQUIRED="LEGACY_MIGRATION_REQUIRED：旧账户只允许通过系统设置 → 旧账户安全迁移，明确升级为 Trend V3 Paper";
// One permission source for formal migration and every configuration endpoint.
function authorize({account,next={},entryPoint="compatibility",confirm=false}){
 // Explicit null/empty values are not omissions: accepting them could erase the
 // configured type and reactivate the legacy default resolver after a save.
 const from=P.type(account),to=next.strategyType===undefined?from:next.strategyType;
 if(P.LEGACY.has(from)){
  if(entryPoint!=="formal"||to!=="trend_only_v3"||confirm!==true)throw Error(REQUIRED);
  if(account.tradeMode!=="simulation"||account.simulationEnabled!==true)throw Error(REQUIRED+"；旧Live权限保持不变，不能静默转Paper");
  for(const key of ["id","simulationBalance","platform","symbol","quoteAsset","address","tradeMode","simulationEnabled"])if(next[key]!==undefined&&next[key]!==account[key])throw Error(REQUIRED+"；迁移不得同时修改 "+key);
  return;
 }
 if(entryPoint==="formal")throw Error(REQUIRED+"；当前账户不是旧策略");
 if(!P.CORE.has(from))throw Error("UNSUPPORTED_STRATEGY：未知策略不能通过配置接口切换引擎");
 if(to!==from)throw Error("STRATEGY_SWITCH_FORBIDDEN：核心策略使用独立账户，不能切换或降级到旧引擎");
 if(next.tradeMode!==undefined&&next.tradeMode!=="simulation"||next.simulationEnabled!==undefined&&next.simulationEnabled!==true)throw Error("PAPER_ONLY：V3/4H 不支持Live");
 for(const key of ["id","simulationBalance"])if(next[key]!==undefined&&next[key]!==account[key])throw Error("ACCOUNT_IDENTITY_LOCKED：不可重写 "+key);
}
function validate(options){
 authorize({...options,next:options.next||{strategyType:options.nextType}});
 if(!P.LEGACY.has(P.type(options.account)))return null;
 return require("./legacy-review").diagnose(options.account,options.st,options.runtime,options.orders,{ownsTick:options.ownsTick,directory:options.directory});
}
async function prepare(options){
 const {directory,account,st,runtime,orders}=options,review=validate(options);
 if(!review)return null;
 if(!review.migrationEligible){const error=Error(review.blockers.map(v=>v.field+"："+v.reason).join("；"));error.diagnostics=review;throw error;}
 const dir=path.join(directory,"backups","v4-migrations");fs.mkdirSync(dir,{recursive:true,mode:0o700});const id=crypto.randomUUID(),file=path.join(dir,id+".json"),hash=value=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),audit={id,time:Date.now(),phase:"PREPARED",source:"formal_v4_migration",beforeAccount:clone(account),beforeRuntime:clone(runtime),review,historyHash:hash(st.profitHistory||[]),ordersHash:hash(orders),historyLength:(st.profitHistory||[]).length,...(["classic","smart_regime_v1"].includes(P.type(account))&&account.tradeMode==="simulation"&&Number.isFinite(Number(st.simBalance))?{beforeLegacyPaperBalance:Number(st.simBalance)}:{})};write(file,audit);return{file,audit};
}
function complete(record,runtime){if(!record)return;if(record.audit.beforeLegacyPaperBalance!==undefined)runtime.simBalance=record.audit.beforeLegacyPaperBalance;record.audit.phase="COMPLETED";record.audit.afterFinancial={simBalance:runtime.simBalance??null,journalLength:(runtime.journal||[]).length};write(record.file,record.audit);}
module.exports={authorize,validate,prepare,complete};
