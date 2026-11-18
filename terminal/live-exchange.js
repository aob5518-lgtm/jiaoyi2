"use strict";
const {createHmac}=require("node:crypto");
const Native=require("./native-account-view");
const Hotcoin=require("./hotcoin-execution");
const HotcoinClient=require("./hotcoin").client;
const {number:n}=require("./hotcoin");
const {formatHyperliquidPrice}=require("../trading_safety");
const id=value=>{
  if(typeof value==="number"&&!Number.isSafeInteger(value))throw Error("交易所编号精度无法核对");
  if(value===undefined||value===null||!String(value))throw Error("交易所编号缺失");
  return String(value);
};
const terminal=status=>status==="FILLED"?2:["CANCELED","CANCELLED","REJECTED","EXPIRED","EXPIRED_IN_MATCH"].includes(status)?-1:
  ["NEW","OPEN","UNTRIGGERED","PARTIALLY_FILLED"].includes(status)?0:null;
const qtyText=value=>Number(value).toFixed(12).replace(/\.?0+$/,"");

function create({request=fetch,hlClient,keyAddress,extendedOrder}={}) {
  const hotcoin=Hotcoin.create(request);
  const candleCache=new Map();
  async function json(url,options={}) {
    try {
      const response=await request(url,{...options,redirect:"error",signal:AbortSignal.timeout(10000)});
      const data=JSON.parse(await response.text(),(key,value,context)=>
        ["id","oid","orderId","algoId","positionId"].includes(key)&&typeof value==="number"&&/^\d+$/.test(context?.source||"")?context.source:value);
      if(data?.code<0||data?.status==="ERROR"){
        if(options.method==="POST"&&[-1100,-1101,-1102,-1111,-2010,-2014,-2015,-2018,-2019,-2021,-2022,-2027,-2028,-4028].includes(Number(data.code)))
          throw Object.assign(Error("交易所明确拒绝委托，请核对交易权限、资金或参数"),{code:"ORDER_REJECTED"});
        throw Error();
      }
      if(!response.ok)throw Error();
      return data;
    }catch(error){
      if(error.code==="ORDER_REJECTED")throw error;
      throw Error("交易所原生接口未确认结果，请核对连接或委托");
    }
  }
  const info=(type,params={})=>json("https://api.hyperliquid.xyz/info",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({type,...params})});
  function binance(a,route,params={},method="GET") {
    if(!a.apiKey||!a.apiSecret)throw Error("Binance 缺少 API Key 或 Secret");
    const query=new URLSearchParams({...params,timestamp:Date.now(),recvWindow:5000}).toString();
    const signature=createHmac("sha256",a.apiSecret).update(query).digest("hex");
    return json("https://fapi.binance.com"+route+"?"+query+"&signature="+signature,
      {method,headers:{"X-MBX-APIKEY":a.apiKey}});
  }
  async function extended(a,route,options={}) {
    const reply=await json("https://api.starknet.extended.exchange"+route,
      {...options,headers:{"X-Api-Key":a.apiKey,"Content-Type":"application/json"}});
    if(reply.status!=="OK")throw Error("Extended 返回状态无效");
    return reply.data;
  }
  async function hyperSnapshot(a) {
    if(!/^0x[\da-f]{40}$/i.test(a.address||"")||!a.privateKey)throw Error("Hyperliquid 缺少真实账户地址或签名私钥");
    let signer;
    try{signer=keyAddress(a.privateKey).toLowerCase();}
    catch{throw Error("Hyperliquid 签名私钥格式无效，请检查账户连接");}
    const [meta,state,active,book,orders,fees,role]=await Promise.all([
      info("meta"),info("clearinghouseState",{user:a.address}),info("activeAssetData",{user:a.address,coin:a.symbol}),
      info("l2Book",{coin:a.symbol}),info("frontendOpenOrders",{user:a.address}),
      info("userFees",{user:a.address}),info("userRole",{user:signer})]);
    if(signer!==a.address.toLowerCase()&&!(role.role==="agent"&&role.data?.user?.toLowerCase()===a.address.toLowerCase())) {
      throw Error("Hyperliquid 签名账户与真实账户授权不匹配");
    }
    const asset=meta.universe?.findIndex(row=>row.name===a.symbol&&!row.isDelisted),spec=meta.universe?.[asset];
    if(!(asset>=0&&Number.isInteger(spec.szDecimals)&&spec.maxLeverage>=1))throw Error("Hyperliquid 合约规格不可用");
    const positions=Native.summarize(a,{balance:state.marginSummary?.accountValue,available:state.withdrawable,
      positions:state.assetPositions,nativeEvidenceValid:Native.completeNumbers([state.marginSummary?.accountValue,state.withdrawable])}).positions
      .filter(p=>p.symbol===a.symbol).map(p=>({...p,id:a.symbol+":"+p.side,qtyUnit:a.symbol}));
    if(!Array.isArray(orders)||active.coin!==a.symbol)throw Error("Hyperliquid 原生委托或杠杆信息缺失");
    const bid=book.levels?.[0]?.[0],ask=book.levels?.[1]?.[0];
    return {balance:n(state.marginSummary.accountValue),available:n(state.withdrawable),
      unrealizedPnl:positions.reduce((sum,p)=>sum+(p.unrealizedPnl||0),0),
      positions,working:orders.filter(o=>o.coin===a.symbol).map(o=>id(o.oid)),mode:0,
      bid:n(bid?.px),ask:n(ask?.px),bidSize:n(bid?.sz),askSize:n(ask?.sz),quoteTime:n(book.time),
      marginType:active.leverage?.type,leverage:{long:n(active.leverage?.value),short:n(active.leverage?.value)},
      limits:{long:n(active.maxTradeSzs?.[0]),short:n(active.maxTradeSzs?.[1])},
      feeRate:n(fees.userCrossRate),asset,
      spec:{unit:1,step:10**-spec.szDecimals,digits:Math.max(0,6-spec.szDecimals),maxLeverage:spec.maxLeverage,minNotional:10}};
  }
  async function binanceSnapshot(a) {
    const market=a.symbol+"USDT";
    const [state,positions,orders,mode,fee,metadata,book,tiers,conditional]=await Promise.all([
      binance(a,"/fapi/v2/account"),binance(a,"/fapi/v2/positionRisk",{symbol:market}),
      binance(a,"/fapi/v1/openOrders",{symbol:market}),binance(a,"/fapi/v1/positionSide/dual"),
      binance(a,"/fapi/v1/commissionRate",{symbol:market}),json("https://fapi.binance.com/fapi/v1/exchangeInfo"),
      json("https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol="+market),binance(a,"/fapi/v1/leverageBracket",{symbol:market}),
      binance(a,"/fapi/v1/openAlgoOrders",{symbol:market})]);
    const row=metadata.symbols?.find(v=>v.symbol===market&&v.status==="TRADING"&&v.contractType==="PERPETUAL");
    const lot=row?.filters?.find(v=>v.filterType==="LOT_SIZE"),tick=row?.filters?.find(v=>v.filterType==="PRICE_FILTER");
    const leverage=n(positions.find(p=>p.symbol===market)?.leverage);
    if(!Array.isArray(orders)||!Array.isArray(conditional)||typeof mode.dualSidePosition!=="boolean"||!(n(lot?.stepSize)>0&&n(tick?.tickSize)>0))throw Error("Binance 账户模式、条件委托或合约规格无法核对");
    return {balance:n(state.totalMarginBalance),available:n(state.availableBalance),unrealizedPnl:n(state.totalUnrealizedProfit),
      positions:Native.summarize(a,{positions,balance:state.totalWalletBalance,available:state.availableBalance}).positions
        .filter(p=>p.symbol===a.symbol).map(p=>({...p,id:market+":"+p.side,qtyUnit:a.symbol})),
      working:[...orders.map(o=>id(o.orderId)),...conditional.map(o=>"algo:"+id(o.algoId))],mode:mode.dualSidePosition?1:0,
      leverage:{long:leverage,short:leverage},limits:{long:Math.min(n(lot.maxQty),n(book.askQty)),short:Math.min(n(lot.maxQty),n(book.bidQty))},
      bid:n(book.bidPrice),ask:n(book.askPrice),bidSize:n(book.bidQty),askSize:n(book.askQty),quoteTime:n(book.time),
      feeRate:n(fee.takerCommissionRate),spec:{unit:1,step:n(lot.stepSize),minQty:n(lot.minQty),tick:n(tick.tickSize),
        digits:Math.max(0,Math.ceil(-Math.log10(n(tick.tickSize)))),maxLeverage:Math.max(...tiers[0].brackets.map(t=>n(t.initialLeverage))),
        minNotional:n(row.filters.find(v=>v.filterType==="MIN_NOTIONAL")?.notional)}};
  }
  async function extendedSnapshot(a) {
    if(!a.apiKey||!a.starkPrivateKey||!a.publicKey||!a.vault)throw Error("Extended 缺少 API Key、Stark 私钥、公钥或 vault");
    const market=a.symbol+"-USD";
    const [balance,rows,orders,book,markets,leverages,fees]=await Promise.all([
      extended(a,"/api/v1/user/balance"),extended(a,"/api/v1/user/positions"),
      extended(a,"/api/v1/user/orders?market="+market),extended(a,"/api/v1/info/markets/"+market+"/orderbook"),
      extended(a,"/api/v1/info/markets?market="+market),extended(a,"/api/v1/user/leverage?market="+market),
      extended(a,"/api/v1/user/fees?market="+market)]);
    const m=markets.find(v=>v.name===market&&v.active&&(!v.type||v.type==="PERPETUAL")),c=m?.tradingConfig;
    const leverage=n(leverages.find(v=>v.market===market)?.leverage),fee=fees.find(v=>v.market===market);
    if(!Array.isArray(orders)||!Array.isArray(rows)||book.market!==market||!(n(c?.minOrderSizeChange)>0))throw Error("Extended 规格或原生账户数据缺失");
    const step=n(c.minOrderSizeChange),tick=n(c.minPriceChange),feeRate=n(fee?.takerFeeRate);
    return {balance:n(balance.equity),available:n(balance.availableForTrade??balance.availableBalance),
      unrealizedPnl:n(balance.unrealisedPnl),positions:Native.summarize(a,{positions:rows,balance:balance.equity,available:balance.availableForTrade}).positions
        .filter(p=>p.symbol===a.symbol).map(p=>({...p,id:market+":"+p.side,leverage,qtyUnit:a.symbol})),
      working:orders.map(o=>id(o.id)),mode:0,leverage:{long:leverage,short:leverage},feeRate,
      limits:{long:n(c.maxPositionValue)/n(book.ask?.[0]?.price),short:n(c.maxPositionValue)/n(book.bid?.[0]?.price)},
      bid:n(book.bid?.[0]?.price),ask:n(book.ask?.[0]?.price),bidSize:n(book.bid?.[0]?.qty),askSize:n(book.ask?.[0]?.qty),
      spec:{unit:1,step,tick,digits:Math.max(0,Math.ceil(-Math.log10(tick))),maxLeverage:n(c.maxLeverage),minQty:n(c.minOrderSize),minNotional:0}};
  }
  async function snapshot(a) {
    const start=Date.now(),s=a.platform==="hotcoin"?await hotcoin.snapshot(a):a.platform==="hyperliquid"?await hyperSnapshot(a):
      a.platform==="binance"?await binanceSnapshot(a):a.platform==="extended"?await extendedSnapshot(a):null;
    if(!s||!(s.bid>0&&s.ask>=s.bid&&s.bidSize>0&&s.askSize>0&&Number.isFinite(s.feeRate)&&s.feeRate>=0&&s.balance!==null&&s.available!==null)||
      Date.now()-start>12000||s.quoteTime&&(Date.now()-s.quoteTime>15000||s.quoteTime>Date.now()+2000))throw Error("实盘行情或原生账户数据失效");
    return {...s,at:Date.now(),source:a.platform+"_perpetual_native"};
  }
  async function place(a,intent) {
    if(a.platform==="hotcoin")return hotcoin.place(a,intent);
    const closing=intent.kind==="close",buy=(intent.side==="long")!==closing;
    const price=Number(intent.price),quantity=qtyText(intent.contracts);
    if(a.platform==="hyperliquid") {
      const s=await info("meta"),asset=s.universe.findIndex(v=>v.name===a.symbol);
      if(asset<0)throw Error("Hyperliquid 合约未知");
      const finalPrice=formatHyperliquidPrice(price,s.universe[asset].szDecimals);
      const result=await hlClient(a.privateKey).order({orders:[{a:asset,b:buy,p:finalPrice,s:quantity,r:closing,
        c:"0x"+intent.localId.replaceAll("-",""),t:{limit:{tif:"Ioc"}}}],grouping:"na",
        ...(intent.vault?{vaultAddress:intent.vault}:{})});
      const status=result?.response?.data?.statuses?.[0];
      if(status?.error)throw Object.assign(Error("Hyperliquid 明确拒绝委托，请核对资金、权限或合约规格"),{code:"ORDER_REJECTED"});
      return id(status?.filled?.oid??status?.resting?.oid);
    }
    if(a.platform==="binance") {
      const params={symbol:a.symbol+"USDT",side:buy?"BUY":"SELL",type:"LIMIT",timeInForce:"IOC",quantity,
        price:intent.price,newClientOrderId:intent.localId,positionSide:intent.hedged?intent.side.toUpperCase():"BOTH",
        ...(closing&&!intent.hedged?{reduceOnly:"true"}:{})};
      return id((await binance(a,"/fapi/v1/order",params,"POST")).orderId);
    }
    const reply=await extendedOrder({...a,market:a.symbol+"-USD",price:intent.price,size:quantity,side:buy?"buy":"sell",reduceOnly:closing});
    return id(reply.id);
  }
  async function order(a,orderId,pending) {
    if(a.platform==="hotcoin")return hotcoin.order(a,orderId);
    const closing=pending.kind==="close",expected=(closing?"close_":"open_")+pending.side;
    if(a.platform==="hyperliquid") {
      const [response,fills]=await Promise.all([info("orderStatus",{user:a.address,oid:"0x"+pending.localId.replaceAll("-","")}),
        info("userFillsByTime",{user:a.address,startTime:pending.submittedAt-1000,endTime:Date.now()})]);
      const status=response.order?.status,raw=response.order?.order;
      if(response.status!=="order"||id(raw?.oid)!==orderId||raw.coin!==a.symbol||!Array.isArray(fills)||fills.length>=2000)throw Error("Hyperliquid 委托状态无法核对");
      const matching=fills.filter(f=>id(f.oid)===orderId);
      const contracts=matching.reduce((sum,f)=>sum+Number(f.sz),0);
      const side=raw.side==="B"?"long":"short";
      if(side!==(closing?(pending.side==="long"?"short":"long"):pending.side))throw Error("Hyperliquid 委托方向不一致");
      const done=status==="filled"?2:status==="open"?0:/canceled|rejected/i.test(status)?-1:null;
      if(done===null)throw Error("Hyperliquid 委托状态未知");
      const expected=Number(raw.origSz)-Number(raw.sz);
      if(!Number.isFinite(expected)||Math.abs(expected-contracts)>1e-9)throw Error("Hyperliquid 成交明细尚未齐全");
      return {contracts,status:done,side:expected,price:contracts?matching.reduce((sum,f)=>sum+Number(f.sz)*Number(f.px),0)/contracts:0,
        fee:matching.every(f=>f.feeToken==="USDC"&&n(f.fee)!==null)?matching.reduce((sum,f)=>sum+Number(f.fee),0):null};
    }
    if(a.platform==="binance") {
      const row=await binance(a,"/fapi/v1/order",{symbol:a.symbol+"USDT",orderId});
      if(id(row.orderId)!==orderId||row.symbol!==a.symbol+"USDT"||terminal(row.status)===null)throw Error("Binance 委托状态未知");
      if(row.side!==((pending.side==="long")!==closing?"BUY":"SELL"))throw Error("Binance 委托方向不一致");
      const trades=await binance(a,"/fapi/v1/userTrades",{symbol:row.symbol,orderId,limit:1000});
      const contracts=n(row.executedQty),complete=Array.isArray(trades)&&trades.length<1000&&
        Math.abs(trades.reduce((sum,f)=>sum+Number(f.qty),0)-contracts)<1e-9;
      return {contracts,status:terminal(row.status),side:expected,price:n(row.avgPrice),
        fee:complete&&trades.every(f=>f.commissionAsset==="USDT")?trades.reduce((sum,f)=>sum+Number(f.commission),0):null};
    }
    const row=await extended(a,"/api/v1/user/orders/"+encodeURIComponent(orderId));
    if(id(row.id)!==orderId||row.market!==a.symbol+"-USD"||terminal(row.status)===null||
      row.side!==((pending.side==="long")!==closing?"BUY":"SELL")||row.reduceOnly!==closing)throw Error("Extended 委托回报无法核对");
    return {contracts:n(row.filledQty??"0"),status:terminal(row.status),side:expected,price:n(row.averagePrice),fee:n(row.payedFee)};
  }
  async function candles(a,interval,bar) {
    const key=[a.platform,a.symbol,interval].join(":"),prior=candleCache.get(key),now=Date.now();
    if(prior&&prior.bucket===Math.floor(now/bar)&&now-prior.at<30000)return prior.rows;
    let rows;
    if(a.platform==="hyperliquid"){
      const raw=await info("candleSnapshot",{req:{coin:a.symbol,interval,startTime:now-501*bar,endTime:now}});
      rows=raw.map(r=>({time:Number(r.t),open:Number(r.o),high:Number(r.h),low:Number(r.l),close:Number(r.c),volume:Number(r.v)}));
    }else if(a.platform==="binance"){
      const raw=await json("https://fapi.binance.com/fapi/v1/klines?symbol="+a.symbol+"USDT&interval="+interval+"&limit=500");
      rows=raw.map(r=>({time:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])}));
    }else if(a.platform==="extended"){
      const raw=await extended(a,"/api/v1/info/candles/"+a.symbol+"-USD/trades?interval=PT"+interval.toUpperCase()+"&limit=500");
      rows=raw.map(r=>({time:Number(r.T),open:Number(r.o),high:Number(r.h),low:Number(r.l),close:Number(r.c),volume:Number(r.v)}));
    }else{
      const kline={"4h":"4hour","1h":"1hour","15m":"15min"}[interval];
      if(!kline)throw Error("Hotcoin K 线周期不支持");
      const raw=await HotcoinClient(a,request).publicRead("/public/"+a.symbol.toLowerCase()+"usdt/candles?kline="+kline+"&size=500&klineType=1");
      if(!Array.isArray(raw))throw Error("Hotcoin 原生 K 线列表缺失");
      rows=raw.map(r=>({time:Number(r[0]),open:Number(r[3]),high:Number(r[2]),low:Number(r[1]),close:Number(r[4]),volume:Number(r[5])}));
    }
    rows=rows.filter(r=>r.time+bar<=Date.now()).sort((a,b)=>a.time-b.time);
    if(rows.some(r=>![r.time,r.open,r.high,r.low,r.close].every(Number.isFinite)))throw Error("原生 K 线字段无效");
    candleCache.set(key,{at:Date.now(),bucket:Math.floor(now/bar),rows});
    return rows;
  }
  async function setLeverage(a,value,directions,s) {
    if(s.positions.length||s.working.length)throw Error("已有仓位或委托时无法更换本策略杠杆");
    if(!(value>=1&&value<=s.spec.maxLeverage))throw Error("杠杆超出交易所当前合约范围");
    if(a.platform==="hotcoin"){
      if(![0,1].includes(s.marginType))throw Error("Hotcoin 保证金模式未知");
      const api=HotcoinClient(a,request);
      for(const side of directions)await api.privateCall("/position/"+api.contract+"/lever",
        {method:"POST",payload:{type:s.marginType,lever:value,side}});
    }else if(a.platform==="hyperliquid"){
      if(!["cross","isolated"].includes(s.marginType))throw Error("Hyperliquid 保证金模式未知");
      await hlClient(a.privateKey).updateLeverage({asset:s.asset,isCross:s.marginType==="cross",leverage:value});
    }else if(a.platform==="binance"){
      await binance(a,"/fapi/v1/leverage",{symbol:a.symbol+"USDT",leverage:value},"POST");
    }else{
      await extended(a,"/api/v1/user/leverage",{method:"PATCH",body:JSON.stringify({market:a.symbol+"-USD",leverage:String(value)})});
    }
  }
  return {snapshot,place,order,candles,setLeverage,binance,info,extended,json};
}
module.exports={create,qtyText};
