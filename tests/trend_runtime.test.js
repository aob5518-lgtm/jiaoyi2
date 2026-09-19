const {test}=require('node:test'), assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const T=require('../trend_only'),V2=require('../trend_only_v2'),{createTrendRuntime,paperStopFill}=require('../trend_runtime');
function fixture(t,live=false){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'trend-v1-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const acc={id:'a',name:'paper',platform:'hyperliquid',symbol:'ETH',address:'0xTEST',simulationBalance:10000,trendOnlyConfig:T.normalizeConfig({allowWeekendOpen:true})};
  const st={running:true,balance:10000,available:10000,currentPrice:100}, history=[]; let orders=0, outcome={terminal:false};
  const candles=(symbol,tf)=>{
    const ms=T.INTERVALS[tf],now=Math.floor(Date.now()/ms)*ms;
    return {candles:Array.from({length:260},(_,j)=>{
      const center=100+Math.sin(j*.7)*2+(j>230?(j-230)**2*.02:0);return{time:now-(260-j)*ms,open:center-.1,close:center+.1,high:center+.3,low:center-.3};
    })};
  };
  const d={directory,isPaper:()=>!live,log:()=>{},history:(id,v)=>{if(!history.some(x=>x.id===v.id))history.push(v);},price:async()=>120,candles:async(...a)=>candles(...a),
    hyperMeta:async()=>({meta:{szDecimals:3}}),hyperLeverage:async()=>{},hyperOrder:async()=>{orders++;throw Error('timeout');},
    hyperAccount:async()=>({balance:10000,available:10000,rawPerp:{marginSummary:{accountValue:10000},withdrawable:10000},currentPos:null}),
    request:async(u,o)=>{const b=JSON.parse(o.body);if(b.type==='frontendOpenOrders')return[];if(b.type==='orderStatus')return{status:'unknownOid'};throw Error('unexpected request');}
  };
  return {acc,st,d,history,directory,r:createTrendRuntime(d),orders:()=>orders};
}
function v2Position(){return{side:'long',entryPrice:100,initialStopLossPrice:98,currentStopLossPrice:98,positionSize:1,positionValue:100,leverage:10,config:V2.normalizeConfig({allowWeekendOpen:true}),signalTime:Date.now()-900000,highestPriceSinceEntry:100,lowestPriceSinceEntry:100};}
test('Paper 完整开仓、止损和历史写入，重启不重复凭证',async t=>{
  const f=fixture(t);await f.r.tick(f.acc,f.st);assert.ok(f.r.get(f.acc).position, f.st.lastAction);
  f.d.price=async()=>50;f.r=createTrendRuntime(f.d);await f.r.tick(f.acc,f.st);assert.equal(f.r.get(f.acc).position,null);assert.equal(f.history.length,1);assert.equal(f.history[0].closeReason,'hard_sl');
  f.st.running=false;f.r=createTrendRuntime(f.d);await f.r.tick(f.acc,f.st);assert.equal(f.history.length,1);
});
test('Paper stop 正常触发按止损价和 5bps 成交，不使用滞后 currentPrice',()=>{
  const fill=paperStopFill({side:'long',stopPrice:2506,currentPrice:2501,previousPrice:2507,slippageBps:5});
  assert.equal(fill.stopExecutionMode,'normal_trigger');assert.equal(fill.stopTriggerPrice,2506);assert.equal(fill.stopExecutionPrice,2504.747);assert.equal(fill.stopSlippageBps,5);assert.equal(fill.stopSlippageAmount,1.253);
});
test('Paper stop 明显 gap through 保留跳空价格滑点',()=>{
  const longFill=paperStopFill({side:'long',stopPrice:100,currentPrice:95,previousPrice:101,slippageBps:5});
  assert.equal(longFill.stopExecutionMode,'gap_through');assert.equal(longFill.stopExecutionPrice,94.9525);
  const shortFill=paperStopFill({side:'short',stopPrice:100,currentPrice:105,previousPrice:99,slippageBps:5});
  assert.equal(shortFill.stopExecutionMode,'gap_through');assert.equal(shortFill.stopExecutionPrice,105.0525);
});
test('Paper 保护止损成交凭证记录触发价、成交价和执行模式',async t=>{
  const f=fixture(t);const s=f.r.get(f.acc);s.position=v2Position();s.position.currentStopLossPrice=98;s.lastMarketPrice=100;f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true,paperStopSlippageBps:5});f.d.price=async()=>97.9;
  await f.r.tick(f.acc,f.st);assert.equal(f.history.length,1);const voucher=f.history[0];
  assert.equal(voucher.stopTriggerPrice,98);assert.equal(voucher.stopExecutionPrice,97.951);assert.equal(voucher.stopSlippageBps,5);assert.equal(voucher.stopSlippageAmount,0.049);assert.equal(voucher.stopExecutionMode,'normal_trigger');
});
test('Live 不确认不下单；过期或错误信号确认拒绝',async t=>{
  const f=fixture(t,true);await f.r.tick(f.acc,f.st);assert.equal(f.orders(),0);assert.match(f.st.lastAction,/二次确认/);assert.throws(()=>f.r.confirm(f.acc,{confirmLive:true,signalTime:0}),/无效/);
});
test('Live 确认后超时持久化 unknown，重启先查询绝不重试提交',async t=>{
  const f=fixture(t,true);await f.r.tick(f.acc,f.st);const p=f.r.get(f.acc).preview;assert.ok(p);
  f.r.confirm(f.acc,{confirmLive:true,signalTime:p.signal.signalTime,configHash:p.configHash});await f.r.tick(f.acc,f.st);
  assert.equal(f.orders(),1);assert.equal(f.r.get(f.acc).pendingOrder.status,'unknown_order_state');
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'trend_only_runtime.json'),'utf8'));assert.ok(saved.a.pendingOrder.clientOrderId);
  f.r=createTrendRuntime(f.d);await f.r.tick(f.acc,f.st);await f.r.tick(f.acc,f.st);assert.equal(f.orders(),1);assert.ok(f.r.get(f.acc).pendingOrder);
});
test('停止状态和行情接口故障不妨碍已有硬止损',async t=>{
  const f=fixture(t);await f.r.tick(f.acc,f.st);f.st.running=false;f.d.price=async()=>50;f.d.candles=async()=>{throw Error('offline');};f.r=createTrendRuntime(f.d);await f.r.tick(f.acc,f.st);assert.equal(f.history.length,1);
});
test('损坏运行态必须拒绝启动',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.directory,'trend_only_runtime.json'),'{broken');assert.throws(()=>createTrendRuntime(f.d));});
test('写入意图失败不得调用交易所下单',async t=>{
  const f=fixture(t,true);await f.r.tick(f.acc,f.st);const p=f.r.get(f.acc).preview;f.r.confirm(f.acc,{confirmLive:true,signalTime:p.signal.signalTime,configHash:p.configHash});
  fs.mkdirSync(path.join(f.directory,'trend_only_runtime.json.tmp'));await assert.rejects(()=>f.r.tick(f.acc,f.st));assert.equal(f.orders(),0);
});
test('V2 每根已收盘 K 线写入信号回放并发布趋势记忆',async t=>{
  const f=fixture(t);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true,maxEntryExtensionAtr:100,maxStopDistanceAtr:100,minStopDistanceAtr:0.1});
  await f.r.tick(f.acc,f.st);const state=f.r.get(f.acc);
  assert.equal(state.signalJournal.length,1);assert.ok(state.trendContext);assert.equal(f.st.trendOnly.signalJournal.length,1);
  const item=state.signalJournal[0];assert.equal(item.signalPermission,item.entryPermission);assert.ok(item.executionPermission);assert.ok(item.finalDecision);
  assert.equal(item.finalDecision,'ORDER_FILLED');assert.equal(item.orderSubmitted,true);assert.equal(item.orderFilled,true);
  assert.equal(f.st.trendOnly.executionState,'POSITION_MANAGED');
  await f.r.tick(f.acc,f.st);assert.equal(item.finalDecision,'POSITION_MANAGED');assert.equal(item.executionPermission,'allowed');assert.equal(item.orderFilled,true);
});
test('V2 信号允许但监控停止时记录执行阻断，不误报可开仓',async t=>{
  const f=fixture(t);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});f.st.running=false;
  await f.r.tick(f.acc,f.st);const item=f.r.get(f.acc).signalJournal[0];
  assert.equal(item.finalDecision,'MONITOR_STOPPED');assert.equal(item.executionPermission,'blocked');assert.match(item.executionBlocker,/监控已停止/);
  assert.equal(f.st.trendOnly.executionState,'MONITOR_STOPPED');
});
test('V2 Live 信号通过但未确认时区分信号机会和执行许可',async t=>{
  const f=fixture(t,true);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true,maxEntryExtensionAtr:100});
  await f.r.tick(f.acc,f.st);const item=f.r.get(f.acc).signalJournal[0];
  assert.equal(item.signalPermission,'allowed');assert.equal(item.executionPermission,'blocked');assert.equal(item.finalDecision,'WAIT_LIVE_CONFIRM');
  assert.equal(f.st.trendOnly.executionState,'WAIT_LIVE_CONFIRM');assert.match(f.st.trendOnly.executionReason,/二次确认/);
});
test('统一 executionState 覆盖风控、平台、冲突、挂单、冷却与已有仓位',t=>{
  const f=fixture(t,true);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});const s=f.r.get(f.acc);
  s.riskLock=true;s.riskLockReason='保护单失败';f.r.publish(f.acc,f.st);assert.equal(f.st.trendOnly.executionState,'RISK_LOCK');
  s.riskLock=false;f.acc.platform='extended';f.r.publish(f.acc,f.st);assert.equal(f.st.trendOnly.executionState,'PLATFORM_UNSUPPORTED');
  f.acc.platform='hyperliquid';f.d.conflictingAccount=()=>true;f.r.publish(f.acc,f.st);assert.equal(f.st.trendOnly.executionState,'ACCOUNT_CONFLICT');
  f.d.conflictingAccount=()=>false;s.conflictingAccount=false;s.exchangeOpenOrders=true;f.r.publish(f.acc,f.st);assert.equal(f.st.trendOnly.executionState,'OPEN_ORDER_BLOCK');
  s.exchangeOpenOrders=false;s.pauseUntil=Date.now()+60000;f.r.publish(f.acc,f.st);assert.equal(f.st.trendOnly.executionState,'RISK_LOCK');
  s.pauseUntil=0;s.position=v2Position();f.r.publish(f.acc,f.st);assert.equal(f.st.trendOnly.executionState,'POSITION_MANAGED');
});
test('V2 Paper 模拟保护止损，不请求交易所',async t=>{
  const f=fixture(t);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});f.r.get(f.acc).position=v2Position();
  assert.equal(await f.r.syncProtection(f.acc,f.st),true);const s=f.r.get(f.acc);
  assert.match(s.stopOrderId,/paper-stop/);assert.equal(s.stopSyncStatus,'synced');assert.equal(s.riskLock,false);
});
test('V2 Hyper Live 同步原生保护止损，失败进入 risk_lock',async t=>{
  const f=fixture(t,true);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});f.r.get(f.acc).position=v2Position();
  f.d.hyperStop=async()=>({orderId:'9001',stopPrice:98});f.d.hyperCancel=async()=>({ok:true});
  assert.equal(await f.r.syncProtection(f.acc,f.st),true);assert.equal(f.r.get(f.acc).stopOrderId,'9001');
  f.r.get(f.acc).position.currentStopLossPrice=99;f.d.hyperStop=async()=>{throw Error('stop unavailable');};
  assert.equal(await f.r.syncProtection(f.acc,f.st),false);assert.equal(f.r.get(f.acc).riskLock,true);assert.equal(f.r.get(f.acc).stopSyncStatus,'failed');
});
test('V2 Binance Live 通过 Algo API 创建 STOP_MARKET reduceOnly 保护单',async t=>{
  const f=fixture(t,true);f.acc.strategyType='trend_only_v2';f.acc.platform='binance';f.acc.apiKey='key';f.acc.apiSecret='secret';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});f.r.get(f.acc).position=v2Position();
  f.d.binanceMeta=async()=>({symbol:'ETHUSDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.001'}]});
  const calls=[];f.d.request=async(url,options)=>{calls.push({url,options});if(url.includes('positionSide/dual'))return{dualSidePosition:false};if(options?.method==='POST')return{algoId:321,algoStatus:'NEW'};return{};};
  assert.equal(await f.r.syncProtection(f.acc,f.st),true);assert.equal(f.r.get(f.acc).stopOrderId,'321');
  assert.ok(calls.some(call=>call.url.includes('/fapi/v1/algoOrder')&&call.url.includes('type=STOP_MARKET')&&call.url.includes('triggerPrice=')&&call.url.includes('reduceOnly=true')));
  f.r.get(f.acc).position.currentStopLossPrice=99;
  f.d.request=async(url,options)=>{if(url.includes('positionSide/dual'))return{dualSidePosition:false};if(options?.method==='POST')return{algoStatus:'REJECTED'};return{};};
  assert.equal(await f.r.syncProtection(f.acc,f.st),false);assert.equal(f.r.get(f.acc).riskLock,true);
});

