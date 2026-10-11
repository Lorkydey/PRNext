"""Derive V6 summaries without changing raw measurements. Safe during a campaign.

Final summaries retain every attempted run, including overload failures. Latency
quantiles are per application, never a fabricated pooling of percentiles.
"""
import argparse
import collections
import hashlib
import json
import math
import os
import pathlib
import statistics
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/performance-v6'


def read(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def lines(path):
    try:
        with path.open(encoding='utf-8') as source:
            for line in source:
                try:
                    yield json.loads(line)
                except ValueError:
                    pass  # An active writer can leave a partial final line.
    except OSError:
        return


def spread(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return dict(median=statistics.median(values), min=min(values), max=max(values), n=len(values)) if values else None


def percentile(values, q):
    return sorted(values)[max(0, math.ceil(len(values) * q) - 1)] if values else None


def relative(path):
    return path.relative_to(OUT).as_posix()


def worker_logs(folder):
    patterns = ('restarting render worker after failed request', 'epipe', 'request disconnected before response',
                'stream consumer disconnected', 'allocation failed', 'out of memory', 'memory allocation of')
    counts = dict.fromkeys(patterns, 0)
    for path in folder.glob('app-*.log'):
        with path.open(encoding='utf-8', errors='replace') as source:
            for line in source:
                lower = line.lower()
                for pattern in patterns:
                    counts[pattern] += pattern in lower
    return counts


def allocation_logs(folder):
    result = {}
    for path in folder.glob('app-*.log'):
        matches = []
        with path.open(encoding='utf-8', errors='replace') as source:
            for line in source:
                if any(s in line.lower() for s in ('out of memory', 'allocation failed', 'memoryerror', 'memory allocation of')):
                    matches.append(line.rstrip()[:300])
        if matches:
            result[path.name] = matches
    return result


def capacity(row, cpu_groups):
    samples = [row['before'], *row.get('samples', []), row['after']]
    loads = [[] for _ in cpu_groups]
    for before, after in zip(samples, samples[1:]):
        if 'hostCpuTimes' not in before or 'hostCpuTimes' not in after:
            continue
        for i, group in enumerate(cpu_groups):
            load = 0
            valid = True
            for cpu in group:
                a, b = before['hostCpuTimes'][cpu], after['hostCpuTimes'][cpu]
                busy = sum(b[k] - a[k] for k in ('user', 'system'))
                total = busy + b['idle'] - a['idle']
                if total <= 0:
                    valid = False
                    break
                load += 100 * busy / total
            if valid:
                loads[i].append(load)
    values = row.get('value')
    clients = values if isinstance(values, list) else [values]
    means = [v.get('generatorCpuPercent') for v in clients if isinstance(v, dict) and 'apps' in v]
    core_p95 = [percentile(v, .95) for v in loads]
    reasons = []
    if not means:
        reasons.append('no generator CPU measurement')
    if any(v is not None and v > 85 for v in means):
        reasons.append('generator process mean CPU >85% of one logical CPU')
    if any(v is not None and v > 85 for v in core_p95):
        reasons.append('generator physical-core sibling sum p95 >85%')
    if any(v is None for v in core_p95):
        reasons.append('host CPU samples unavailable')
    return dict(generatorMeanPercent=means, hostSiblingSumP95=core_p95,
                sampledIntervals=[len(v) for v in loads], cpuGroups=cpu_groups,
                capacityClaimEligible=not reasons, reasons=reasons)


def phase(row, cpu_groups=((8, 9),)):
    value = row.get('value')
    clients = value if isinstance(value, list) else [value]
    apps = [dict(a, generator=i) for i, v in enumerate(clients)
            if isinstance(v, dict) for a in v.get('apps', [])]
    useful = sum(a['useful'] for a in apps)
    errors = sum(a['errors'] for a in apps)
    failed_requests = sum(a['started'] - a['useful'] - a['rejected'] for a in apps)
    invalid = sum(a['validationErrors'] for a in apps)
    rejected = sum(a['rejected'] for a in apps)
    before, after = row['before'], row['after']
    samples = [before, *row.get('samples', []), after]
    cap = capacity(row, cpu_groups)
    clean = bool(apps) and not errors and not invalid and not rejected and not failed_requests
    replies = [v for v in clients if isinstance(v, dict) and 'latencyMs' in v and 'status' in v]
    return dict(
        phase=row.get('phase', row.get('label')), elapsedSeconds=row['elapsedSeconds'],
        useful=useful, within=sum(a['within'] for a in apps), rps=sum(a['rps'] for a in apps),
        errors=errors, failedRequestsExcluding503=failed_requests, validationErrors=invalid, rejected=rejected,
        plannedDisconnects=sum(v.get('plannedDisconnects', 0) for v in clients if isinstance(v, dict)),
        cpuSeconds=row['cpuSeconds'], cpuMsPerUseful=1000 * row['cpuSeconds'] / useful if useful else None,
        cpuPercent=row['cpuPercent'], rssMedianMiB=row['rssMedianMiB'], rssMaxMiB=row['rssMaxMiB'],
        privateCommitMedianMiB=statistics.median(s['privateCommitMiB'] for s in samples),
        privateCommitMaxMiB=max(s['privateCommitMiB'] for s in samples),
        processesStarted=row['processesStarted'],
        processesAfter=after['processes'], threadsAfter=after['threads'], handlesAfter=after['handles'],
        nodesAfter=sum(name.lower() == 'node.exe' for _, name in after['pids']),
        rssAfterMiB=after['rssMiB'],
        memoryLimitEvents=after.get('jobMemoryLimitEvents', 0) - before.get('jobMemoryLimitEvents', 0),
        serverExits=[v for v in after.get('servers', []) if v.get('exitCode') is not None],
        capacity=cap, successfulCapacityClaimEligible=clean and cap['capacityClaimEligible'],
        individualReplies=dict(count=len(replies), latencyMs=spread([r['latencyMs'] for r in replies]),
                               latenciesMs=[r['latencyMs'] for r in replies],
                               statuses=dict(collections.Counter(r['status'] for r in replies))) if replies else None,
        apps=[{k: a[k] for k in ('index', 'generator', 'connections', 'started', 'completed', 'useful', 'within',
                                 'rps', 'p50', 'p95', 'p99', 'maxLatencyMs', 'errors', 'validationErrors', 'rejected', 'statuses')} for a in apps],
    )


def metrics(path):
    records = list(lines(path))
    if not records:
        return None
    final = records[-1]
    return dict(path=relative(path), samples=len(records), firstUnixMs=records[0]['unixMs'],
                lastUnixMs=final['unixMs'], final=final,
                peaks={gate: {k: max((r.get(gate) or {}).get(k, 0) for r in records)
                               for k in ('active', 'waiting', 'waitingHeaderBytes')}
                       for gate in ('fileAdmission', 'fileWorkAdmission')})


def matrix():
    progress = read(OUT / 'multi-campaign-http.json')
    selected = {r['label'] for r in (progress or {}).get('finished', [])}
    confirmation = read(OUT / 'pressure-confirm-http.json')
    confirmed = {r['label'] for r in (confirmation or {}).get('finished', [])}
    results = []
    for path in sorted((OUT / 'multi').glob('*/result.json')):
        if path.parent.name.startswith('smoke'):
            continue
        d = read(path)
        if not d:
            continue
        results.append(dict(path=relative(path), label=d['label'], variant=d['variant'], profile=d['profile'],
                            includedInComparison=d['label'] in selected and d['profile'] != 'balanced-size',
                            pressureConfirmation=d['label'] in confirmed,
                            apps=d['apps'], budgetMiB=d['jobCommitLimitMiB'], complete=d['complete'],
                            error=d.get('failure'), memoryLimitEvents=d.get('final', {}).get('jobMemoryLimitEvents'),
                            oomLogs=allocation_logs(path.parent), workerLogCounts=worker_logs(path.parent),
                            phases=[phase(row) for row in d['results']]))
    buckets = collections.defaultdict(list)
    for run in results:
        if not run['includedInComparison']:
            continue
        for row in run['phases']:
            if row['phase'] != 'warmup':
                buckets[(run['apps'], run['budgetMiB'], run['profile'], run['variant'], row['phase'])].append((run, row))
        modes = ('all',) if (run['apps'],run['budgetMiB']) in ((4,512),(8,1024)) else ('all','one','noisy')
        for mode in modes:
            buckets.setdefault((run['apps'],run['budgetMiB'],run['profile'],run['variant'],mode), [])
    summary = []
    for (apps, budget, profile, variant, mode), rows in sorted(buckets.items()):
        attempts = [r for r in results if r['includedInComparison'] and
                    (r['apps'], r['budgetMiB'], r['profile'], r['variant']) == (apps, budget, profile, variant)]
        summary.append(dict(apps=apps, budgetMiB=budget, profile=profile, variant=variant, phase=mode,
                            runs=[r['path'] for r, _ in rows], repetitions=len(rows),
                            attemptedRuns=len(attempts), incompleteRuns=sum(not r['complete'] for r in attempts),
                            missingPhaseRuns=sum(not any(p['phase'] == mode for p in r['phases']) for r in attempts),
                            cleanCapacityRuns=sum(p['successfulCapacityClaimEligible'] and r['complete']
                                                  and not r['memoryLimitEvents']
                                                  and not any(q['errors'] or q['validationErrors'] or q['failedRequestsExcluding503'] or q['rejected'] for q in r['phases'] if q['phase']=='warmup')
                                                  for r, p in rows),
                            warmupErrors=sum(q['failedRequestsExcluding503'] for r in attempts for q in r['phases'] if q['phase']=='warmup'),
                            runMemoryLimitEvents=sum(r['memoryLimitEvents'] or 0 for r in attempts),
                            memoryLimitEvents=sum(p['memoryLimitEvents'] for _, p in rows),
                            errors=sum(p['failedRequestsExcluding503'] for _, p in rows),
                            errorEvents=sum(p['errors'] for _, p in rows), rejected=sum(p['rejected'] for _, p in rows),
                            validationErrors=sum(p['validationErrors'] for _, p in rows),
                            stats={k: spread([p[k] for _, p in rows]) for k in ('rps', 'cpuMsPerUseful', 'rssMedianMiB', 'rssMaxMiB', 'privateCommitMedianMiB', 'rssAfterMiB', 'nodesAfter')},
                            latencyByApplication=[dict(index=i, **{k: spread([a[k] for _, p in rows for a in p['apps'] if a['index'] == i]) for k in ('rps', 'p50', 'p95', 'p99', 'maxLatencyMs')}) for i in range(apps)]))
    return dict(progress=progress, confirmation=confirmation, runs=results, summary=summary)


def static():
    runs = []
    for path in sorted((OUT / 'static-http').glob('*/result.json')):
        d = read(path)
        if d:
            runs.append(dict(path=relative(path), variant=d['variant'], instrumented=d['instrumented'],
                             complete=d['complete'], afterDrain=d.get('afterDrain'),
                             phases=[dict(phase(row), route=row['route'], connections=row['connections']) for row in d['results']],
                             metrics=[metrics(p) for p in path.parent.glob('metrics*.jsonl')]))
    summary = []
    for variant in ('v5', 'v6'):
        for route in ('pages-static', 'large-v6.bin'):
            rows = [p for r in runs if r['variant'] == variant and not r['instrumented']
                    for p in r['phases'] if p['phase'] == route + '-measure']
            summary.append(dict(variant=variant, route=route, repetitions=len(rows),
                                cleanCapacityRuns=sum(r['successfulCapacityClaimEligible'] for r in rows),
                                stats={k: spread([r[k] for r in rows]) for k in ('rps', 'cpuMsPerUseful', 'rssMedianMiB', 'rssMaxMiB')},
                                latency={k: spread([r['apps'][0][k] for r in rows]) for k in ('p50', 'p95', 'p99')}))
    return dict(runs=runs, summary=summary)


def wake():
    runs = []
    for path in sorted((OUT / 'wake-http').glob('*/result.json')):
        d = read(path)
        if not d:
            continue
        events = [r for p in path.parent.glob('inspect/*.jsonl') for r in lines(p)]
        stages = collections.defaultdict(list)
        isolated = collections.defaultdict(list)
        for cycle in d['cycles']:
            start = cycle['requestStarted'] * 1000
            end = start + cycle['first']['latencyMs'] + 2
            ready = [ev for ev in events if ev.get('phase') == 'rsc-ready' and start <= ev.get('time', 0) <= end]
            response = [ev for ev in events if ev.get('type') == 'http' and ev.get('route') == '/stream' and start <= ev.get('time', 0) <= end]
            if len(ready) == 1 and response:
                delta = min(ev['time'] for ev in response) - ready[0]['time']
                if delta >= 0:
                    isolated['rsc-ready-to-native-response-wall-ms'].append(delta)
        for event in events:
            # Keep event-native keys; phases overlap and must not be summed.
            name = event.get('phase', event.get('type', 'unknown'))
            if name == 'module':
                name += ':' + event.get('module', 'unknown')
            if 'durationMs' in event:
                stages[name].append(event['durationMs'])
            if any(cycle['requestStarted'] * 1000 <= event.get('time', 0)
                   <= cycle['requestStarted'] * 1000 + cycle['first']['latencyMs'] + 2
                   for cycle in d['cycles']):
                if 'durationMs' in event:
                    isolated[name].append(event['durationMs'])
                if name == 'node-entry':
                    for key in ('uptimeMs', 'bootstrapMs'):
                        if key in event:
                            isolated[name + ':' + key].append(event[key])
        runs.append(dict(path=relative(path), variant=d['variant'], profile=d['profile'], complete=d['complete'],
                         first=spread([r['first']['latencyMs'] for r in d['cycles']]),
                         second=spread([r['second']['latencyMs'] for r in d['cycles']]),
                         observedStageDurations={k: spread(v) for k, v in stages.items()},
                         isolatedFirstResponseStages={k: spread(v) for k, v in isolated.items()},
                         stagesIncludeInitialAndConcurrentResume=True,
                         simultaneousResume=d.get('simultaneousResume')))
    return runs


def soak():
    path = OUT / 'soak-http/result.json'
    d = read(path)
    if not d:
        return None
    phases = [phase(r, ((4, 5),)) for r in d['results']]
    load = list(lines(path.parent / 'load-3600.jsonl'))
    intervals = []
    previous = None
    for row in load:
        count = sum(a['within'] for a in row['apps'])
        if previous and row['elapsedSeconds'] > previous[0]:
            intervals.append(dict(endSeconds=row['elapsedSeconds'],
                                  rps=(count - previous[1]) / (row['elapsedSeconds'] - previous[0])))
        previous = row['elapsedSeconds'], count
    resources = list(lines(path.parent / 'resources.jsonl'))
    load_start = (load[0]['unixMs'] / 1000 - load[0]['elapsedSeconds']) if load else None
    windows = []
    series = []
    if load_start:
        last_time = -10
        for sample in resources:
            elapsed = sample['time'] - load_start
            if elapsed >= 0 and elapsed - last_time >= 5:
                series.append(dict(seconds=elapsed, rssMiB=sample['rssMiB'], privateCommitMiB=sample['privateCommitMiB']))
                last_time = elapsed
        for start, end in ((0, 900), (900, 1800), (1800, 2700), (2700, 3600)):
            rows = [r for r in resources if start <= r['time'] - load_start < end]
            windows.append(dict(startSeconds=start, endSeconds=end,
                                rps=spread([r['rps'] for r in intervals if start <= r['endSeconds'] < end]),
                                resources={k: spread([r[k] for r in rows]) for k in ('rssMiB', 'privateCommitMiB', 'handles', 'threads', 'processes')}))
    return dict(path=relative(path), complete=d['complete'], error=d.get('error'), phases=phases,
                lastGeneratorRecord=load[-1] if load else None, windows=windows, memorySeries5s=series,
                intervalRpsDerivedFromCounterDeltas=True,
                workerLogCounts=worker_logs(path.parent), metrics=[metrics(p) for p in path.parent.glob('metrics*.jsonl')])


def followup():
    runs = []
    for path in sorted((OUT / 'followup-http').glob('*/result.json')):
        d = read(path)
        if not d:
            continue
        groups = ((2, 3), (4, 5), (6, 7), (8, 9)) if path.parent.name.startswith('large-') else ((8, 9),)
        runs.append(dict(path=relative(path), label=path.parent.name, complete=d['complete'], error=d.get('error'),
                         variant=d.get('variant', 'v6'), profile=d.get('profile'), limit=d.get('limit'),
                         phases=[phase(row, groups) for row in d.get('results', [])],
                         burst=d.get('burst'), recovery=d.get('recovery'), afterRecovery=d.get('afterRecovery'),
                         metrics=[metrics(p) for p in path.parent.glob('metrics*.jsonl')]))
    return dict(execution=read(OUT / 'followup-http/complete.json'), runs=runs)


def extras():
    runs = []
    for path in sorted((OUT / 'extras-http').glob('*/result.json')):
        d = read(path)
        if not d:
            continue
        runs.append(dict(path=relative(path), label=path.parent.name, complete=d['complete'],
                         variant=d['variant'], profile=d.get('profile'),
                         phases=[phase(r, ((2, 3), (4, 5))) for r in d.get('results', [])],
                         startup=phase(d['startup']) if 'startup' in d else None,
                         settled=phase(d['settled']) if 'settled' in d else None))
    return dict(execution=read(OUT / 'extras-http/complete.json'), runs=runs)


def main():
    if os.name == 'nt':
        sys.path.insert(0, str(ROOT / 'artifacts/performance/python'))
        import psutil
        psutil.Process().cpu_affinity([0, 1])
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='analysis.json')
    args = parser.parse_args()
    data = dict(generatedAt=time.time(), analyzerSha256=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
                methodology=dict(latency='Per-application quantiles, never pooled from percentiles',
                                 cpu='Windows Job cumulative CPU including exited processes and idle measurement supervisor',
                                 ram='Sampled sum of process RSS, shared pages double counted; commit cap is not Linux RSS/cgroup',
                                 capacity='Conservative generator mean and physical sibling sum p95 <=85%; an eligibility flag is not a confidence interval',
                                 errors='503 separate. Failed requests = started - useful - rejected after drain; raw errors count events and can count both request/response errors for one failed request. Validation errors and raw events remain separate.'),
                matrix=matrix(), static=static(), wake=wake(), soak=soak(), followup=followup(), extras=extras())
    (OUT / args.output).write_text(json.dumps(data, indent=2), encoding='utf-8')
    print(json.dumps(dict(output=args.output, matrixRuns=len(data['matrix']['runs']),
                          matrixComplete=(data['matrix']['progress'] or {}).get('complete'),
                          soakComplete=(data['soak'] or {}).get('complete'),
                          followupRuns=len(data['followup']['runs']))))


if __name__ == '__main__':
    main()
