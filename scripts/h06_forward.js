"use strict";
// Independent local-only forward research host. Imports no exchange trading adapters.
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto'),C=require('../strategy/macd_scale_in/config'),{createRuntime}=require('../strategy/macd_scale_in/runtime');
function createService({directory,port=3376,start=false,mode='Shadow',symbol='ETH',provider,now}={}){
 directory=path.resolve(directory||'.h06-research');if(!['Shadow','Paper'].includes(mode)||!['ETH','BTC'].includes(symbol))throw Error('仅允许H06独立Shadow/Paper研究');
 fs.mkdirSync(directory,{recursive:true});
 const marker=path.join(directory,'H06_ISOLATED_RESEARCH');
 const existing=fs.readdirSync(directory);if(!fs.existsSync(marker)&&existing.length)throw Error('研究目录非空，不能复用生产或未知持久化目录');
 fs.writeFileSync(marker,'H06 isolated research only\n',{mode:0o600});
 const configFile=path.join(directory,'research-account.json');let account;
 if(fs.existsSync(configFile)){account=JSON.parse(fs.readFileSync(configFile));C.assertAccount(account);if(account.h06Mode!==mode||account.symbol!==symbol)throw Error('研究身份不一致');}
 else{account={id:crypto.randomUUID(),name:'H06-'+symbol+'-'+mode,platform:'binance',symbol,quoteAsset:'USDT',strategyType:C.ID,tradeMode:'simulation',simulationEnabled:true,simulationBalance:10000,h06Mode:mode,h06Config:C.normalize({})};fs.writeFileSync(configFile,JSON.stringify(account,null,2),{mode:0o600});}
 if(['apiKey','apiSecret','privateKey','starkPrivateKey','vault'].some(k=>account[k]))throw Error('研究账户不得携带任何交易凭据');
 const accessFile=path.join(directory,'research-access.json');if(!fs.existsSync(accessFile))fs.writeFileSync(accessFile,JSON.stringify({token:crypto.randomBytes(32).toString('hex')}),{mode:0o600});const access=JSON.parse(fs.readFileSync(accessFile));
 const state={running:!!start},runtime=createRuntime({directory,provider,now,permit:(a,risk)=>({allowed:risk<=runtime.get(a).equity*C.normalize(a.h06Config).maxPortfolioRiskPct,reason:'独立H06研究组合风险限制'})});let ticking=false;
 async function tick(){if(ticking)return;ticking=true;try{await runtime.tick(account,state);}catch(e){state.activeError=e.message;}finally{ticking=false;}}
 const server=http.createServer((req,res)=>{const auth=String(req.headers.authorization||'').replace(/^Bearer /,'');const ok=auth.length===access.token.length&&crypto.timingSafeEqual(Buffer.from(auth),Buffer.from(access.token));if(!ok){res.writeHead(401);return res.end('Unauthorized');}if(req.method!=='GET'||req.url!=='/status'){res.writeHead(405);return res.end('Read-only research host');}res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,running:state.running,...runtime.report(account),account:{id:account.id,name:account.name,symbol:account.symbol},activeError:state.activeError||null,bind:'127.0.0.1',realOrderCalls:0}));});
 let interval;return{server,account,state,runtime,tick,accessFile,start:async()=>{await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});interval=setInterval(tick,15000);tick();return server.address();},close:async()=>{clearInterval(interval);await new Promise(r=>server.close(r));}};
}
if(require.main===module){const args=process.argv.slice(2),value=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;const service=createService({directory:value('--directory','.h06-research'),port:Number(value('--port',3376)),start:args.includes('--start'),mode:value('--mode','Shadow'),symbol:value('--symbol','ETH')});service.start().then(address=>console.log(JSON.stringify({directory:path.resolve(value('--directory','.h06-research')),address,accountId:service.account.id,mode:service.account.h06Mode,running:service.state.running,realOrderPermission:false}))).catch(e=>{console.error(e.message);process.exitCode=1;});process.on('SIGINT',()=>service.close().then(()=>process.exit(0)));process.on('SIGTERM',()=>service.close().then(()=>process.exit(0)));}
module.exports={createService};
