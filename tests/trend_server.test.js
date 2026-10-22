const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),{EventEmitter}=require('events'),{createRequire}=require('module');
const base=path.resolve(__dirname,'..');
function setup(t,env={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'trend-server-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const acc={id:'legacy',name:'legacy',platform:'hyperliquid',address:'0xabc',privateKey:'0x'+'1'.repeat(64),apiKey:'key',apiSecret:'secret',starkPrivateKey:'stark-secret',publicKey:'pub',vault:'vault',symbol:'ETH',quoteAsset:'USDC',side:'long',strategyType:'classic',tradeMode:'simulation',simulationEnabled:true,simulationBalance:10000,leverage:5,baseAmount:100,addAmount:100,takeProfit:.01,addTrigger:.01,maxAdds:2,interval:15000,running:false};
 fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({currentAccountId:acc.id,accounts:[acc]}));
 fs.writeFileSync(path.join(directory,'auth.json'),JSON.stringify({adminUsername:'test',adminPassword:'test'}));
 const raw=fs.readFileSync(path.join(base,'server.js'),'utf8').split('\ninitSdk()')[0];
 let handler;const req=createRequire(path.join(base,'server.js'));
 const ctx={require:n=>n==='http'?{createServer:fn=>{handler=fn;return{close(){}};}}:req(n),__dirname:directory,console,Buffer,URL,URLSearchParams,AbortController,fetch:()=>{throw Error('禁止测试访问网络');},setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{},process:{...process,env:{...process.env,...env},on(){}}};
 vm.createContext(ctx);vm.runInContext(raw,ctx);vm.runInContext('ensureAccountStates()',ctx);
 async function call(url,body,auth=true){
  const sid=auth?vm.runInContext('createSession("test")',ctx):'';
  const req=new EventEmitter();Object.assign(req,{url,method:body===undefined?'GET':'POST',headers:{cookie:'sid='+sid},destroy(){}});
  return await new Promise((resolve)=>{let code,headers={};const res={writeHead:(n,h={})=>{code=n;headers=h;},end:text=>{let data;try{data=JSON.parse(text);}catch(e){data=text;}resolve({code,headers,data,text:String(text||'')});}};handler(req,res);if(body!==undefined){req.emit('data',JSON.stringify(body));req.emit('end');}});
 }
 return{ctx,call,directory};
}
test('趋势状态接口不可改写旧策略持仓',async t=>{const f=setup(t);vm.runInContext('stateMap.legacy.positionQty=2;stateMap.legacy.entryPrice=100',f.ctx);const r=await f.call('/api/trend-only');assert.equal(r.code,200);assert.equal(r.data.active,false);assert.equal(vm.runInContext('stateMap.legacy.positionQty',f.ctx),2);});
test('未登录不能读取或确认 Live',async t=>{const f=setup(t);assert.equal((await f.call('/api/trend-only',undefined,false)).code,401);assert.equal((await f.call('/api/trend-only/confirm',{confirmLive:true},false)).code,401);});

test('Short-Term authenticated API is isolated Shadow and configuration cannot enable Live',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{}});
 assert.equal((await f.call('/api/trend-only/short-term',undefined,false)).code,401);
 const save=await f.call('/api/trend-only/short-term/config',{id:'legacy',config:{enabled:true,allowLive:true,entryModes:['momentum_breakout'],riskPerTrade:.0025}});assert.equal(save.code,200);assert.equal(save.data.config.allowLive,false);assert.equal(save.data.orderPermission,false);
 const status=await f.call('/api/trend-only/short-term');assert.equal(status.code,200);assert.equal(status.data.strategyVersion,'short_term_v1');assert.equal(status.data.sampleType,'shadow');assert.equal(status.data.summary.trades,0);
 const publicText=JSON.stringify((await f.call('/api/public/status',undefined,false)).data);assert.equal(publicText.includes('shortTermBooks'),false);assert.equal(publicText.includes('shortTermConfig'),false);
});

