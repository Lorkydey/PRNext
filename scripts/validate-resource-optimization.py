"""Independent checks for the full six-variant campaign, without rerunning load."""
import csv, hashlib, json, math, statistics
from pathlib import Path
root=Path('reports/resource-optimization')
r=json.loads((root/'results.json').read_text())
groups=json.loads((root/'summary.json').read_text())
rows=r['runs']
assert len(rows)==90,len(rows)
assert len({(x['site'],x['scenario'],x['engine'],x['repetition']) for x in rows})==90
assert len(groups)==9
assert sum('recovery' in x for x in rows)==6
assert sum(len(s['comparisons']) for s in r['sites'])==22
assert all(c['equal'] for s in r['sites'] for c in s['comparisons'])
def sha(file): return hashlib.sha256(Path(file).read_bytes()).hexdigest()
assert sha('target/release/rustyx')==r['hashes']['binary']
assert sha('scripts/migration-load.mjs')==r['hashes']['client']
baseline=json.loads((root/'baseline.json').read_text())
assert sha(Path(baseline['directory'])/'rustyx')==r['hashes']['baseline']==baseline['binarySha256']
assert sha('target/mimalloc/release/rustyx')==r['variants']['mimalloc']
assert sha('target/pgo/optimized/release/rustyx')==r['variants']['pgo']
pgo=json.loads((root/'pgo-build.json').read_text())
assert pgo['binarySha256']==r['variants']['pgo'] and pgo['profileFiles']==3
def close(a,b): assert math.isclose(a,b,rel_tol=1e-10,abs_tol=1e-10),(a,b)
for x in rows:
 assert not x.get('error') and x['cpuValid'] and not x['reachedCap'],x
 assert x['requests']+x['errors']==x['attempts']
 assert sum(x['failures'].values())==x['errors']
 close(x['requestsPerSecond'],x['requests']*1000/x['elapsedMs'])
 close(x['cpuMsPerRequest'],x['serverCpuMs']/x['requests'])
 if x['engine']!='adaptive': assert x['errors']==0,x
 if x.get('recovery'): assert x['recovery']['errors']==0 and x['recovery']['cpuValid']
for g in groups:
 expected={'before','rustyx','next'} if g['scenario'].startswith('sustained') else {'before','rustyx','next','adaptive','mimalloc','pgo'}
 assert set(g['engines'])==expected
 for e,values in g['engines'].items():
  trials=[x for x in rows if x['site']==g['site'] and x['scenario']==g['scenario'] and x['engine']==e]
  assert len(trials)==values['runs']==(1 if g['scenario'].startswith('sustained') else 2)
  for key,s in values['metrics'].items():
   data=[x[key] for x in trials]
   close(s['median'],statistics.median(data));close(s['min'],min(data));close(s['max'],max(data))
   if len(data)>1: close(s['sd'],statistics.stdev(data))
with (root/'summary.csv').open(encoding='utf-8-sig') as f: assert len(list(csv.DictReader(f)))==48
result={'passed':True,'trials':90,'groups':9,'functionalComparisons':22,'recoveries':sum('recovery' in x for x in rows),'validResponses':sum(x['requests'] for x in rows),'standardErrors':sum(x['errors'] for x in rows if x['engine']=='rustyx'),'adaptiveErrors':sum(x['errors'] for x in rows if x['engine']=='adaptive')}
(root/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