test('V2 状态只发布最近 50 条 journal，运行时分页仍能读取完整历史',t=>{
  const f=fixture(t);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});const s=f.r.get(f.acc);
  s.signalJournal=Array.from({length:80},(_,index)=>({time:index+1,finalDecision:index%2?'NO_SIGNAL':'READY_TO_OPEN'}));
  f.r.publish(f.acc,f.st);
  assert.equal(f.st.trendOnly.signalJournal.length,50);
  const page=f.r.signalJournal(f.acc,{limit:20,offset:50});assert.equal(page.total,80);assert.equal(page.items.length,20);assert.equal(page.items[0].time,30);
  assert.equal(f.r.signalJournal(f.acc,{finalDecision:'READY_TO_OPEN'}).total,40);
});

test('新保护止损成功但旧单撤销失败时记录 orphan，并可重试清理',async t=>{
  const f=fixture(t,true);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});const s=f.r.get(f.acc);s.position=v2Position();
  let nextId=9001,cancelFails=true;f.d.hyperStop=async()=>({orderId:String(nextId++),stopPrice:s.position.currentStopLossPrice});f.d.hyperCancel=async()=>{if(cancelFails)throw Error('cancel timeout');return{ok:true};};
  assert.equal(await f.r.syncProtection(f.acc,f.st),true);s.position.currentStopLossPrice=99;
  assert.equal(await f.r.syncProtection(f.acc,f.st),true);assert.deepEqual(s.orphanStopOrderIds,['9001']);assert.equal(s.stopProtectionHealth,'ORPHAN_ORDER');
  await f.r.reconcileProtection(f.acc,{openOrders:[{oid:'9001'}]});assert.deepEqual(s.orphanStopOrderIds,['9001']);
  cancelFails=false;await f.r.reconcileProtection(f.acc,{openOrders:[{oid:'9001'}]});assert.deepEqual(s.orphanStopOrderIds,[]);assert.equal(s.stopProtectionHealth,'HEALTHY');
});
test('成交后实际风险超过计划 15% 会进入 POST_FILL_RISK_LOCK',t=>{
  const f=fixture(t);f.acc.strategyType='trend_only_v2';const s=f.r.get(f.acc);s.position={...v2Position(),postFillRiskExceeded:true,actualRiskAmount:116,plannedRiskAmount:100};
  assert.equal(f.r.enforcePostFillRisk(f.acc),true);assert.equal(s.riskLock,true);assert.equal(s.riskLockType,'POST_FILL_RISK_LOCK');
  f.r.publish(f.acc,f.st);assert.equal(f.st.trendOnly.executionState,'POST_FILL_RISK_LOCK');
});