test('Short-Term occupied Shadow book prevents market changes through ordinary config',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{}});
 vm.runInContext('trendRuntime.get(config.accounts[0]).shortTermBooks={occupied:{position:{positionSize:1}}}',f.ctx);
 const changed=await f.call('/api/config',{symbol:'BTC'});assert.equal(changed.code,400);assert.match(changed.data.error,/Shadow/);assert.equal(vm.runInContext('config.accounts[0].symbol',f.ctx),'ETH');
 const blocked=await f.call('/api/trend-only/short-term/config',{id:'legacy',config:{enabled:false}});
 // The independent endpoint must also check historical occupied books, not only the current hash.
 assert.equal(blocked.code,400);
});
test('4H Compound creates an isolated stopped credential-free Paper account without touching old history',async t=>{
 const f=setup(t),before=vm.runInContext('JSON.stringify(config.accounts[0])',f.ctx);
 assert.equal((await f.call('/api/compound/create',{},false)).code,401);
 const r=await f.call('/api/compound/create',{name:'4H test',config:{allowLive:true}});assert.equal(r.code,200);const id=r.data.id;
 assert.equal(vm.runInContext('JSON.stringify(config.accounts[0])',f.ctx),before);
 const status=await f.call('/api/compound/status?id='+id);assert.equal(status.code,200);assert.equal(status.data.account.strategyType,'compound_4h_v1');assert.equal(status.data.running,false);assert.equal(status.data.config.allowLive,false);assert.equal(status.data.book.equity,10000);assert.equal(status.data.history.length,0);assert.equal(status.data.account.hasPrivateKey,false);assert.equal(status.data.account.hasApiKey,false);assert.equal(status.data.statistics.netPnl,null);
 assert.equal((await f.call('/api/compound/status?id='+id,undefined,false)).code,401);
});
test('4H generic start/manual/reset/config routes never fall through to classic execution',async t=>{
 const f=setup(t),r=await f.call('/api/compound/create',{}),id=r.data.id;await f.call('/api/account/select',{id});
 assert.equal((await f.call('/api/manual-order',{amountU:100})).code,400);assert.equal((await f.call('/api/reset',{})).code,400);
 assert.equal((await f.call('/api/config',{tradeMode:'live'})).code,400);
 assert.equal((await f.call('/api/trend-only/config',{accountId:id,strategyType:'trend_only_v3',config:{}})).code,400);
 const start=await f.call('/api/start',{});assert.equal(start.code,200);assert.equal(start.data.strategyType,'compound_4h_v1');await f.call('/api/stop',{});
 vm.runInContext(`config.accounts.find(a=>a.id==='${id}').tradeMode='live';config.accounts.find(a=>a.id==='${id}').simulationEnabled=false`,f.ctx);
 assert.notEqual((await f.call('/api/start',{})).code,200);
});
test('4H cannot be enabled by reusing an old strategy account and risk/parameter bypasses fail closed',async t=>{
 const f=setup(t);assert.equal((await f.call('/api/config',{strategyType:'compound_4h_v1'})).code,400);
 assert.equal((await f.call('/api/compound/create',{config:{riskPerCycle:.5}})).code,400);
 const id=(await f.call('/api/compound/create',{})).data.id;assert.equal((await f.call('/api/compound/config',{id,config:{initialEquity:20000}})).code,400);
 await f.call('/api/compound/start',{id});assert.equal((await f.call('/api/compound/config',{id,config:{}})).code,400);await f.call('/api/compound/stop',{id});
 assert.equal((await f.call('/api/compound/config',{id,config:{maxAdds:4}})).code,400);
});
test('analysis time filters exclude undated legacy rows only when an explicit window is requested',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{}});
 vm.runInContext(`const scopeForTime=v3Scope(TrendOnlyV3.normalizeConfig(config.accounts[0].trendOnlyConfig));stateMap.legacy.profitHistory=[{...scopeForTime,netPnl:2,netR:1,exitTime:Date.now()-1000},{...scopeForTime,netPnl:3,netR:1,exitTime:1000}]`,f.ctx);
 const r=await f.call('/api/trend-only/analytics?from='+String(Date.now()-5000));assert.equal(r.data.summary.trades,1);assert.equal(r.data.summary.netPnl,2);assert.equal((await f.call('/api/trend-only/analytics?from=bad')).code,400);
});
test('启用趋势默认推荐 V2、Paper 并保存 10 倍配置',async t=>{const f=setup(t);const r=await f.call('/api/trend-only/config',{accountId:'legacy',config:{}});assert.equal(r.code,200,JSON.stringify(r));assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v2');assert.equal(vm.runInContext('config.accounts[0].leverage',f.ctx),10);assert.equal(vm.runInContext('config.accounts[0].tradeMode',f.ctx),'simulation');});
test('Trend Only V1 继续可用并可一键升级到 V2',async t=>{const f=setup(t);assert.equal((await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v1',config:{}})).code,200);assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v1');const before=vm.runInContext('({platform:config.accounts[0].platform,symbol:config.accounts[0].symbol,balance:config.accounts[0].simulationBalance,key:config.accounts[0].privateKey})',f.ctx);assert.equal((await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{version:'v2',leverage:10}})).code,200);assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v2');assert.equal(vm.runInContext('config.accounts[0].strategyMode',f.ctx),'Trend Only V2');assert.equal(vm.runInContext('config.accounts[0].trendOnlyConfig.version',f.ctx),'v2');assert.equal(vm.runInContext('config.accounts[0].maxAdds',f.ctx),0);assert.equal(vm.runInContext('config.accounts[0].leverage',f.ctx),10);assert.deepEqual(vm.runInContext('({platform:config.accounts[0].platform,symbol:config.accounts[0].symbol,balance:config.accounts[0].simulationBalance,key:config.accounts[0].privateKey})',f.ctx),before);});
test('V2 chopTransitionMax=52 可正常保存且不依赖旧 maxChop',async t=>{const f=setup(t);const r=await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{chopTransitionMax:52,maxChopToTrade:1}});assert.equal(r.code,200,JSON.stringify(r.data));assert.equal(vm.runInContext('config.accounts[0].trendOnlyConfig.chopTransitionMax',f.ctx),52);assert.equal(vm.runInContext('Object.hasOwn(config.accounts[0].trendOnlyConfig,"maxChopToTrade")',f.ctx),false);});
test('/api/status 返回 Trend Only 统一 executionState 和 executionReason',async t=>{const f=setup(t);assert.equal((await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{}})).code,200);const r=await f.call('/api/status');assert.equal(r.code,200);assert.equal(r.data.state.trendOnly.executionState,'MONITOR_STOPPED');assert.match(r.data.state.trendOnly.executionReason,/停止/);});
test('Trend Only 异常后下一轮成功会清除 activeError 并保留最近错误',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{}});
 await vm.runInContext('(async()=>{trendRuntime.tick=async()=>{throw Error("candles API timeout")};await tickAccount(config.accounts[0])})()',f.ctx);
 let r=await f.call('/api/status');assert.equal(r.data.state.activeError,'candles API timeout');assert.equal(r.data.state.lastError,'candles API timeout');assert.ok(r.data.state.lastErrorAt>0);assert.equal(r.data.state.health.status,'error');
 await vm.runInContext('(async()=>{trendRuntime.tick=async(_acc,st)=>{st.lastAction="趋势有效，等待延续结构确认"};await tickAccount(config.accounts[0])})()',f.ctx);
 r=await f.call('/api/status');assert.equal(r.data.state.activeError,'');assert.equal(r.data.state.lastError,'candles API timeout');assert.equal(r.data.state.health.status,'healthy');
});
test('health 优先区分 riskLock、当前异常与已恢复历史错误',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{}});
 vm.runInContext('Object.assign(stateMap.legacy,{activeError:"",lastError:"历史超时",lastErrorAt:123});Object.assign(trendRuntime.get(config.accounts[0]),{riskLock:false,riskLockReason:""})',f.ctx);
 let r=await f.call('/api/status');assert.equal(r.data.state.health.status,'healthy');assert.equal(r.data.state.health.lastError,'历史超时');
 vm.runInContext('Object.assign(trendRuntime.get(config.accounts[0]),{riskLock:true,riskLockReason:"保护止损失败"})',f.ctx);
 r=await f.call('/api/status');assert.equal(r.data.state.health.status,'risk_locked');assert.equal(r.data.state.health.riskLock,true);assert.equal(r.data.state.health.riskLockReason,'保护止损失败');
});
test('classic 成功 tick 清除当前异常但不破坏历史错误',async t=>{
 const f=setup(t);vm.runInContext('Object.assign(stateMap.legacy,{activeError:"旧的当前错误",lastError:"历史错误",lastErrorAt:123});getMarketPrice=async()=>2500',f.ctx);
 await vm.runInContext('tickAccount(config.accounts[0])',f.ctx);
 const r=await f.call('/api/status');assert.equal(r.data.state.activeError,'');assert.equal(r.data.state.lastError,'历史错误');assert.equal(r.data.state.health.status,'healthy');
});
test('历史接口标记旧记录并可靠推导持仓时长',async t=>{const f=setup(t);vm.runInContext('stateMap.legacy.profitHistory=[{time:new Date(1600000).toISOString(),entryTime:1000000,exitTime:1600000,symbol:"ETH",side:"long",entryPrice:100,exitPrice:101,pnl:1,netPnl:0.8,tradingFee:0.2}]',f.ctx);const r=await f.call('/api/profit-history?id=legacy');assert.equal(r.code,200);assert.equal(r.data.items[0].legacyRecord,true);assert.equal(r.data.items[0].holdingDurationMs,600000);assert.equal(r.data.items[0].netPnl,0.8);assert.equal(r.data.items[0].maximumAdverseExcursion,undefined);});
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
test('/api/public/status 对 Trend Only 内部 journal 与订单字段严格脱敏',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{}});
 vm.runInContext('Object.assign(trendRuntime.get(config.accounts[0]),{signalJournal:[{time:1,executionBlocker:"secret"}],stopOrderId:"stop-secret",riskLockReason:"risk-secret",trendContext:{internal:true},signal:{regime:"trend",directionRaw:"long",tradeDirection:"long"}})',f.ctx);
 const r=await f.call('/api/public/status?id=legacy',undefined,false),text=JSON.stringify(r.data);
 assert.equal(r.code,200);for(const field of ['signalJournal','stopOrderId','clientOrderId','trendContext','riskLockReason','executionBlocker'])assert.equal(text.includes(field),false,field);
 assert.deepEqual(Object.keys(r.data.state.trendOnly).sort(),['direction','hasPosition','marketStage','marketStatus','nextAction','pnl','roi','running','tradeDirection','updatedAt'].sort());
});
test('/api/status 仅返回 50 条 journal，分页接口可读取完整历史',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{}});
 vm.runInContext('trendRuntime.get(config.accounts[0]).signalJournal=Array.from({length:80},(_,i)=>({time:i+1,finalDecision:i%2?"NO_SIGNAL":"READY_TO_OPEN"}))',f.ctx);
 const status=await f.call('/api/status');assert.equal(status.data.state.trendOnly.signalJournal.length,50);
 const page=await f.call('/api/trend-only/signal-journal?id=legacy&limit=20&offset=50');assert.equal(page.code,200);assert.equal(page.data.total,80);assert.equal(page.data.items.length,20);assert.equal(page.data.items[0].time,30);
 assert.equal((await f.call('/api/trend-only/signal-journal?id=legacy',undefined,false)).code,401);
});
test('旧明文管理员密码首次成功登录后迁移为 scrypt hash，并限制连续失败',async t=>{
 const f=setup(t),ok=await f.call('/api/login',{username:'test',password:'test'},false);assert.equal(ok.code,200);assert.match(ok.headers['Set-Cookie'],/HttpOnly; SameSite=Lax/);
 const migrated=JSON.parse(fs.readFileSync(path.join(f.directory,'auth.json'),'utf8'));assert.match(migrated.passwordHash,/^scrypt\$/);assert.equal('adminPassword'in migrated,false);
 for(let i=0;i<5;i++)assert.equal((await f.call('/api/login',{username:'test',password:'bad'},false)).code,401);
 assert.equal((await f.call('/api/login',{username:'test',password:'bad'},false)).code,429);
});
test('生产环境登录 Cookie 强制 Secure、HttpOnly 与 SameSite=Lax',async t=>{
 const f=setup(t,{NODE_ENV:'production',TRUST_PROXY:'true'}),r=await f.call('/api/login',{username:'test',password:'test'},false);assert.equal(r.code,200);
 assert.match(r.headers['Set-Cookie'],/HttpOnly; SameSite=Lax; Secure/);
});
test('V3 策略分析接口按版本、实验与配置隔离并使用净值统计',async t=>{
 const f=setup(t);const enabled=await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{experimentId:'A'}});assert.equal(enabled.code,200,JSON.stringify(enabled.data));
 vm.runInContext(`stateMap.legacy.profitHistory=[
  {strategyVersion:'trend_only_v3',experimentId:'A',configHash:'h1',entryMode:'pullback_entry',exitTime:1,netPnl:10,netR:1,tradingFee:1},
  {strategyVersion:'trend_only_v3',experimentId:'A',configHash:'h1',entryMode:'pullback_entry',exitTime:2,netPnl:-5,netR:-.5,tradingFee:1},
  {strategyVersion:'trend_only_v3',experimentId:'B',configHash:'h2',entryMode:'breakout_entry',exitTime:3,netPnl:99,netR:9},
  {strategyVersion:'trend_only_v2',experimentId:'A',configHash:'h1',entryMode:'pullback_entry',exitTime:4,netPnl:99,rMultiple:9}
 ]`,f.ctx);
 const r=await f.call('/api/trend-only/analytics?id=legacy&experimentId=A&configHash=h1&strategyRevision=all');assert.equal(r.code,200,JSON.stringify(r.data));
 assert.equal(r.data.summary.trades,2);assert.equal(r.data.summary.netPnl,5);assert.equal(r.data.summary.avgNetR,.25);assert.equal(r.data.modes.pullback_entry.trades,2);assert.equal(r.data.modes.breakout_entry.trades,0);
 assert.equal((await f.call('/api/trend-only/analytics?id=legacy',undefined,false)).code,401);
});
test('V3 Post Exit 更新按凭证键合并，不会制造重复历史',async t=>{
 const f=setup(t);vm.runInContext(`addProfitHistory('legacy',{dedupeKey:'v3-1',strategyVersion:'trend_only_v3',exitTime:1000,netPnl:1});addProfitHistory('legacy',{dedupeKey:'v3-1',strategyVersion:'trend_only_v3',exitTime:1000,netPnl:1,PostExitMFE_8:2,postExitAnalyticsPostHocOnly:true})`,f.ctx);
 const r=await f.call('/api/profit-history?id=legacy');assert.equal(r.code,200);assert.equal(r.data.items.length,1);assert.equal(r.data.items[0].PostExitMFE_8,2);assert.equal(r.data.items[0].postExitAnalyticsPostHocOnly,true);
});

