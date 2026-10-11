"""Read-only analysis of v5 worker counters and lifecycle log occurrences.

No server is started. Counters are process-local cumulative Rust metrics;
logs remain non-exhaustive observations and never substitute for those counters.
"""
import argparse
import collections
import datetime
import hashlib
import json
import math
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_BASE = ROOT / 'artifacts/performance-v5'
COUNTERS = ('submitted', 'consumerCancellations', 'failedRequests', 'laneConnections',
            'laneIdleRetirements', 'laneDiscards', 'hostStarts', 'hostDrainStarts', 'watchdogKills')
GAUGES = ('queuedJobs', 'activeJobs', 'activityProtectedHosts')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
STAMP = re.compile(r'\b(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))')
PATTERNS = {
    'normalConsumerCancellation': re.compile(r'HTTP consumer cancelled render response', re.I),
    'legacyDisconnect': re.compile(r'request disconnected before response|stream consumer disconnected', re.I),
    'transportClosed': re.compile(r'Request transport closed', re.I),
    'failedRequestLaneRestart': re.compile(r'restarting render worker after failed request', re.I),
    'hostWatchdogRetirement': re.compile(r'retiring unresponsive Node worker', re.I),
    'hostGracefulDrainTimeout': re.compile(r'retiring Node worker that exceeded graceful shutdown deadline', re.I),
    'rscBackgroundUnresponsive': re.compile(r'RSC background worker stopped responding', re.I),
    'rscExitMessage': re.compile(r'App Router worker exited \(-?\d+\)', re.I),
    'requestTimeout': re.compile(r'render worker timed out|App Router .* timed out', re.I),
    'brokenPipe': re.compile(r'\bEPIPE\b'),
}
DEFINITIONS = {
    'hostStarts': 'Créations de processus Node par le transport Rust ; une création n’est pas nécessairement un redémarrage après panne.',
    'consumerCancellations': 'Annulations/déconnexions ou consommateurs bloqués reconnus comme annulation normale.',
    'laneDiscards': 'Transports abandonnés après annulation ou échec ; ce compteur ne compte pas des hôtes tués.',
    'failedRequests': 'Échecs de requêtes hors annulations normales dans le pool Rust.',
    'laneConnections': 'Connexions de transport établies ; plusieurs lanes partagent un même hôte Node.',
    'laneIdleRetirements': 'Retraits au repos de lanes ou références conservées ; pas nécessairement des fermetures TCP distinctes.',
    'hostDrainStarts': 'Débuts du drainage négocié après perte du dernier propriétaire ; motif non limité au repos.',
    'watchdogKills': 'Hôtes jugés non réactifs par le watchdog Rust ; ne couvre pas tous les types de terminaison.',
    'queuedJobs': 'Jobs soumis aux pools ; exclut l’attente HTTP avant admission.',
    'activeJobs': 'Jobs actifs des différents pools, dont les limites sont distinctes.',
    'activityProtectedHosts': 'Hôtes retenus pour activité suivie ; ne compte pas toutes les tâches JavaScript.',
}
LIMITATIONS = [
    'Les compteurs Rust sont cumulatifs par PID ; les deltas échantillonnés ne couvrent que les bornes affichées.',
    'Les instantanés atomiques ne forment pas une transaction entre champs. Aucune identité entre compteurs différents n’est imposée.',
    'Le fichier de métriques peut boucler à 16 Mio. La première valeur conservée et la couverture des fenêtres restent visibles.',
    'Les gauges à zéro sont attendues en fin de repos pour ces fixtures contrôlées, pas pour toute application avec travail légitime en cours.',
    'Les logs comptent des occurrences de messages, parfois plusieurs pour un événement. Le niveau de journalisation peut supprimer certains messages.',
    'Un restart de lane n’est pas un restart de processus. Les remplacements d’isolats RSC n’ont pas de compteur exhaustif indépendant.',
    'Les logs sans horodatage restent non attribués à une phase ; aucune date n’est inventée.',
    'Les journaux des tests de panne ne sont pas agrégés avec les campagnes HTTP/idle/fonctionnelles.',
]


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def unsigned(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**64


def decode(raw):
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        return raw.decode('utf-16')
    if b'\x00' in raw[:200]:
        return raw.decode('utf-16-le')
    return raw.decode('utf-8-sig')


def strict_json(value):
    def invalid(name):
        raise ValueError('Non-finite JSON value: ' + name)
    return json.loads(value, parse_constant=invalid)


def phase_kind(label):
    label = label.lower()
    # Sustained-cycle labels contain the planned rest duration even during load.
    # Their terminal phase is authoritative; legacy load-before-idle labels
    # likewise describe load rather than the following idle interval.
    for kind in ('load', 'idle', 'resume'):
        if label == kind or label.endswith('-' + kind):
            return kind
    if label.startswith('load-'):
        return 'load'
    if 'resume' in label or 'first-dynamic' in label:
        return 'resume'
    if any(word in label for word in ('idle', 'rest-', 'zero-http', 'no-dynamic')):
        return 'idle'
    if 'warm' in label:
        return 'warmup'
    return 'load'


def windows(record):
    result, issues = [], []
    supplied = record.get('results', [])
    if not isinstance(supplied, list):
        return [], [{'reason': 'Result windows must be an array'}]
    for index, row in enumerate(supplied):
        if not isinstance(row, dict):
            issues.append({'row': index, 'reason': 'Non-object result window'})
            continue
        label = row.get('label') or f"{row.get('route', 'window')}-{row.get('phase', index)}"
        before, after = row.get('before'), row.get('after')
        a = before.get('time') if isinstance(before, dict) else None
        b = after.get('time') if isinstance(after, dict) else None
        if not isinstance(label, str):
            issues.append({'row': index, 'reason': 'Non-string result window label'})
            continue
        if not finite(a) or not finite(b) or b <= a:
            issues.append({'row': index, 'label': label, 'reason': 'Missing or invalid before/after timestamps'})
            continue
        kind = phase_kind(label)
        result.append({'label': label, 'kind': kind, 'beginUnixMs': a * 1000, 'endUnixMs': b * 1000, 'requiredCoverage': b - a >= 5,
                       'expectedZeroAtEnd': kind == 'idle' and b - a >= 5})
    return result, issues


def metrics(raw, phases):
    rows, invalid, issues = [], [], []
    previous = {}
    try:
        lines = decode(raw).splitlines()
    except UnicodeError as error:
        return {'valid': False, 'samples': 0, 'invalidLines': [{'reason': str(error)}], 'issues': [],
                'counterMonotonic': False, 'processes': [], 'windows': [], 'idleZeroValid': False}
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            row = strict_json(line)
            if not isinstance(row, dict) or not unsigned(row.get('pid')) or not finite(row.get('unixMs')):
                raise ValueError('Missing/invalid PID or timestamp')
            values = row.get('workers')
            if not isinstance(values, dict) or any(not unsigned(values.get(key)) for key in COUNTERS + GAUGES):
                raise ValueError('Missing/invalid cumulative counter or gauge')
        except (ValueError, TypeError) as error:
            invalid.append({'line': number, 'reason': str(error), 'excerpt': line[:240]})
            continue
        old = previous.get(row['pid'])
        if old:
            if row['unixMs'] <= old['unixMs']:
                issues.append({'line': number, 'pid': row['pid'], 'reason': 'Non-increasing sample timestamp'})
            for key in COUNTERS:
                if values[key] < old['workers'][key]:
                    issues.append({'line': number, 'pid': row['pid'], 'counter': key, 'before': old['workers'][key], 'after': values[key], 'reason': 'Counter regressed'})
            if unsigned(row.get('tokioCreatedThreads')) and unsigned(old.get('tokioCreatedThreads')) and row['tokioCreatedThreads'] < old['tokioCreatedThreads']:
                issues.append({'line': number, 'pid': row['pid'], 'reason': 'tokioCreatedThreads regressed'})
        row['_line'] = number
        rows.append(row)
        previous[row['pid']] = row
    processes = []
    for pid in sorted(previous):
        selected = [row for row in rows if row['pid'] == pid]
        first, last = selected[0], selected[-1]
        processes.append({'pid': pid, 'samples': len(selected), 'firstUnixMs': first['unixMs'], 'lastUnixMs': last['unixMs'],
                          'firstCounters': {key: first['workers'][key] for key in COUNTERS},
                          'finalCounters': {key: last['workers'][key] for key in COUNTERS},
                          'sampledDelta': {key: last['workers'][key] - first['workers'][key] for key in COUNTERS},
                          'finalGauges': {key: last['workers'][key] for key in GAUGES}})
    analyzed = []
    for phase in phases:
        selected = [row for row in rows if phase['beginUnixMs'] <= row['unixMs'] <= phase['endUnixMs']]
        item = {**phase, 'samples': len(selected), 'coverage': 'absent', 'idleZero': 'not-expected'}
        if len({row['pid'] for row in selected}) > 1:
            item['coverage'] = 'multiple-pids'
            issues.append({'window': phase['label'], 'reason': 'Multiple Rust PIDs inside one measurement window'})
        elif selected:
            first, last = selected[0], selected[-1]
            gaps = [b['unixMs'] - a['unixMs'] for a, b in zip(selected, selected[1:])]
            covered = len(selected) >= 2 and first['unixMs'] - phase['beginUnixMs'] <= 2500 and phase['endUnixMs'] - last['unixMs'] <= 2500 and max(gaps, default=0) <= 5000
            item.update(coverage='sampled' if covered else 'partial', pid=first['pid'],
                        firstUnixMs=first['unixMs'], lastUnixMs=last['unixMs'], maxSampleGapMs=max(gaps, default=0),
                        counterDelta={key: last['workers'][key] - first['workers'][key] for key in COUNTERS},
                        firstCounters={key: first['workers'][key] for key in COUNTERS},
                        lastCounters={key: last['workers'][key] for key in COUNTERS},
                        gaugePeaks={key: max(row['workers'][key] for row in selected) for key in GAUGES},
                        finalGauges={key: last['workers'][key] for key in GAUGES})
        if phase['expectedZeroAtEnd']:
            tail = [row for row in selected if phase['endUnixMs'] - 5000 <= row['unixMs'] <= phase['endUnixMs']]
            sufficient = len(tail) >= 2 and phase['endUnixMs'] - tail[-1]['unixMs'] <= 2500
            item['idleZero'] = 'unknown' if not sufficient else ('yes' if all(row['workers'][key] == 0 for row in tail for key in GAUGES) else 'no')
            item['idleTailSamples'] = [{'line': row['_line'], 'unixMs': row['unixMs'], **{key: row['workers'][key] for key in GAUGES}} for row in tail]
        analyzed.append(item)
    valid = bool(rows) and not invalid and not issues and all(row['coverage'] == 'sampled' for row in analyzed if row.get('requiredCoverage', True))
    idle_windows = [row for row in analyzed if row['expectedZeroAtEnd']]
    return {'valid': valid, 'samples': len(rows), 'invalidLines': invalid, 'issues': issues,
            'counterMonotonic': not any('regressed' in item['reason'] for item in issues),
            'processes': processes, 'windows': analyzed,
            'idleZeroValid': bool(idle_windows) and all(row['idleZero'] == 'yes' for row in idle_windows)}


def log_observations(raw, phases):
    counts = collections.Counter()
    grouped = collections.defaultdict(collections.Counter)
    matches, invalid = [], []
    try:
        text = decode(raw)
    except UnicodeError as error:
        return {'counts': {}, 'windows': {}, 'matches': [], 'invalidLines': [{'reason': str(error)}], 'exhaustive': False}
    for number, line in enumerate(text.splitlines(), 1):
        plain = ANSI.sub('', line)
        if '\ufffd' in plain:
            invalid.append({'line': number, 'reason': 'Replacement character in log', 'excerpt': plain[:240]})
        kinds = [name for name, pattern in PATTERNS.items() if pattern.search(plain)]
        if not kinds:
            continue
        stamp = STAMP.search(plain)
        unix_ms = None
        if stamp:
            try:
                unix_ms = datetime.datetime.fromisoformat(stamp[1].replace('Z', '+00:00')).timestamp() * 1000
            except ValueError as error:
                invalid.append({'line': number, 'reason': 'Invalid timestamp: ' + str(error), 'excerpt': plain[:240]})
        phase = next((row for row in phases if unix_ms is not None and row['beginUnixMs'] <= unix_ms < row['endUnixMs']), None)
        label = phase['label'] if phase else 'unassigned'
        counts.update(kinds)
        grouped[label].update(kinds)
        matches.append({'line': number, 'unixMs': unix_ms, 'window': label, 'categories': kinds, 'text': plain[:1200]})
    return {'counts': dict(counts), 'windows': {name: dict(values) for name, values in grouped.items()},
            'matches': matches, 'invalidLines': invalid, 'exhaustive': False}


def analyze(base, reader=None):
    base = pathlib.Path(base).resolve()
    sources, issues = {}, []
    def relative(path):
        return pathlib.Path(path).resolve().relative_to(base).as_posix()
    def raw(path):
        try:
            data = reader(path) if reader else pathlib.Path(path).read_bytes()
            if data is None:
                raise OSError('Source unavailable')
            sources[relative(path)] = hashlib.sha256(data).hexdigest()
            return data
        except OSError as error:
            issues.append({'source': relative(path), 'reason': str(error)})
            return None
    def read(path):
        data = raw(path)
        if data is None:
            return None
        try:
            value = strict_json(decode(data))
            if not isinstance(value, dict):
                raise ValueError('Object expected')
            return value
        except (ValueError, UnicodeError) as error:
            issues.append({'source': relative(path), 'reason': str(error)})
            return None
    datasets, logs, metadata = [], [], {}
    metrics_paths = sorted({*(base / 'soak').glob('metrics.jsonl'), *(base / 'idle').glob('*/metrics.jsonl')})
    for path in metrics_paths:
        result_path = path.with_name('result.json')
        record = read(result_path) if result_path.exists() else {}
        if record is None:
            record = {}
        metadata[path.parent] = record
        phases, window_issues = windows(record)
        data = raw(path)
        parsed = metrics(data, phases) if data is not None else {'valid': False, 'samples': 0, 'processes': [], 'windows': [], 'invalidLines': [], 'issues': [], 'idleZeroValid': False}
        parsed.update(source=relative(path), resultSource=relative(result_path), runComplete=record.get('complete') is True,
                      binarySha256=record.get('binarySha256'), windowIssues=window_issues)
        if not phases or window_issues:
            parsed['valid'] = False
        datasets.append(parsed)
    paths = set((base / 'experiments').glob('*/*-attempt*.json.log'))
    paths.update((base / 'experiments').glob('*/*-attempt*.log'))
    paths.update((base / 'idle').glob('*/server.log'))
    paths.update((base / 'soak').glob('server.log'))
    for folder in base.glob('*functional*'):
        if folder.is_dir():
            paths.update(folder.glob('*.log'))
    for path in sorted(paths):
        result_path = pathlib.Path(str(path)[:-4]) if path.name.endswith('.json.log') else (path.with_suffix('.json') if path.with_suffix('.json').exists() else path.with_name('result.json'))
        record = metadata.get(path.parent)
        if record is None:
            record = read(result_path) if result_path.exists() else {}
        record = record or {}
        phases, _ = windows(record)
        data = raw(path)
        if data is None:
            continue
        logs.append({'source': relative(path), 'resultSource': relative(result_path) if result_path.exists() else None,
                     'binarySha256': record.get('binarySha256'), 'runComplete': record.get('complete'), 'variant': record.get('variant'),
                     'scope': 'benchmark' if 'experiments' in path.relative_to(base).parts else ('idle' if 'idle' in path.relative_to(base).parts else ('soak' if 'soak' in path.relative_to(base).parts else 'functional')),
                     **log_observations(data, phases)})
    return {'schema': 1, 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'state': 'available' if datasets or logs else 'not-run', 'metrics': datasets, 'logs': logs,
            'sourcesSha256': sources, 'issues': issues, 'definitions': DEFINITIONS, 'limitations': LIMITATIONS,
            'soakMetricsPresent': any(row['source'] == 'soak/metrics.jsonl' for row in datasets)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=pathlib.Path, default=DEFAULT_BASE)
    parser.add_argument('--output', type=pathlib.Path, required=True, help='New JSON file; overwriting is refused')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; choose a new file')
    result = analyze(args.base)
    result['analyzerSha256'] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(json.dumps({'output': str(args.output), 'state': result['state'], 'metricsFiles': len(result['metrics']), 'logs': len(result['logs'])}))


if __name__ == '__main__':
    main()
