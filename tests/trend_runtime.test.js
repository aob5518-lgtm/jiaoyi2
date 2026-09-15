const {test}=require('node:test'), assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const T=require('../trend_only'),V2=require('../trend_only_v2'),{createTrendRuntime}=require('../trend_runtime');
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
    request:async(u,o)=>{const b=JSON.parse(o.body);if(b.type==='openOrders')return[];if(b.type==='orderStatus')return{status:'unknownOid'};throw Error('unexpected request');}
  };
  return {acc,st,d,history,directory,r:createTrendRuntime(d),orders:()=>orders};
}
test('Paper 完整开仓、止损和历史写入，重启不重复凭证',async t=>{
  const f=fixture(t);await f.r.tick(f.acc,f.st);assert.ok(f.r.get(f.acc).position, f.st.lastAction);
  f.d.price=async()=>50;f.r=createTrendRuntime(f.d);await f.r.tick(f.acc,f.st);assert.equal(f.r.get(f.acc).position,null);assert.equal(f.history.length,1);assert.equal(f.history[0].closeReason,'hard_sl');
  f.st.running=false;f.r=createTrendRuntime(f.d);await f.r.tick(f.acc,f.st);assert.equal(f.history.length,1);
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
  const f=fixture(t);f.acc.strategyType='trend_only_v2';f.acc.trendOnlyConfig=V2.normalizeConfig({allowWeekendOpen:true});
  await f.r.tick(f.acc,f.st);const state=f.r.get(f.acc);
  assert.equal(state.signalJournal.length,1);assert.ok(state.trendContext);assert.equal(f.st.trendOnly.signalJournal.length,1);
});