test('Forward Test API defaults exclude old revisions and preserve old history explicitly',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{}});
 vm.runInContext(`const forwardScope=v3Scope(TrendOnlyV3.normalizeConfig(config.accounts[0].trendOnlyConfig));stateMap.legacy.profitHistory=[{...forwardScope,entryMode:'pullback_entry',netPnl:2,netR:1},{...forwardScope,strategyRevision:'V3_20261009_STRUCTURE',netPnl:-5,netR:-2},{...forwardScope,strategyRevision:undefined,netPnl:-7,netR:-3}]`,f.ctx);
 const analysis=await f.call('/api/trend-only/analytics');assert.equal(analysis.code,200);assert.equal(analysis.data.summary.trades,1);assert.equal(analysis.data.strategyRevision,require('../strategy/trend_v3/scope').REVISION);assert.equal(analysis.data.experimentId,'V3_STD_20261015_C');assert.equal(analysis.data.forward.modeFunnel.breakout_entry.Filled,0);
 assert.equal(analysis.data.forward.independentShadows.V3_COST_TIGHT.initialized,false);assert.match(analysis.data.forward.independentShadows.V3_COST_TIGHT.message,/尚未形成有效样本/);
 const history=await f.call('/api/profit-history?id=legacy');assert.equal(history.data.items.length,1);
 const all=await f.call('/api/profit-history?id=legacy&strategyVersion=all&strategyRevision=all');assert.equal(all.data.items.length,3);
 assert.equal((await f.call('/api/trend-only/analytics',undefined,false)).code,401);
 const publicStatus=JSON.stringify((await f.call('/api/public/status',undefined,false)).data);for(const key of ['modeAudit','shadowBooks','portfolioRiskKey','PostStopMFE','signalJournal'])assert.equal(publicStatus.includes('"'+key+'"'),false);
});

