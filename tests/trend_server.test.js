const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),{EventEmitter}=require('events'),{createRequire}=require('module');
const base=path.resolve(__dirname,'..');
function setup(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'trend-server-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const acc={id:'legacy',name:'legacy',platform:'hyperliquid',address:'0xabc',privateKey:'0x'+'1'.repeat(64),apiKey:'key',apiSecret:'secret',starkPrivateKey:'stark-secret',publicKey:'pub',vault:'vault',symbol:'ETH',quoteAsset:'USDC',side:'long',strategyType:'classic',tradeMode:'simulation',simulationEnabled:true,simulationBalance:10000,leverage:5,baseAmount:100,addAmount:100,takeProfit:.01,addTrigger:.01,maxAdds:2,interval:15000,running:false};
 fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({currentAccountId:acc.id,accounts:[acc]}));
 fs.writeFileSync(path.join(directory,'auth.json'),JSON.stringify({adminUsername:'test',adminPassword:'test'}));
 const raw=fs.readFileSync(path.join(base,'server.js'),'utf8').split('\ninitSdk()')[0];
 let handler;const req=createRequire(path.join(base,'server.js'));
 const ctx={require:n=>n==='http'?{createServer:fn=>{handler=fn;return{close(){}};}}:req(n),__dirname:directory,console,Buffer,URL,URLSearchParams,AbortController,fetch:()=>{throw Error('禁止测试访问网络');},setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{},process:{...process,on(){}}};
 vm.createContext(ctx);vm.runInContext(raw,ctx);vm.runInContext('ensureAccountStates()',ctx);
 async function call(url,body,auth=true){
  const sid=auth?vm.runInContext('createSession("test")',ctx):'';
  const req=new EventEmitter();Object.assign(req,{url,method:body===undefined?'GET':'POST',headers:{cookie:'sid='+sid},destroy(){}});
  return await new Promise((resolve)=>{let code,headers={};const res={writeHead:(n,h={})=>{code=n;headers=h;},end:text=>{let data;try{data=JSON.parse(text);}catch(e){data=text;}resolve({code,headers,data,text:String(text||'')});}};handler(req,res);if(body!==undefined){req.emit('data',JSON.stringify(body));req.emit('end');}});
 }
 return{ctx,call};
}
test('趋势状态接口不可改写旧策略持仓',async t=>{const f=setup(t);vm.runInContext('stateMap.legacy.positionQty=2;stateMap.legacy.entryPrice=100',f.ctx);const r=await f.call('/api/trend-only');assert.equal(r.code,200);assert.equal(r.data.active,false);assert.equal(vm.runInContext('stateMap.legacy.positionQty',f.ctx),2);});
test('未登录不能读取或确认 Live',async t=>{const f=setup(t);assert.equal((await f.call('/api/trend-only',undefined,false)).code,401);assert.equal((await f.call('/api/trend-only/confirm',{confirmLive:true},false)).code,401);});
test('启用趋势默认推荐 V2、Paper 并保存 10 倍配置',async t=>{const f=setup(t);const r=await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal(r.code,200,JSON.stringify(r));assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v2');assert.equal(vm.runInContext('config.accounts[0].leverage',f.ctx),10);assert.equal(vm.runInContext('config.accounts[0].tradeMode',f.ctx),'simulation');});
test('Trend Only V1 继续可用并可一键升级到 V2',async t=>{const f=setup(t);assert.equal((await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v1',config:{}})).code,200);assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v1');assert.equal((await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{}})).code,200);assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v2');});
test('V2 chopTransitionMax=52 可正常保存且不依赖旧 maxChop',async t=>{const f=setup(t);const r=await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{chopTransitionMax:52,maxChopToTrade:1}});assert.equal(r.code,200,JSON.stringify(r.data));assert.equal(vm.runInContext('config.accounts[0].trendOnlyConfig.chopTransitionMax',f.ctx),52);assert.equal(vm.runInContext('Object.hasOwn(config.accounts[0].trendOnlyConfig,"maxChopToTrade")',f.ctx),false);});
test('Extended Live + Trend Only V2 启动返回明确禁用原因',async t=>{const f=setup(t);vm.runInContext('Object.assign(config.accounts[0],{strategyType:"trend_only_v2",strategyMode:"Trend Only V2",platform:"extended",tradeMode:"live",simulationEnabled:false,trendOnlyConfig:require("./trend_only_v2").normalizeConfig({})})',f.ctx);const r=await f.call('/api/start',{});assert.equal(r.code,400);assert.match(r.data.error,/Extended Live 趋势下单暂未开放/);assert.equal(r.data.message,r.data.error);});
test('运行中禁止切换或修改趋势模式',async t=>{const f=setup(t);vm.runInContext('config.accounts[0].running=true;stateMap.legacy.running=true',f.ctx);const r=await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal(r.code,400);});
test('普通重置与手动下单不能绕过趋势状态',async t=>{const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal((await f.call('/api/reset',{})).code,400);assert.equal((await f.call('/api/manual-order',{size:1})).code,500);});
test('跨账户或过期确认拒绝',async t=>{const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal((await f.call('/api/trend-only/confirm',{accountId:'other',confirmLive:true})).code,400);assert.equal((await f.call('/api/trend-only/confirm',{accountId:'legacy',confirmLive:true})).code,400);});
test('/api/status、/api/mobile-status 与 /api/config 不返回完整密钥',async t=>{
 const f=setup(t);
 for(const endpoint of ['/api/status','/api/mobile-status']){
  const r=await f.call(endpoint);
  const text=JSON.stringify(r.data);
  assert.equal(r.code,200);
  assert.equal(text.includes('privateKey'),false);
  assert.equal(text.includes('apiSecret'),false);
  assert.equal(text.includes('starkPrivateKey'),false);
  assert.equal(r.data.config.hasPrivateKey,true);
  assert.equal(r.data.config.hasApiSecret,true);
  assert.equal(r.data.config.hasStarkPrivateKey,true);
 }
 const saved=await f.call('/api/config',{name:'legacy-safe',platform:'hyperliquid',symbol:'ETH',quoteAsset:'USDC',side:'long',tradeMode:'simulation',simulationEnabled:true,privateKey:'',apiSecret:'',starkPrivateKey:'',leverage:5,baseAmount:100,addAmount:100,takeProfit:.01,addTrigger:.01,maxAdds:2,interval:15000});
 const text=JSON.stringify(saved.data);
 assert.equal(saved.code,200,text);
 assert.equal(text.includes('privateKey'),false);
 assert.equal(text.includes('apiSecret'),false);
 assert.equal(text.includes('starkPrivateKey'),false);
});
test('密钥输入为空时保存配置不会清空旧密钥',async t=>{
 const f=setup(t);
 const before=vm.runInContext('config.accounts[0].privateKey',f.ctx);
 await f.call('/api/config',{name:'legacy',platform:'hyperliquid',symbol:'ETH',quoteAsset:'USDC',side:'long',tradeMode:'simulation',simulationEnabled:true,privateKey:'',apiKey:'',apiSecret:'',starkPrivateKey:'',publicKey:'',vault:'',leverage:5,baseAmount:100,addAmount:100,takeProfit:.01,addTrigger:.01,maxAdds:2,interval:15000});
 assert.equal(vm.runInContext('config.accounts[0].privateKey',f.ctx),before);
 assert.equal(vm.runInContext('config.accounts[0].apiSecret',f.ctx),'secret');
});
test('静态路由禁止访问 public 目录外文件',async t=>{
 const f=setup(t);
 assert.equal((await f.call('/../auth.json')).code,403);
 assert.equal((await f.call('/../config.json')).code,403);
});
test('批量启动跳过 Trend Only 并返回明确原因',async t=>{
 const f=setup(t);
 await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});
 const r=await f.call('/api/start-all',{});
 assert.equal(r.code,200,JSON.stringify(r.data));
 assert.equal(r.data.successCount,0);
 assert.equal(r.data.skippedCount,1);
 assert.match(r.data.skipped[0].reason,/Trend Only V2/);
});
