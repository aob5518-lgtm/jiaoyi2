import json,decimal,pathlib,subprocess
from decimal import Decimal as D
p=pathlib.Path('.audit/h06-data')
results=[];decimal.getcontext().prec=45
for symbol in ['ETHUSDT','BTCUSDT']:
 data=json.loads((p/(symbol+'.json')).read_text());bars=data['candles'][:1000]
 fast=slow=dea=None
 for b in bars:
  close=D(str(b['close']));fast=close if fast is None else D(2)/D(13)*close+(D(1)-D(2)/D(13))*fast;slow=close if slow is None else D(2)/D(27)*close+(D(1)-D(2)/D(27))*slow;dif=fast-slow;dea=dif if dea is None else D(2)/D(10)*dif+(D(1)-D(2)/D(10))*dea
 js="const fs=require('fs'),S=require('./strategy/macd_scale_in/signal');const d=JSON.parse(fs.readFileSync('.audit/h06-data/"+symbol+".json'));const r=S.series(d.candles.slice(0,1000),{}).at(-1);console.log(JSON.stringify({dif:r.dif,dea:r.dea,histogram:r.histogram}));"
 actual=json.loads(subprocess.check_output(['node','-e',js],text=True));expected={'dif':float(dif),'dea':float(dea),'histogram':float(2*(dif-dea))};error=max(abs(actual[k]-expected[k])for k in actual);assert error<1e-8
 results.append({'symbol':symbol,'lastBarOpenTime':bars[-1]['time'],'actual':actual,'independentDecimalReference':expected,'maxAbsoluteError':error})
report={'sampleType':'NUMERICAL_VALIDATION_NOT_PERFORMANCE','seed':'first_close_recursive','histogramMultiplier':2,'limitation':'Verified against independent high-precision formula on Binance native candles, not a synchronized screenshot reading of Binance chart UI. Chart warmup/MA settings must match.','results':results}
pathlib.Path('docs/h06/macd-validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(results))
