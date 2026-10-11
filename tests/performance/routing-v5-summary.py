"""Summarize every round of the isolated routing mechanism benchmark."""
import json
import pathlib
import statistics
import sys

source = pathlib.Path(sys.argv[1])
rows = [json.loads(line) for line in source.read_text(encoding='utf-8-sig').splitlines() if line.strip()]
result = []
for kind in ('exact', 'dynamic', 'catchall'):
    for count in (1, 100, 1000):
        group = [row for row in rows if row['kind'] == kind and row['routes'] == count]
        assert len(group) == 10
        repeated = [row['nsPerDecision'] for row in group if row['variant'] == 'repeated7']
        once = [row['nsPerDecision'] for row in group if row['variant'] == 'once']
        for round_ in range(5):
            pair = [row for row in group if row['round'] == round_]
            assert len(pair) == 2 and pair[0]['checksum'] == pair[1]['checksum']
        result.append({'kind': kind, 'routes': count, 'rounds': 5,
                       'repeated7MedianNs': statistics.median(repeated), 'onceMedianNs': statistics.median(once),
                       'ratioOfMedians': statistics.median(repeated) / statistics.median(once),
                       'repeated7Ns': repeated, 'onceNs': once})
text = json.dumps({'scope': 'Route resolution only; not an HTTP throughput forecast', 'rows': result}, indent=2)
source.with_suffix('.summary.json').write_text(text + '\n', encoding='utf-8')
for row in result:
    print(f"{row['kind']:8} {row['routes']:4} routes: {row['repeated7MedianNs']:9.1f} -> {row['onceMedianNs']:8.1f} ns, {row['ratioOfMedians']:.2f}x")