test('停止后切换 V2 到 V3 会强制 Paper、发布真实引擎并清除瞬时状态',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{version:'v2'}});
 vm.runInContext('Object.assign(trendRuntime.get(config.accounts[0]),{signal:{directionRaw:"short"},preview:{qty:1},executionState:"READY_TO_OPEN",executionReason:"old",strategyState:"READY",candidateSetup:{grade:"A"},trendContext:{trendId:"old"},signalJournal:[{time:1}],journal:[{id:"history-1"}],simBalance:9988})',f.ctx);
 const switched=await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{version:'v3'}});assert.equal(switched.code,200,JSON.stringify(switched.data));
 const status=await f.call('/api/status');
 assert.equal(status.data.config.strategyType,'trend_only_v3');assert.equal(status.data.config.strategyMode,'Trend Only V3');assert.equal(status.data.config.trendOnlyConfig.version,'v3');
 assert.equal(status.data.config.tradeMode,'simulation');assert.equal(status.data.config.simulationEnabled,true);
 assert.deepEqual(status.data.strategyRuntime,{configuredType:'trend_only_v3',configuredVersion:'v3',activeEngine:'TrendOnlyV3',engineVersion:'v3',running:false,versionMismatch:false});
 const runtime=vm.runInContext('trendRuntime.get(config.accounts[0])',f.ctx);assert.equal(runtime.signal,undefined);assert.equal(runtime.preview,undefined);assert.equal(runtime.candidateSetup,undefined);assert.equal(runtime.trendContext,null);assert.equal(runtime.strategyState,'SCANNING');assert.equal(runtime.signalJournal.length,1);assert.equal(runtime.journal.length,1);assert.equal(runtime.simBalance,9988);
});

