"use strict";
const fs=require("fs"),path=require("path"),crypto=require("crypto"),P=require("./policy");
const clone=v=>JSON.parse(JSON.stringify(v));
function write(file,data){const tmp=file+".tmp",fd=fs.openSync(tmp,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify(data,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
// Compatibility configuration endpoints must not bypass V4 migration safety or audit.
async function prepare({directory,account,st,runtime,orders,nextType,verifyLiveFlat,ownsTick=false}){
 if(!P.LEGACY.has(P.type(account))||nextType!=="trend_only_v3")return null;
 const review=require("./legacy-review").diagnose(account,st,runtime,orders,{ownsTick,directory});
 if(!review.migrationEligible)throw Error(review.blockers.map(v=>v.field+"："+v.reason).join("；"));
 if(st.running||Number(st.positionQty)>0||Number(st.realPositionSize)>0||st.pendingOrder||st.smartExitPending||st.smartExitSignalCount||st.smartExitSignalTime||runtime.position||runtime.pendingOrder||Object.values(runtime.shortTermBooks||{}).some(b=>b.position||b.pendingOrder))throw Error("旧账户仍有仓位或未完成订单，不能迁移");
 if(st.activeError||st.smartRiskOff||runtime.riskLock||st.smartPauseUntil>Date.now()||st.smartLossLockedUntil>Date.now())throw Error("风险状态未解除，禁止迁移绕过");
 if(account.tradeMode==="simulation"&&account.simulationEnabled===true){if(P.ledgerReview(orders).unsettled)throw Error("Paper旧订单尚未完全结算，不能迁移");}else await verifyLiveFlat(account);
 const dir=path.join(directory,"backups","v4-migrations");fs.mkdirSync(dir,{recursive:true,mode:0o700});const id=crypto.randomUUID(),file=path.join(dir,id+".json"),hash=value=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),audit={id,time:Date.now(),phase:"PREPARED",source:"compatibility_config_explicit_strategy_change",beforeAccount:clone(account),beforeRuntime:clone(runtime),review,historyHash:hash(st.profitHistory||[]),ordersHash:hash(orders),historyLength:(st.profitHistory||[]).length,...(["classic","smart_regime_v1"].includes(P.type(account))&&account.tradeMode==="simulation"&&Number.isFinite(Number(st.simBalance))?{beforeLegacyPaperBalance:Number(st.simBalance)}:{})};write(file,audit);return{file,audit};
}
function complete(record,runtime){if(!record)return;if(record.audit.beforeLegacyPaperBalance!==undefined)runtime.simBalance=record.audit.beforeLegacyPaperBalance;record.audit.phase="COMPLETED";record.audit.afterFinancial={simBalance:runtime.simBalance??null,journalLength:(runtime.journal||[]).length};write(record.file,record.audit);}
function assertTarget(record,next){if(!record)return;for(const key of ["id","simulationBalance","platform","symbol","quoteAsset","address","privateKey","apiKey","apiSecret","starkPrivateKey","publicKey","vault"]){if(next[key]!==undefined&&next[key]!==record.audit.beforeAccount[key])throw Error("迁移不得同时改写账户标识、资金基数、交易对或密钥："+key);}}
module.exports={prepare,complete,assertTarget};
