# Independent verification of the default 300-trial comparison protocol.
import csv, hashlib, json, math, os, statistics
from pathlib import Path
from datetime import datetime, timezone
root=Path(__file__).resolve().parents[1]
dir=Path(os.environ.get('AUDIT_REPORT_DIR', root/'reports/current-comparison'))
d=json.loads((dir/'results.json').read_text())
s=json.loads((dir/'summary.json').read_text())
t=json.loads((dir/'stress.json').read_text())
assert d['completed'] is True
rows=[dict(r,site=site['name']) for site in d['sites'] for r in site['runs']]
assert len(rows)==294 and len(t['runs'])==6 and len(s['groups'])==63
for site in d['sites']:
    planned={(p['engine'],p['repetition'],p['scenario']) for p in site['trialPlan']}
    observed=[(r['engine'],r['repetition'],r['scenario']) for r in site['runs']]
    assert len(set(observed))==len(observed) and set(observed)==planned
    for engine, record in site['engines'].items():
        assert all(b['ok'] for b in [*record['builds'],record['restoredBuild']])
        assert record['sourceSha256']==site['sourceSha256']
        assert not record['runtimeErrors']
    assert all(c['equal'] for c in site['comparisons'])
for r in rows:
    assert not r.get('error') and r['errors']==0 and r['cpuValid'] and not r['reachedCap']
    assert r['requests']==r['attempts']==sum(r['endpointCounts'].values())==sum(r['encodings'].values())
    assert r['elapsedMs']>=r['durationMs']
    assert 0<r['p50Ms']<=r['p95Ms']<=r['p99Ms']
    assert r['loadMedianRssMiB']<=r['sampledPeakRssMiB']
    assert r['memorySamples']>=20
    assert math.isclose(r['requestsPerSecond'],r['requests']*1000/r['elapsedMs'])
    assert math.isclose(r['cpuMsPerRequest'],r['serverCpuMs']/r['requests'])
    if r['kind']=='sustained':
        assert r['recovery']['errors']==0 and r['recovery']['cpuValid']
for g in s['groups']:
    for engine,value in g['engines'].items():
        values=[r for r in rows if r['site']==g['site'] and r['scenario']==g['scenario'] and r['engine']==engine]
        assert value['runs']==value['validRuns']==len(values)
        for key,stats in value['metrics'].items():
            numbers=[r[key] for r in values if isinstance(r.get(key),(int,float))]
            assert stats['n']==len(numbers)
            if numbers:
                assert math.isclose(stats['median'],statistics.median(numbers))
                assert math.isclose(stats['min'],min(numbers)) and math.isclose(stats['max'],max(numbers))
                if len(numbers)>1: assert math.isclose(stats['sampleStdDev'],statistics.stdev(numbers),abs_tol=1e-10)
for r in t['runs']:
    assert not r.get('error') and r['cpuValid'] and not r['reachedCap']
    assert r['attempts']==r['requests']+r['errors']
    assert set(r['failures'])<={'HTTP 503'}
    if r['engine']=='next': assert r['errors']==0
    assert r['recovery']['errors']==0 and r['recovery']['cpuValid']
assert s['validResponses']==sum(r['requests'] for r in rows)
assert s['functionalPassed']==s['functionalTotal']==44 and s['validTrials']==294
for file,count in [('measurements.csv',294),('summary.csv',126),('builds.csv',48),('overload.csv',6)]:
    with (dir/file).open(encoding='utf-8-sig',newline='') as f:
        assert len(list(csv.DictReader(f,delimiter=';')))==count,file
assert hashlib.sha256((root/'target/release/rustyx').read_bytes()).hexdigest()==d['binarySha256']
base=root/'packages/rustyx'
files=[]
def walk(folder):
    for p in folder.iterdir():
        if p.name=='node_modules' or p.name.startswith(('.next','.rustyx')):continue
        if p.is_dir():walk(p)
        else:files.append(p)
walk(base)
h=hashlib.sha256()
for p in sorted(files, key=str):
    h.update(str(p.relative_to(base)).encode());h.update(p.read_bytes())
assert h.hexdigest()==d['frameworkSourceSha256']
validation={'date':datetime.now(timezone.utc).isoformat(),'status':'passed','mainTrials':294,'overloadTrials':6,'functionalPairs':44,'builds':48,'normalResponses':s['validResponses'],'normalErrors':0,'overloadErrors':sum(r['errors'] for r in t['runs']),'recoveryErrors':0,'binarySha256':d['binarySha256'],'frameworkSourceSha256':d['frameworkSourceSha256'],'checks':['All planned trials present exactly once','Paired application sources match','All builds and paired functional checks pass','No ordinary load errors, request caps or invalid CPU counters','Request counts, elapsed time, CPU formulas and latency ordering checked','Report medians, min/max and sample standard deviation independently verified with Python statistics','CSV row counts match raw data','Overload errors are HTTP 503 only; Next has none; every recovery passes','Native binary and framework source hashes unchanged'], 'notes':['Workstation measurement without CPU isolation; VS Code and WindowServer active. No other tests or builds during timed loads. A mid-run pmset check reported no thermal/performance warning; CPU frequency was not measured.','The load-generator test suite passed 2 tests before the timed campaign. No engine files were edited for this comparison.'],'toolingSha256':{name:hashlib.sha256((root/'scripts'/name).read_bytes()).hexdigest() for name in ['audit-current-next.mjs','stress-current-next.mjs','report-current-next.mjs','migration-load.mjs','next-audit-cases.mjs']}}
(dir/'validation.json').write_text(json.dumps(validation,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(validation,ensure_ascii=False,indent=2))