test('趋势版本切换对持仓、pending 与 unknown order 全部 fail closed',async t=>{
 for(const setupState of ['position','pending','unknown']){
  const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v2',config:{version:'v2'}});
  vm.runInContext(setupState==='position'?'trendRuntime.get(config.accounts[0]).position={positionSize:1}':setupState==='pending'?'trendRuntime.get(config.accounts[0]).pendingOrder={status:"submitted"}':'trendRuntime.get(config.accounts[0]).pendingOrder={status:"unknown_order_state"}',f.ctx);
  const r=await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{version:'v3'}});assert.equal(r.code,400,setupState);assert.equal(vm.runInContext('config.accounts[0].strategyType',f.ctx),'trend_only_v2');
 }
});

test('配置与运行时引擎版本不一致时状态告警且禁止启动',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{version:'v3'}});
 vm.runInContext('trendRuntime.get(config.accounts[0]).engineVersion="v2"',f.ctx);
 const status=await f.call('/api/status');assert.equal(status.data.strategyRuntime.activeEngine,'TrendOnlyV2');assert.equal(status.data.strategyRuntime.versionMismatch,true);assert.equal(status.data.state.trendOnly.executionState,'STRATEGY_VERSION_MISMATCH');
 const start=await f.call('/api/start',{});assert.equal(start.code,409);assert.match(start.data.error,/禁止启动/);assert.equal(vm.runInContext('stateMap.legacy.running',f.ctx),false);
});

