"use strict";
// Read-only public Hyperliquid info calls. No SDK, signatures, credentials or order methods.
const fs=require("fs"),path=require("path"),{verifyFlat}=require("../terminal/native-review");
async function audit(directory){
 const cfg=JSON.parse(fs.readFileSync(path.join(directory,"config.json"),"utf8")),items=[];
 for(const a of cfg.accounts.filter(a=>["classic","smart_regime_v1","trend_only_v1","trend_only_v2"].includes(a.strategyType||"classic")&&!(a.tradeMode==="simulation"&&a.simulationEnabled===true))){
  const row={id:a.id,name:a.name,platform:a.platform,at:Date.now(),verified:false};
  if(a.platform!=="hyperliquid"){items.push({...row,reason:"此离线只读工具仅支持Hyperliquid；其他平台须使用登录后的原生核验入口"});continue;}
  try{
   const values=await Promise.all(["clearinghouseState","openOrders"].map(async type=>{const r=await fetch("https://api.hyperliquid.xyz/info",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type,user:a.address}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error("native info HTTP "+r.status);return r.json();}));
   const positions=values[0]?.assetPositions,orders=values[1];
   row.positions=Array.isArray(positions)?positions.map(p=>({symbol:p.position?.coin,qty:p.position?.szi})):null;row.openOrderCount=Array.isArray(orders)?orders.length:null;
   Object.assign(row,verifyFlat("hyperliquid",positions,orders));
  }catch(error){row.reason=error.message;}
  items.push(row);
 }
 return{source:"native_read_only_info",at:Date.now(),items};
}
if(require.main===module)audit(process.argv[2]||process.cwd()).then(v=>console.log(JSON.stringify(v,null,2))).catch(()=>{console.error("只读原生核验失败，未修改任何状态");process.exitCode=1;});
module.exports={audit};
