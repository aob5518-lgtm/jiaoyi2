const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../trend_only');
const now = Date.parse('2026-09-14T12:00:00Z');
function fixture(side='long') {
  const s=T.initialState(), c=T.normalizeConfig({});
  const a={id:'test',name:'测试',platform:'hyperliquid',symbol:'ETH',quoteAsset:'USDC',paper:true,equity:10000,available:10000,trendOnlyState:s,trendOnlyConfig:c};
  const i={now,config:c,price:100,close:100,atr:2,chop:35,adx:32,adxHistory:[28,30,32],emaFast:98,emaMid:95,emaSlope:1,diPlus:30,diMinus:10,breakoutHigh:99,breakoutLow:90,trendDirection:side,higherDirection:side,signalTime:now-900000};
  if(side==='short')Object.assign(i,{close:100,emaFast:102,emaMid:105,emaSlope:-1,diPlus:10,diMinus:30,breakoutHigh:110,breakoutLow:101});
  const signal=T.detectMarketRegime([],i), plan=T.tryOpenTrendOnlyPosition(a,signal,i);
  return {a,s,c,i,signal,plan};
}
function opened(side='long') {const f=fixture(side); f.s.position=T.positionFromFill(f.plan,{qty:f.plan.qty,price:100,clientOrderId:'entry',exchangeOrderId:'1'},now,f.c);return f;}
for(const date of ['2026-09-12T12:00:00Z','2026-09-13T12:00:00Z'])test(`周末禁开 ${date}`,()=>{const f=fixture();assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,{...f.i,now:Date.parse(date)}).allowed,false);});
for(const side of ['long','short']) {
  test(`${side} 趋势按方向开仓和风险限额`,()=>{const f=fixture(side);assert.equal(f.plan.allowed,true);assert.equal(f.plan.side,side);assert.ok(f.plan.qty*(f.plan.stopDistance+0.2)<=100.000001);assert.equal(f.plan.leverage,10);});
  test(`${side} 1R 保本、2R 锁利、3R 移动止盈且不回退`,()=>{
    const f=opened(side),sign=side==='long'?1:-1,p=f.s.position;
    T.manageTrendOnlyPosition(f.a,{price:100+sign*3,now},f.i);assert.equal(p.currentStopLossPrice,100);assert.equal(p.breakEvenActivated,true);
    T.manageTrendOnlyPosition(f.a,{price:100+sign*6,now},f.i);assert.equal(p.currentStopLossPrice,100+sign*3);
    T.manageTrendOnlyPosition(f.a,{price:100+sign*9,now},f.i);assert.equal(p.trailingActive,true);const stop=p.currentStopLossPrice;
    T.manageTrendOnlyPosition(f.a,{price:100+sign*9,now},{...f.i,atr:20});assert.equal(p.currentStopLossPrice,stop);
  });
  test(`${side} 硬止损`,()=>{const f=opened(side);assert.equal(T.manageTrendOnlyPosition(f.a,{price:side==='long'?96:104,now},f.i).reason,'hard_sl');});
  test(`${side} 结构止损`,()=>{const f=opened(side);assert.equal(T.manageTrendOnlyPosition(f.a,{price:100,now},{...f.i,signalTime:now,close:side==='long'?98:102}).reason,'structure_sl');});
}
test('周末已有仓位仍执行止损和移动止盈',()=>{const f=opened(),sat=Date.parse('2026-09-19T12:00:00Z');assert.equal(T.manageTrendOnlyPosition(f.a,{price:96,now:sat},f.i).reason,'hard_sl');T.manageTrendOnlyPosition(f.a,{price:112,now:sat},f.i);assert.equal(f.s.position.trailingActive,true);});
test('默认周末不执行结构、时间或普通衰减退出',()=>{const f=opened(),sat=Date.parse('2026-09-19T12:00:00Z'),i={...f.i,signalTime:now+20*900000,close:98,adxHistory:[35,32,28],chop:60,higherDirection:'none'};assert.equal(T.manageTrendOnlyPosition(f.a,{price:101,now:sat},i).reason,'');});
for(const [name,change] of [['CHOP 过高',{chop:68}],['ADX 过低',{adx:19}],['ADX 未连续上升',{adxHistory:[32,31,32]}],['多周期不一致',{higherDirection:'short'}],['方向冲突不默认做多',{diPlus:10,diMinus:10}],['缺少指标',{atr:NaN}],['无突破',{close:99}]])test(name,()=>{const f=fixture();const signal=T.detectMarketRegime([],{...f.i,...change});assert.equal(signal.direction,'none');assert.notEqual(signal.regime,'trend');});
test('时间止损',()=>{const f=opened();assert.equal(T.manageTrendOnlyPosition(f.a,{price:100.5,now:now+8*900000},{...f.i,signalTime:now+8*900000}).reason,'time_stop');});
test('趋势反转',()=>{const f=opened();assert.equal(T.manageTrendOnlyPosition(f.a,{price:101,now},{...f.i,signalTime:now,diMinus:50}).reason,'trend_reversal');});
test('周五保护默认 UTC 20 点',()=>{const f=opened();f.s.position.config.weekendMode='force_flat_before_weekend';assert.equal(T.manageTrendOnlyPosition(f.a,{price:101,now:Date.parse('2026-09-18T20:00:00Z')},f.i).reason,'weekend_exit');});
test('日亏损上限阻止开仓',()=>{const f=fixture();f.s.dailyDate='2026-09-14';f.s.dayStartEquity=10000;f.s.dailyLoss=300;assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,f.i).allowed,false);});
test('连续亏损两次暂停 12 小时，不在跨日时清零',()=>{const f=opened();for(let k=0;k<2;k++){if(k)f.s.position=T.positionFromFill(f.plan,{qty:1,price:100,clientOrderId:'e2',exchangeOrderId:'2'},now,f.c);T.recordClose(f.a,{qty:f.s.position.positionSize,price:97,clientOrderId:'c'+k,exchangeOrderId:'c'+k},'hard_sl',now);}assert.equal(f.s.pauseUntil,now+12*3600000);assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,f.i).allowed,false);});
for(const field of ['pendingOrder','unknownOrderState'])test(`${field} 禁止重复下单`,()=>{const f=fixture();f.a[field]={};assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,f.i).allowed,false);});
test('Live 未确认不允许开仓',()=>{const f=fixture();f.a.paper=false;assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,f.i).allowed,false);f.a.confirmLive=true;assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,f.i).allowed,true);});
test('低于最小名义金额不放大风险凑单',()=>{const f=fixture();assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,{...f.i,minNotional:100000}).allowed,false);});
test('已有仓位永不 DCA',()=>{const f=opened();assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,f.i).allowed,false);});
test('同一信号不会重新开仓',()=>{const f=fixture();f.s.lastEntrySignalTime=f.signal.signalTime;assert.equal(T.tryOpenTrendOnlyPosition(f.a,f.signal,f.i).allowed,false);});
for(const reason of ['trend_tp','hard_sl','structure_sl','time_stop','trend_reversal','weekend_exit','manual_close','exchange_sync_exit'])test(`${reason} 完整凭证`,()=>{const f=opened();const v=T.recordClose(f.a,{qty:f.s.position.positionSize,price:103,clientOrderId:'close',exchangeOrderId:'2'},reason,now+1000);assert.equal(v.closeReason,reason);assert.equal(f.s.journal.length,1);assert.equal(f.s.position,null);for(const k of ['accountId','strategyMode','entryTime','exitTime','rMultiple','initialStopLossPrice','finalStopLossPrice','clientOrderId','exchangeOrderId','platformTradeId'])assert.notEqual(v[k],undefined);});
test('部分平仓保留剩余仓位保护',()=>{const f=opened();const q=f.s.position.positionSize;T.recordClose(f.a,{qty:q/2,price:103,clientOrderId:'part',exchangeOrderId:'p'},'trend_tp',now);assert.equal(f.s.position.positionSize,q/2);});
test('指标只使用已收盘 K 线并验证连续性',()=>{const f=fixture();const rows=Array.from({length:260},(_,j)=>({time:now-(260-j)*900000,open:100+j,high:102+j,low:99+j,close:101+j}));const a=T.indicatorsFor(rows,f.c,'15m',now);const b=T.indicatorsFor([...rows,{time:now,open:999,high:1000,low:998,close:999}],f.c,'15m',now);assert.equal(a.close,b.close);assert.ok(Number.isFinite(a.adx));assert.throws(()=>T.indicatorsFor(rows.filter((_,j)=>j!==100),f.c,'15m',now),/缺口/);});
