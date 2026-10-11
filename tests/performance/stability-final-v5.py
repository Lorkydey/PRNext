"""Offline stability analysis of completed V5 sustain evidence; never starts load.

Writes a new JSON only. Fixed resource windows are descriptive, not leak tests.
Run after the campaign and its generator observer have finished.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import math
import pathlib
import statistics

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_BASE = ROOT / 'artifacts/performance-v5'
RESOURCES = ('rssMiB', 'privateCommitMiB', 'threads', 'handles', 'processes')
INTEGERS = ('threads', 'handles', 'processes', 'totalProcesses')
MAX_SAMPLE_GAP_SECONDS = 5
BOUNDARY_TOLERANCE_SECONDS = 2.5
FAILURE_LOG_CATEGORIES = ('rscBackgroundUnresponsive', 'hostWatchdogRetirement',
                          'hostGracefulDrainTimeout', 'requestTimeout', 'brokenPipe')
LIMITS = [
    'Les pentes OLS sont descriptives, en Mio/minute. Une pente positive ou une heure sans erreur ne démontre pas à elle seule une fuite ou son absence.',
    'RSS et commit additionnent les processus vivants du Job, dont conhost. Le RSS peut compter des pages partagées plusieurs fois ; ce n’est pas du PSS.',
    'Les relevés par processus et les compteurs atomiques lifecycle ne sont pas des instantanés transactionnels. Aucune égalité entre champs indépendants n’est imposée.',
    'Le CPU du Job inclut les enfants terminés, les annulations et les métriques activées. La résolution observée de 15,625 ms peut donner zéro sur une reprise courte sans absence de travail CPU.',
    'Le CPU et les créations Job d’une reprise couvrent ensemble les deux réponses ; aucun coût CPU individuel par réponse n’est disponible.',
    'Les créations Job ne sont pas les créations Node. Les PID observés par échantillonnage ne recensent pas tous les processus transitoires ; totalProcesses reste le compteur cumulatif du Job.',
    'Les métriques de workers sont activées pour soak seulement. Leur absence dans idle ne prouve aucun zéro ; les logs ne recensent pas exhaustivement les isolats RSC.',
    'Les percentiles ne sont pas fusionnés, ni moyennés entre intervalles. Les percentiles finaux et le contrôle de capacité du générateur restent dans les autres preuves.',
    'La dernière minute finit au dernier relevé de charge et peut inclure le drainage. Les fenêtres 0–15/15–30/30–60 min sont disjointes et excluent leur borne haute.',
    'Les deltas lifecycle utilisent au contraire deux bornes cumulatives incluses : une même observation frontière peut servir de fin puis de début. Les deltas restent distincts ; ne pas additionner leurs nombres d’échantillons ou leurs gauges comme des événements.',
    'Les empreintes couvrent les fichiers effectivement lus. Le rattachement déclaré au binaire/build final est vérifié ici ; leur vérification physique complète reste dans audit-v5.py.',
]


def finite(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def uint(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def strict_json(text):
    def invalid(value):
        raise ValueError('Non-finite JSON constant: ' + value)
    def inspect(value):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError('Non-finite JSON number')
        if isinstance(value, dict):
            for child in value.values():
                inspect(child)
        elif isinstance(value, list):
            for child in value:
                inspect(child)
    value = json.loads(text, parse_constant=invalid)
    inspect(value)
    return value


def json_lines(raw):
    rows, errors = [], []
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeError as error:
        return [], [{'reason': str(error)}]
    for line, value in enumerate(text.splitlines(), 1):
        if not value.strip():
            continue
        try:
            row = strict_json(value)
            if not isinstance(row, dict):
                raise ValueError('Object required')
            rows.append(row)
        except (ValueError, TypeError) as error:
            errors.append({'line': line, 'reason': str(error), 'excerpt': value[:240]})
    return rows, errors


def sample_errors(sample):
    if not isinstance(sample, dict):
        return ['Sample must be an object']
    errors = []
    for key in ('time', 'cpuSeconds', 'rssMiB', 'privateCommitMiB'):
        if not finite(sample.get(key)) or sample[key] < 0:
            errors.append('Invalid finite/non-negative ' + key)
    for key in INTEGERS:
        if not uint(sample.get(key)):
            errors.append('Invalid non-negative integer ' + key)
    pids = sample.get('pids')
    if not isinstance(pids, list) or any(not isinstance(row, (list, tuple)) or len(row) != 2
            or not uint(row[0]) or row[0] == 0 or not isinstance(row[1], str) or not row[1] for row in pids):
        errors.append('Invalid PID/name list')
    elif len({row[0] for row in pids}) != len(pids) or sample.get('processes') != len(pids):
        errors.append('Duplicate PIDs or active process count differs from PID list')
    if uint(sample.get('totalProcesses')) and uint(sample.get('processes')) and sample['totalProcesses'] < sample['processes']:
        errors.append('Total process creations below active process count')
    detail = sample.get('processDetail')
    if not isinstance(detail, list):
        errors.append('Missing process detail')
    else:
        seen = set()
        for row in detail:
            if not isinstance(row, dict) or not uint(row.get('pid')) or row['pid'] == 0 or not isinstance(row.get('name'), str):
                errors.append('Invalid process detail identity')
                continue
            if row['pid'] in seen:
                errors.append('Duplicate process detail PID')
            seen.add(row['pid'])
            if any(not finite(row.get(key)) or row[key] < 0 for key in ('rssMiB', 'privateCommitMiB')) or not uint(row.get('threads')):
                errors.append('Invalid process detail resources')
    return errors


def validate_series(samples, label):
    errors = []
    previous = None
    for index, sample in enumerate(samples):
        invalid = sample_errors(sample)
        errors.extend({'source': label, 'sample': index, 'reason': reason} for reason in invalid)
        if invalid:
            continue
        if previous:
            if sample['time'] <= previous['time']:
                errors.append({'source': label, 'sample': index, 'reason': 'Sample time did not increase'})
            for key in ('cpuSeconds', 'totalProcesses'):
                if sample[key] < previous[key]:
                    errors.append({'source': label, 'sample': index, 'reason': key + ' regressed'})
        previous = sample
    return errors


def coverage(samples, begin, end, include_end=True):
    selected = [row for row in samples if begin <= row['time'] and (row['time'] < end or include_end and row['time'] == end)]
    gaps = [b['time'] - a['time'] for a, b in zip(selected, selected[1:])]
    leading = selected[0]['time'] - begin if selected else None
    trailing = end - selected[-1]['time'] if selected else None
    good = len(selected) >= 2 and leading <= BOUNDARY_TOLERANCE_SECONDS and trailing <= BOUNDARY_TOLERANCE_SECONDS and max(gaps, default=0) <= MAX_SAMPLE_GAP_SECONDS
    return selected, {'valid': good, 'samples': len(selected), 'begin': begin, 'end': end,
                      'firstSample': selected[0]['time'] if selected else None,
                      'lastSample': selected[-1]['time'] if selected else None,
                      'leadingGapSeconds': leading, 'trailingGapSeconds': trailing,
                      'maxSampleGapSeconds': max(gaps, default=None)}


def distribution(samples, key):
    values = [row[key] for row in samples]
    if not values:
        return None
    result = {'min': min(values), 'median': statistics.median(values), 'max': max(values), 'samples': len(values)}
    if key in ('rssMiB', 'privateCommitMiB'):
        center = statistics.mean(row['time'] for row in samples)
        mean = statistics.mean(values)
        denominator = sum((row['time'] - center) ** 2 for row in samples)
        result['descriptiveSlopeMiBPerMinute'] = (60 * sum((row['time'] - center) * (row[key] - mean) for row in samples) / denominator) if denominator else None
    return result


def resource_window(samples, begin, end, label, include_end=False):
    selected, covered = coverage(samples, begin, end, include_end)
    return {'label': label, 'coverage': covered, 'resources': {key: distribution(selected, key) for key in RESOURCES}}


def load_windows(row):
    begin, end = row['before']['time'], row['after']['time']
    samples = [row['before'], *row['samples']]
    windows = [resource_window(samples, begin + a, begin + b, label) for a, b, label in
               [(0, 900, '0–15 min'), (900, 1800, '15–30 min'), (1800, 3600, '30–60 min')]]
    last = resource_window(samples, max(begin, end - 60), end, 'Dernière minute, drainage possible', True)
    last['separateObservation'] = True
    return [*windows, last]


def resume_details(row):
    errors = []
    value = row.get('value')
    if not isinstance(value, dict):
        return None, ['Missing resume value']
    requests = [value.get('first'), value.get('second')]
    for index, request in enumerate(requests):
        if not isinstance(request, dict):
            errors.append('Missing resume response ' + str(index + 1))
            continue
        if request.get('status') != 200 or request.get('freshness') is not True or request.get('isolation') is not True:
            errors.append('Resume status/freshness/isolation failed: ' + str(index + 1))
        for key in ('latencyMs', 'startedAtUnixMs', 'finishedAtUnixMs'):
            if not finite(request.get(key)) or request[key] < 0:
                errors.append('Invalid resume ' + key)
        if all(finite(request.get(key)) for key in ('startedAtUnixMs', 'finishedAtUnixMs')) and request['finishedAtUnixMs'] < request['startedAtUnixMs']:
            errors.append('Resume timestamps reversed')
        if all(finite(request.get(key)) for key in ('startedAtUnixMs', 'finishedAtUnixMs')):
            if request['startedAtUnixMs'] < row['before']['time'] * 1000 or request['finishedAtUnixMs'] > row['after']['time'] * 1000:
                errors.append('Resume timestamps outside resource phase: ' + str(index + 1))
    if not errors and requests[1]['startedAtUnixMs'] < requests[0]['finishedAtUnixMs']:
        errors.append('Resume requests are not sequential')
    return {'first': requests[0], 'second': requests[1],
            'cpuBothResponsesSeconds': row.get('cpuSeconds'), 'jobCreationsBothResponses': row.get('processesStarted'),
            'cpuScope': 'CPU Job des deux réponses, des enfants terminés et du travail concurrent ; pas de coût individuel disponible.',
            'zeroCpuResolutionNote': 'Zéro mesuré peut refléter les pas observés de 15,625 ms ; il ne signifie pas absence de travail CPU.' if row.get('cpuSeconds') == 0 else None,
            'beforePids': row['before'].get('pids'), 'afterPids': row['after'].get('pids'),
            'beforeResources': {key: row['before'].get(key) for key in RESOURCES},
            'afterResources': {key: row['after'].get(key) for key in RESOURCES}}, errors


def analyze_record(record, periodic, mode, profile, expected_binary=None, expected_build=None):
    errors, phases, all_samples, expected_periodic, observed = [], [], [], [], {}
    def issue(reason, phase=None):
        errors.append({'phase': phase, 'reason': reason})
    if record.get('complete') is not True or record.get('mode') != mode or record.get('profile') != profile:
        issue('Record is incomplete or mode/profile differs')
    if record.get('cleanupErrors') or record.get('error'):
        issue('Workload or cleanup error recorded')
    if expected_binary and record.get('binarySha256') != expected_binary:
        issue('Declared final binary differs')
    if expected_build is not None and record.get('buildSha256') != expected_build:
        issue('Declared final application build differs')
    if mode == 'soak' and record.get('instrumented') is not True:
        issue('Soak worker instrumentation not declared')
    expected_labels = (['warmup', 'mixed-one-hour', 'idle-after-soak-310s', 'resume-after-soak'] if mode == 'soak' else
                       ['startup-zero-http-or-tcp-60s', 'first-dynamic'] + [f'cycle-{cycle}-rest-{seconds}-{phase}' for cycle in range(1, 4) for seconds in (60, 300, 900) for phase in ('load', 'idle', 'resume')])
    rows = record.get('results')
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        return {'valid': False, 'errors': [*errors, {'reason': 'Invalid result rows'}], 'phases': []}
    if [row.get('label') for row in rows] != expected_labels:
        issue('Expected phase sequence differs')
    for row in rows:
        label = row.get('label', '<missing>')
        if not isinstance(label, str):
            issue('Invalid phase label')
            continue
        samples = row.get('samples')
        if not isinstance(samples, list) or not samples or not isinstance(row.get('before'), dict) or not isinstance(row.get('after'), dict):
            issue('Missing resource samples or before/after', label)
            continue
        if samples[-1] != row['after']:
            issue('Last sample differs from final accounting', label)
        selected = [row['before'], *samples]
        sample_issues = validate_series(selected, label)
        errors.extend(sample_issues)
        expected_periodic.extend(samples[:-1])
        if sample_issues:
            continue
        all_samples.extend(selected)
        before, after = row['before'], row['after']
        elapsed = row.get('elapsedSeconds')
        if not finite(elapsed) or elapsed <= 0:
            issue('Invalid elapsed duration', label)
        cpu = row.get('cpuSeconds')
        if not finite(cpu) or cpu < 0 or not math.isclose(cpu, after['cpuSeconds'] - before['cpuSeconds'], rel_tol=1e-9, abs_tol=1e-9):
            issue('Job CPU delta differs', label)
        if not uint(row.get('processesStarted')) or row['processesStarted'] != after['totalProcesses'] - before['totalProcesses']:
            issue('Job creation delta differs', label)
        kind = 'idle' if label.endswith('-idle') or label in ('idle-after-soak-310s', 'startup-zero-http-or-tcp-60s') else ('resume' if label.endswith('-resume') or label in ('first-dynamic', 'resume-after-soak') else 'load')
        expected_durations = {'startup-zero-http-or-tcp-60s': 60, 'idle-after-soak-310s': 310,
                              'warmup': 30, 'mixed-one-hour': 3600,
                              **{f'cycle-{cycle}-rest-{seconds}-idle': seconds for cycle in range(1, 4) for seconds in (60, 300, 900)},
                              **{f'cycle-{cycle}-rest-{seconds}-load': 10 for cycle in range(1, 4) for seconds in (60, 300, 900)}}
        expected_seconds = expected_durations.get(label)
        if expected_seconds and (not finite(elapsed) or elapsed < expected_seconds):
            issue('Phase shorter than declared duration', label)
        resources = resource_window(selected, before['time'], after['time'], label, True)
        if not resources['coverage']['valid']:
            issue('Insufficient resource sampling coverage', label)
        phase = {'label': label, 'kind': kind, 'elapsedSeconds': elapsed,
                 'cpuSeconds': cpu, 'jobProcessCreations': row.get('processesStarted'),
                 'cpuPercentOneCore': 100 * cpu / elapsed if finite(cpu) and finite(elapsed) and elapsed > 0 else None,
                 **resources}
        if kind == 'load':
            value = row.get('value')
            if not isinstance(value, dict):
                issue('Missing load outcome', label)
            else:
                count = value.get('count')
                if not uint(count) or count == 0 or value.get('started') != count or value.get('statuses') != {'200': count}:
                    issue('Load did not drain successful ordinary responses', label)
                if value.get('errors') != 0 or value.get('validationErrors', 0) != 0 or value.get('exitCode', 0) != 0:
                    issue('Load request/validation/generator errors', label)
                if value.get('durationSeconds') != expected_seconds:
                    issue('Generator duration differs', label)
                if 'plannedDisconnects' in value:
                    planned = value['plannedDisconnects']
                    if not uint(planned) or value.get('cancelStarts') != planned or value.get('cancellationStatuses') != ({'200': planned} if planned else {}):
                        issue('Deliberate cancellations did not drain', label)
                phase['loadOutcome'] = {key: value.get(key) for key in ('durationSeconds', 'count', 'started', 'errors', 'validationErrors', 'statuses', 'perRoute', 'plannedDisconnects', 'cancelStarts', 'cancellationStatuses')}
        if kind == 'idle':
            phase['lastFiveSeconds'] = resource_window(selected, max(before['time'], after['time'] - 5), after['time'], label + ': quiet tail', True)
            phase['beforePids'], phase['afterPids'] = before['pids'], after['pids']
            if label.startswith('startup-') and any(name.lower() == 'node.exe' for sample in selected for _, name in sample['pids']):
                issue('Node observed before first traffic', label)
        if kind == 'resume':
            phase['resume'], invalid = resume_details(row)
            for reason in invalid:
                issue(reason, label)
        if label == 'mixed-one-hour':
            phase['windows'] = load_windows(row)
            if not all(window['coverage']['valid'] for window in phase['windows']):
                issue('Insufficient fixed-window resource coverage', label)
        for sample in selected:
            for pid, name in sample['pids']:
                key = (pid, name)
                observed.setdefault(key, {'pid': pid, 'name': name, 'firstObserved': sample['time'], 'lastObserved': sample['time']})['lastObserved'] = sample['time']
        phases.append(phase)
    errors.extend(validate_series(all_samples, 'cross-phase series'))
    errors.extend(validate_series(periodic, 'samples.jsonl'))
    if periodic != expected_periodic:
        issue('samples.jsonl differs from periodic samples retained in completed result.json')
    return {'valid': not errors, 'mode': mode, 'profile': profile, 'instrumented': record.get('instrumented'),
            'errors': errors, 'phases': phases, 'observedProcesses': list(observed.values()),
            'periodicSamples': len(periodic), 'cpuAccounting': 'Cumulative Job CPU, including exited children',
            'sourceRunnerSha256': record.get('runnerSha256'), 'sourceGeneratorSha256': record.get('generatorSha256')}


def lifecycle_module():
    source = pathlib.Path(__file__).with_name('lifecycle-v5.py')
    spec = importlib.util.spec_from_file_location('stability_lifecycle_v5', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return source, module


def unexpected_log_events(observations):
    counts = observations.get('counts', {})
    return [{'category': key, 'occurrences': counts[key]} for key in FAILURE_LOG_CATEGORIES if counts.get(key, 0) > 0]


def analyze(base):
    base = pathlib.Path(base).resolve()
    hashes, errors, runs = {}, [], []
    def raw(path):
        path = pathlib.Path(path)
        try:
            value = path.read_bytes()
            hashes[str(path)] = hashlib.sha256(value).hexdigest()
            return value
        except OSError as error:
            errors.append({'source': str(path), 'reason': str(error)})
            return None
    def read(path):
        value = raw(path)
        if value is None:
            return None
        try:
            parsed = strict_json(value.decode('utf-8-sig'))
            if not isinstance(parsed, dict):
                raise ValueError('Object required')
            return parsed
        except (ValueError, UnicodeError) as error:
            errors.append({'source': str(path), 'reason': str(error)})
            return None
    manifest = read(base / 'final.json') or {}
    expected = manifest.get('binarySha256')
    tree = manifest.get('dynamicBuild')
    expected_build = tree.get('sha256') if isinstance(tree, dict) else None
    if not isinstance(expected, str) or len(expected) != 64 or not isinstance(expected_build, dict) or not expected_build:
        errors.append({'reason': 'Missing final binary/application provenance'})
    life_source, life = lifecycle_module()
    raw(pathlib.Path(__file__))
    raw(life_source)
    for mode, profile, relative in [('soak', None, 'soak'), *[('idle', name, 'idle/' + name) for name in ('balanced', 'memory', 'speed')]]:
        folder = base / relative
        record = read(folder / 'result.json')
        if record is None:
            continue
        if record.get('complete') is not True:
            runs.append({'source': relative + '/result.json', 'valid': False, 'errors': [{'reason': 'Run not complete; live series were not read'}]})
            continue
        if mode == 'soak':
            profile = record.get('profile')
            if profile not in ('balanced', 'memory', 'speed'):
                errors.append({'source': relative + '/result.json', 'reason': 'Invalid declared soak profile'})
        resource_raw = raw(folder / 'samples.jsonl')
        periodic, invalid = json_lines(resource_raw) if resource_raw is not None else ([], [{'reason': 'Missing periodic series'}])
        result = analyze_record(record, periodic, mode, profile, expected, expected_build)
        result.update(source=relative + '/result.json', invalidResourceLines=invalid)
        phases, phase_issues = life.windows(record)
        if mode == 'soak':
            load = next((row for row in phases if row['label'] == 'mixed-one-hour'), None)
            if load:
                for begin, end in [(0, 900), (900, 1800), (1800, 3600)]:
                    phases.append({'label': f'mixed-one-hour:{begin//60}–{end//60}min', 'kind': 'load',
                                   'beginUnixMs': load['beginUnixMs'] + begin * 1000, 'endUnixMs': load['beginUnixMs'] + end * 1000,
                                   'requiredCoverage': True, 'expectedZeroAtEnd': False})
        metrics_file = folder / 'metrics.jsonl'
        if metrics_file.exists():
            metrics_raw = raw(metrics_file)
            result['lifecycle'] = life.metrics(metrics_raw, phases) if metrics_raw is not None else {'valid': False}
            result['lifecycle']['phaseIssues'] = phase_issues
        else:
            result['lifecycle'] = {'available': False, 'expected': mode == 'soak', 'interpretation': 'Absence de métriques : aucun zéro déduit.'}
        log_file = folder / 'server.log'
        log_raw = raw(log_file)
        result['logObservations'] = life.log_observations(log_raw, phases) if log_raw is not None else {'invalidLines': [{'reason': 'Missing/unreadable log; no zero failure inferred'}]}
        metrics_valid = (result['lifecycle'].get('valid') is True and result['lifecycle'].get('idleZeroValid') is True) if metrics_file.exists() else mode != 'soak'
        if not metrics_valid:
            result['errors'].append({'reason': 'Lifecycle coverage/counters or zero gauges after rest not demonstrated'})
        if invalid or phase_issues or result.get('logObservations', {}).get('invalidLines'):
            result['errors'].append({'reason': 'Invalid resource/lifecycle/log records; inspect line details'})
        result['phaseIssues'] = phase_issues
        result['unexpectedFailureCounters'] = [
            {'pid': process['pid'], 'counter': key, 'cumulativeValue': process['finalCounters'][key]}
            for process in result['lifecycle'].get('processes', []) for key in ('failedRequests', 'watchdogKills')
            if process['finalCounters'][key] > 0]
        result['unexpectedFailureLogEvents'] = unexpected_log_events(result['logObservations'])
        result['valid'] = result['valid'] and metrics_valid and not result['errors']
        result['stabilityChecksPassed'] = result['valid'] and not result['unexpectedFailureCounters'] and not result['unexpectedFailureLogEvents']
        runs.append(result)
    valid = len(runs) == 4 and all(row['valid'] for row in runs) and not errors
    return {'schema': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'valid': valid, 'stabilityChecksPassed': valid and all(row.get('stabilityChecksPassed') is True for row in runs),
            'validityScope': 'Séries et contrôles déclarés seulement ; les compteurs et messages de panne inattendus ont leur propre verdict, aucune absence universelle de fuite déduite.',
            'kind': 'Offline descriptive stability analysis, not a new performance measurement',
            'binarySha256': expected, 'thresholds': {'maxResourceSampleGapSeconds': MAX_SAMPLE_GAP_SECONDS, 'resourceBoundaryToleranceSeconds': BOUNDARY_TOLERANCE_SECONDS},
            'runs': runs, 'errors': errors, 'sourcesSha256': hashes, 'limits': LIMITS,
            'lifecycleDefinitions': life.DEFINITIONS, 'lifecycleLimitations': life.LIMITATIONS}


def write_analysis(output, value):
    output = pathlib.Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=pathlib.Path, default=DEFAULT_BASE)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output exists; choose a new path')
    result = analyze(args.base)
    write_analysis(args.output, result)
    print(json.dumps({'output': str(args.output), 'valid': result['valid'], 'stabilityChecksPassed': result['stabilityChecksPassed'], 'runs': len(result['runs'])}))
    raise SystemExit(0 if result['valid'] and result['stabilityChecksPassed'] else 1)


if __name__ == '__main__':
    main()
