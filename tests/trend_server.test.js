const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),{EventEmitter}=require('events'),{createRequire}=require('module');
const base=path.resolve(__dirname,'..');
function setup(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'trend-server-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const acc={id:'legacy',name:'legacy',platform:'hyperliquid',symbol:'ETH',side:'long',strategyType:'classic',tradeMode:'simulation',simulationEnabled:true,simulationBalance:10000,leverage:5,baseAmount:100,addAmount:100,takeProfit:.01,addTrigger:.01,maxAdds:2,interval:15000,running:false};
 fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({currentAccountId:acc.id,accounts:[acc]}));
 fs.writeFileSync(path.join(directory,'auth.json'),JSON.stringify({adminUsername:'test',adminPassword:'test'}));
 const raw=fs.readFileSync(path.join(base,'server.js'),'utf8').split('\ninitSdk()')[0];
 let handler;const req=createRequire(path.join(base,'server.js'));
 const ctx={require:n=>n==='http'?{createServer:fn=>{handler=fn;return{close(){}};}}:req(n),__dirname:directory,console,Buffer,URL,URLSearchParams,AbortController,fetch:()=>{throw Error('禁止测试访问网络');},setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{},process:{...process,on(){}}};
 vm.createContext(ctx);vm.runInContext(raw,ctx);vm.runInContext('ensureAccountStates()',ctx);
 async function call(url,body,auth=true){
  const sid=auth?vm.runInContext('createSession("test")',ctx):'';
  const req=new EventEmitter();Object.assign(req,{url,method:body===undefined?'GET':'POST',headers:{cookie:'sid='+sid},destroy(){}});
  return await new Promise((resolve,reject)=>{let code;const res={writeHead:n=>code=n,end:text=>{try{resolve({code,data:JSON.parse(text)});}catch(e){reject(e);}}};handler(req,res);if(body!==undefined){req.emit('data',JSON.stringify(body));req.emit('end');}});
 }
 return{ctx,call};
}
test('趋势状态接口不可改写旧策略持仓',async t=>{const f=setup(t);vm.runInContext('stateMap.legacy.positionQty=2;stateMap.legacy.entryPrice=100',f.ctx);const r=await f.call('/api/trend-only');assert.equal(r.code,200);assert.equal(r.data.active,false);assert.equal(vm.runInContext('stateMap.legacy.positionQty',f.ctx),2);});
test('未登录不能读取或确认 Live',async t=>{const f=setup(t);assert.equal((await f.call('/api/trend-only',undefined,false)).code,401);assert.equal((await f.call('/api/trend-only/confirm',{confirmLive:true},false)).code,401);});
test('启用趋势默认 Paper 并保存 10 倍配置',async t=>{const f=setup(t);const r=await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal(r.code,200,JSON.stringify(r));assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v1');assert.equal(vm.runInContext('config.accounts[0].leverage',f.ctx),10);assert.equal(vm.runInContext('config.accounts[0].tradeMode',f.ctx),'simulation');});
test('运行中禁止切换或修改趋势模式',async t=>{const f=setup(t);vm.runInContext('config.accounts[0].running=true;stateMap.legacy.running=true',f.ctx);const r=await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal(r.code,400);});
test('普通重置与手动下单不能绕过趋势状态',async t=>{const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal((await f.call('/api/reset',{})).code,400);assert.equal((await f.call('/api/manual-order',{size:1})).code,500);});
test('跨账户或过期确认拒绝',async t=>{const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal((await f.call('/api/trend-only/confirm',{accountId:'other',confirmLive:true})).code,400);assert.equal((await f.call('/api/trend-only/confirm',{accountId:'legacy',confirmLive:true})).code,400);});
