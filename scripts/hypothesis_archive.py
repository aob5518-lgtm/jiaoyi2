#!/usr/bin/env python3
"""Official Binance USD-M monthly archives, checksum verified; no private endpoints.
Usage: python scripts/hypothesis_archive.py ETH 2023-01 2025-12 OUTPUT.json
Requires a public exchangeInfo rules snapshot from a documented source; use bundled
current ETH/BTC rule candidates ONLY as explicit unverified historical assumptions.
"""
import csv, hashlib, io, json, sys, urllib.request, zipfile, calendar, datetime
from pathlib import Path
BASE="https://data.binance.vision/data/futures/um/monthly"
def months(start,end):
    y,m=map(int,start.split("-")); ey,em=map(int,end.split("-"))
    while (y,m)<=(ey,em):
        yield f"{y:04d}-{m:02d}"
        y,m=(y+1,1) if m==12 else (y,m+1)
def get(url):
    with urllib.request.urlopen(url,timeout=40) as r: return r.read()
def build(symbol,start,end,output):
    if symbol not in ["ETH","BTC"]: raise ValueError("Asset not registered")
    out=Path(output)
    if out.exists(): raise ValueError("Refuse overwrite frozen dataset")
    evidence=[]; bars={}; funding=[]
    for tf in ["4h","1h","15m"]:
        rows=[]
        for month in months(start,end):
            name=f"{symbol}USDT-{tf}-{month}.zip"; url=f"{BASE}/klines/{symbol}USDT/{tf}/{name}"
            raw=get(url); checksum=get(url+".CHECKSUM").decode().split()[0]
            if hashlib.sha256(raw).hexdigest()!=checksum: raise ValueError("Checksum mismatch "+url)
            evidence.append({"url":url,"sha256":checksum})
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                for row in csv.reader(io.TextIOWrapper(z.open(z.namelist()[0]))):
                    if not row or not row[0].isdigit(): continue
                    time=int(row[0]); time=time//1000 if time>10**14 else time
                    rows.append(dict(time=time,open=float(row[1]),high=float(row[2]),low=float(row[3]),close=float(row[4]),volume=float(row[5])))
        unique={r["time"]:r for r in rows}
        bars[tf]=[unique[t] for t in sorted(unique)]
        print(tf,len(bars[tf]),file=sys.stderr)
    missing_funding=[]
    for month in months(start,end):
        name=f"{symbol}USDT-fundingRate-{month}.zip"; url=f"{BASE}/fundingRate/{symbol}USDT/{name}"
        try:
            raw=get(url); checksum=get(url+".CHECKSUM").decode().split()[0]
            if hashlib.sha256(raw).hexdigest()!=checksum: raise ValueError("Funding checksum mismatch")
            evidence.append({"url":url,"sha256":checksum})
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                for r in csv.DictReader(io.TextIOWrapper(z.open(z.namelist()[0]))):
                    funding.append({"time":int(r["calc_time"]),"rate":float(r["last_funding_rate"]),"markPrice":None})
        except urllib.error.HTTPError as error:
            if error.code!=404: raise
            missing_funding.append(month)
    data={"schema":1,"source":"BINANCE_USDM_NATIVE","symbol":symbol,"quoteAsset":"USDT","marketType":"perpetual","downloadedAt":int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000),"bars":bars,"funding":funding,"evidence":evidence,"rules":{"qtyStep":.001,"minQty":.001,"maxQty":1000,"priceTick":.01 if symbol=="ETH" else .1,"minNotional":100},"historyRuleCaveat":"Conservative research-only rules, NOT verified historical exchange rule snapshots; minNotional100 assumption","fundingCaveat":"Native historical rates, funding mark approximated by last known 15m close, not actual mark price","missingFundingMonths":missing_funding}
    data["contentHash"]=hashlib.sha256(json.dumps({"bars":bars,"funding":funding},sort_keys=True).encode()).hexdigest()
    out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(data,separators=(",",":")))
    print(json.dumps({"file":str(out),"sha256":hashlib.sha256(out.read_bytes()).hexdigest(),"bars":{k:len(v) for k,v in bars.items()},"funding":len(funding),"missingFundingMonths":missing_funding}))
if __name__=="__main__": build(*sys.argv[1:])
