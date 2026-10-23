"use strict";
// Synthetic only. No production files or trading runtime, and all mutations are rejected.
const http=require("http"),fs=require("fs"),path=require("path"),F=require("./terminal_ui_fixture"),Review=require("../terminal/legacy-review");
const root=path.resolve(__dirname,"../public");
function start(port=39125){const rows=F.accounts(63);for(const i of [2,5]){rows[i].running=false;rows[i].strategyType="classic";rows[i].policy.status="LEGACY_RESTRICTED";}
 return http.createServer((req,res)=>{const u=new URL(req.url,"http://localhost"),id=u.searchParams.get("id")||"synthetic-2",a=rows.find(v=>v.id===id)||rows[2],json=v=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(v));};
  if(req.method!=="GET"){res.statusCode=405;return json({ok:false,error:"Synthetic fixture: all mutations disabled"});}
  if(u.pathname==="/api/v4/terminal")return json(F.payload(rows,a.id));
  if(u.pathname==="/api/v4/legacy-diagnostics"){
   const fill={status:"FILLED",symbol:"ETH",positionSide:"short",size:.4,orderSide:"sell",id:"open"},orders=a.id==="synthetic-5"?[fill,{...fill,orderSide:"buy",id:"close"}]:[fill];
   return json({ok:true,readOnly:true,items:[Review.diagnose({...a,tradeMode:"simulation",simulationEnabled:true,simulationBalance:10000},{running:false,tickRunning:false,positionQty:0,realPositionSize:"-",simBalance:10000},{position:null,pendingOrder:null},orders)]});
  }
  if(u.pathname.startsWith("/api/")){res.statusCode=405;return json({ok:false,error:"Synthetic fixture: endpoint disabled"});}
  const file=path.resolve(root,"."+(u.pathname==="/"?"/index.html":u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!/[.](html|css|js)$/.test(file)){res.statusCode=404;return res.end();}
  res.setHeader("Content-Type",file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":"text/html");res.end(fs.readFileSync(file));
 }).listen(port,"127.0.0.1",()=>console.log("SYNTHETIC ONLY http://127.0.0.1:"+port+"/?account=synthetic-2#settings"));
}
if(require.main===module)start();module.exports={start};