test('/api/start 返回实际 Trend Only 版本、模式与运行状态',async t=>{
 const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{version:'v3'}});
 const r=await f.call('/api/start',{});assert.equal(r.code,200);assert.equal(r.data.strategyType,'trend_only_v3');assert.equal(r.data.strategyMode,'Trend Only V3');assert.equal(r.data.strategyVersion,'v3');assert.equal(r.data.running,true);assert.match(r.data.message,/Paper/);
});

test('普通配置保存 classic/smart 到 V1/V2/V3 均初始化正确引擎',async t=>{
 for(const source of ['classic','smart_regime_v1']) for(const version of ['v1','v2','v3']) {
  const f=setup(t);vm.runInContext(`config.accounts[0].strategyType=${JSON.stringify(source)};saveConfig(config);trendRuntime.busy(config.accounts[0])`,f.ctx);
  const saved=await f.call('/api/config',{strategyType:'trend_only_'+version,strategyMode:'Trend Only '+version.toUpperCase(),symbol:'BTC',trendOnlyConfig:{version},privateKey:'',apiSecret:'',starkPrivateKey:''});
  assert.equal(saved.code,200,JSON.stringify(saved.data));
  const status=await f.call('/api/status');assert.equal(status.data.strategyRuntime.engineVersion,version);assert.equal(status.data.strategyRuntime.versionMismatch,false);
  assert.equal(status.data.config.symbol,'BTC');assert.equal(status.data.config.hasPrivateKey,true);
  assert.equal(vm.runInContext('config.accounts[0].apiSecret',f.ctx),'secret');
  assert.equal(status.data.state.running,false);
  const start=await f.call('/api/start',{});assert.equal(start.code,200,JSON.stringify(start.data));
 }
});

