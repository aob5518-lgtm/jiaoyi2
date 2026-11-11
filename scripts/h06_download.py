"""Public Binance USD-M archives only; never loads account credentials."""
import argparse,concurrent.futures,csv,hashlib,io,json,pathlib,urllib.request,zipfile,time
p=argparse.ArgumentParser();p.add_argument('--start',type=int,default=2020);p.add_argument('--end',type=int,default=2025);p.add_argument('--output',default='.audit/h06-data');p.add_argument('--through',default='',help='Optional last included month YYYY-MM');a=p.parse_args();root=pathlib.Path(a.output);root.mkdir(parents=True,exist_ok=True)
base='https://data.binance.vision/data/futures/um/monthly/'
def request(url):
 for retry in range(3):
  try:
   with urllib.request.urlopen(url,timeout=25) as r:return r.read()
  except Exception:
   if retry==2:raise
   time.sleep(.5*(retry+1))
def one(item):
 symbol,kind,month=item;name=f'{symbol}-'+('fundingRate-' if kind=='fundingRate' else '1h-')+month+'.zip';url=base+kind+'/'+symbol+('/' if kind=='fundingRate' else '/1h/')+name;dest=root/name
 try:
  data=dest.read_bytes() if dest.exists() else request(url);expected=request(url+'.CHECKSUM').decode().split()[0]
  actual=hashlib.sha256(data).hexdigest()
  if expected!=actual:
   stamp='?h06verify='+str(int(time.time()))
   data=request(url+stamp);expected=request(url+'.CHECKSUM'+stamp).decode().split()[0];actual=hashlib.sha256(data).hexdigest()
   if expected!=actual:raise ValueError('official checksum mismatch')
  dest.write_bytes(data)
  with zipfile.ZipFile(io.BytesIO(data)) as z:rows=list(csv.reader(io.TextIOWrapper(z.open(z.namelist()[0]),encoding='utf-8-sig')))
  return { 'symbol':symbol,'kind':kind,'month':month,'url':url,'sha256':actual,'rows':rows,'verified':True }
 except Exception as e:return {'symbol':symbol,'kind':kind,'month':month,'url':url,'error':str(e)}
jobs=[(s,k,f'{y}-{m:02}') for s in ['ETHUSDT','BTCUSDT'] for y in range(a.start,a.end+1) for m in range(1,13) for k in ['klines','fundingRate','markPriceKlines'] if not a.through or f'{y}-{m:02}'<=a.through]
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 for n,r in enumerate(pool.map(one,jobs)):
  results.append(r)
  if n%40==0:print('archives checked',n+1,'/',len(jobs),flush=True)
for symbol in ['ETHUSDT','BTCUSDT']:
 rows=[v for v in results if v['symbol']==symbol and 'rows'in v];candles=[];marks={};funding=[]
 for part in rows:
  data=part['rows'];data=data[1:] if data and not data[0][0].isdigit() else data
  if part['kind']=='fundingRate':
   for r in data:funding.append({'time':int(r[0]),'rate':float(r[-1])})
  else:
   for r in data:
    ts=int(r[0]);ts=ts//1000 if ts>10**14 else ts
    if part['kind']=='markPriceKlines':marks[ts]=float(r[1])
    else:candles.append(dict(time=ts,open=float(r[1]),high=float(r[2]),low=float(r[3]),close=float(r[4]),volume=float(r[5])))
 candles=sorted({v['time']:v for v in candles}.values(),key=lambda v:v['time'])
 for f in funding:f['markPrice']=marks.get(f['time']//3600000*3600000);f['markSource']='official_mark_1h_open_proxy'
 gaps=[{'after':p['time'],'before':q['time']} for p,q in zip(candles,candles[1:]) if q['time']-p['time']!=3600000]
 output={'source':'Binance USD-M public monthly archives','symbol':symbol,'marketType':'perpetual','interval':'1h','candles':candles,'funding':sorted(funding,key=lambda v:v['time']),'gaps':gaps,'fundingMarkLimitation':'Actual historical rates; settlement mark estimated by official mark-price hourly open at funding boundary, not claimed exact settlement mark.'}
 (root/(symbol+'.json')).write_text(json.dumps(output,separators=(',',':')),encoding='utf-8')
 print(json.dumps({'symbol':symbol,'candles':len(candles),'funding':len(funding),'missingFundingMark':sum(f['markPrice'] is None for f in funding),'gaps':len(gaps)}),flush=True)
manifest=[{k:v for k,v in r.items() if k!='rows'} for r in results];(root/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8');print(json.dumps({'archives':len(results),'verified':sum(r.get('verified',False) for r in results),'errors':sum('error'in r for r in results)}))
