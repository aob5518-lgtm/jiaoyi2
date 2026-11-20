"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),P=require("../public/quant/settings-preview");
const defaults={side:"long",leverage:2,baseAmount:300,addAmount:200,maxAdds:3,addTrigger:.01,takeProfit:.02};
test("Parameter preview distinguishes notional amounts, margin and each add price",()=>{
 const original=JSON.stringify(defaults),p=P.build(defaults,2500);
 assert.equal(p.valid,true);assert.equal(p.notional,900);assert.equal(p.margin,450);
 assert.equal(p.firstMargin,150);assert.equal(p.addMargin,100);assert.equal(p.orderCount,4);
 assert.equal(p.rows[0].price,2500);assert.equal(p.rows[1].price,2475);
 assert.equal(p.rows[2].price,2450.25);assert.equal(p.rows[1].amount,200);
 assert.equal(JSON.stringify(defaults),original);
});
test("Short preview adds above the previous reference price; zero adds creates only first entry",()=>{
 const p=P.build({...defaults,side:"short",addTrigger:.015},2500);
 assert.ok(Math.abs(p.rows[1].price-2537.5)<1e-8);
 assert.ok(p.referenceTarget<2500);
 const zero=P.build({...defaults,maxAdds:0},2500);
 assert.equal(zero.rows.length,1);assert.equal(zero.notional,300);assert.equal(zero.addMargin,0);
});
test("Missing or stale price does not fabricate a ladder or disable budget preview",()=>{
 for(const price of [undefined,null,0,NaN,-1]){
  const p=P.build(defaults,price);assert.equal(p.valid,true);assert.deepEqual(p.rows,[]);assert.equal(p.margin,450);assert.equal(p.reference,null);
 }
});
test("Blank, out-of-range and fractional integer fields never show misleading estimates",()=>{
 for(const bad of [{leverage:0},{leverage:1.55},{baseAmount:NaN},{addAmount:0},{maxAdds:11},{maxAdds:1.2},{addTrigger:0},{takeProfit:1},{side:"other"}]){
  const p=P.build({...defaults,...bad},2500);assert.equal(p.valid,false);assert.deepEqual(p.rows,[]);assert.equal(p.margin,undefined);
 }
});
test("Display examples keep percent units without rounding saved settings",()=>{
 const c={...defaults,addTrigger:.01234567,takeProfit:.03333333};
 const p=P.build(c,1234.56);assert.ok(Math.abs(p.rows[1].price-1234.56*(1-c.addTrigger))<1e-8);assert.equal(c.addTrigger,.01234567);
});