test('创建账户默认 V2 后保存 BTC V3 不留下 V2 引擎',async t=>{
 const f=setup(t);const created=await f.call('/api/account/create',{name:'BTC-paper',platform:'extended'});assert.equal(created.code,200);
 await f.call('/api/status'); // Dashboard initialization before config save.
 const saved=await f.call('/api/config',{strategyType:'trend_only_v3',symbol:'BTC',quoteAsset:'USDC',trendOnlyConfig:{version:'v3'}});assert.equal(saved.code,200,JSON.stringify(saved.data));
 const status=await f.call('/api/status');assert.equal(status.data.strategyRuntime.engineVersion,'v3');assert.equal(status.data.strategyRuntime.versionMismatch,false);assert.equal(status.data.state.running,false);
});

test('停止后显式保存可修复旧 V3/V1 标记并保留余额、历史与风控锁',async t=>{
 for(const endpoint of ['/api/config','/api/trend-only/config']){
  const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{version:'v3'}});
  vm.runInContext('Object.assign(trendRuntime.get(config.accounts[0]),{engineVersion:"v1",journal:[{id:"keep-history"}],signalJournal:[{time:1}],simBalance:9988,riskLock:true,riskLockReason:"保留保护锁"})',f.ctx);
  const before=await f.call('/api/start',{});assert.equal(before.code,409);
  const body=endpoint==='/api/config'?{strategyType:'trend_only_v3',trendOnlyConfig:{version:'v3'}}:{accountId:'legacy',strategyType:'trend_only_v3',config:{version:'v3'}};
  const saved=await f.call(endpoint,body);assert.equal(saved.code,200,JSON.stringify(saved.data));
  const status=await f.call('/api/status');assert.equal(status.data.strategyRuntime.engineVersion,'v3');assert.equal(status.data.strategyRuntime.versionMismatch,false);assert.equal(status.data.state.running,false);
  const s=vm.runInContext('trendRuntime.get(config.accounts[0])',f.ctx);assert.equal(s.simBalance,9988);assert.equal(s.journal[0].id,'keep-history');assert.equal(s.signalJournal[0].time,1);assert.equal(s.riskLock,true);assert.equal(s.riskLockReason,'保留保护锁');
 }
});

test('普通配置保存不能利用引擎修复绕过运行、持仓或待确认订单',async t=>{
 for(const kind of ['running','position','pending','unknown']){
  const f=setup(t);await f.call('/api/trend-only/config',{accountId:'legacy',strategyType:'trend_only_v3',config:{version:'v3'}});
  vm.runInContext('trendRuntime.get(config.accounts[0]).engineVersion="v1"',f.ctx);
  vm.runInContext(kind==='running'?'config.accounts[0].running=true;stateMap.legacy.running=true;saveConfig(config)':kind==='position'?'trendRuntime.get(config.accounts[0]).position={positionSize:1}':`trendRuntime.get(config.accounts[0]).pendingOrder={status:${JSON.stringify(kind==='unknown'?'unknown_order_state':'submitted')}}`,f.ctx);
  const saved=await f.call('/api/config',{strategyType:'trend_only_v3',trendOnlyConfig:{version:'v3'}});assert.equal(saved.code,400,kind);
  assert.equal(vm.runInContext('trendRuntime.get(config.accounts[0]).engineVersion',f.ctx),'v1');
 }
});
