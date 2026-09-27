"""Independent arithmetic/coverage checks for the completed admission campaign."""
import csv, hashlib, json, math, statistics
from pathlib import Path
root = Path('reports/admission-ppr')
r = json.loads((root / 'results.json').read_text())
s = json.loads((root / 'summary.json').read_text())
rows = r['runs']
assert len(rows) == 108, len(rows)
assert r['completed'] is True
assert len({(x['site'], x['scenario'], x['engine'], x['repetition']) for x in rows}) == len(rows)
assert len(s) == 14
assert sum(len(x['comparisons']) for x in r['sites']) == 22
assert all(c['equal'] for x in r['sites'] for c in x['comparisons'])
assert hashlib.sha256(Path('target/release/prnext').read_bytes()).hexdigest() == r['hashes']['binary']
assert hashlib.sha256(Path('/tmp/rustyx-before-admission-ppr/rustyx').read_bytes()).hexdigest() == r['hashes']['baselineBinary']
assert hashlib.sha256(Path('scripts/migration-load.mjs').read_bytes()).hexdigest() == r['hashes']['client']
def close(a,b): assert math.isclose(a,b,rel_tol=1e-10,abs_tol=1e-10), (a,b)
for x in rows:
    assert not x.get('error') and x['cpuValid'] and not x['reachedCap'], x
    assert x['attempts'] == x['requests'] + x['errors']
    assert sum(x['failures'].values()) == x['errors']
    close(x['requestsPerSecond'], x['requests'] * 1000 / x['elapsedMs'])
    close(x['cpuMsPerRequest'], x['serverCpuMs'] / x['requests'])
    allowed = {'HTTP 503', 'ETIMEDOUT'} if x['engine'] == 'next' and x['scenario'] == 'overload-1024' else {'HTTP 503'}
    assert not (set(x['failures']) - allowed)
    if x['engine'] == 'rustyx' and x['scenario'] != 'overload-1024': assert x['errors'] == 0
    if x['engine'] == 'next' and x['scenario'] != 'overload-1024': assert x['errors'] == 0
    if x.get('recovery'): assert x['recovery']['errors'] == 0 and x['recovery']['cpuValid']
for group in s:
    for engine, data in group['engines'].items():
        trial = [x for x in rows if x['site'] == group['site'] and x['scenario'] == group['scenario'] and x['engine'] == engine]
        expected = 1 if group['scenario'].startswith(('sustained', 'overload')) else 3
        assert len(trial) == expected == data['runs']
        assert data['errors'] == sum(x['errors'] for x in trial)
        for metric, stats in data['metrics'].items():
            values = [x[metric] for x in trial]
            close(stats['median'], statistics.median(values))
            close(stats['min'], min(values)); close(stats['max'], max(values))
            if len(values) > 1: close(stats['sd'], statistics.stdev(values))
with (root / 'summary.csv').open(encoding='utf-8-sig') as file: assert len(list(csv.DictReader(file))) == 42
with (root / 'measurements.csv').open(encoding='utf-8-sig') as file: assert len(list(csv.DictReader(file))) == 108
result = {'passed': True, 'trials': len(rows), 'groups':len(s), 'validResponses':sum(x['requests'] for x in rows),
    'recoveries':sum('recovery' in x for x in rows), 'checks':'Coverage, response counters, CPU/rps arithmetic, medians, range, sample standard deviation, CSV coverage, binary and client identities'}
(root / 'validation.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result, indent=2))
