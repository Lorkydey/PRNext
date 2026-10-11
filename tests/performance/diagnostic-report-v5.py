"""Read-only GC/ETW report sections; diagnostics never become HTTP benchmarks.

collect(inputs) accepts report-v5.Inputs. Large traces are hashed as streams,
not retained in its byte cache. No capture, subprocess, or analyzer is executed.
"""
import hashlib
import html
import json
import math
import pathlib
import re
import statistics
import urllib.parse


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def local(folder, name):
    if not isinstance(name, str) or not name or pathlib.PurePath(name).name != name or any(c in name for c in '/\\:') or name in ('.', '..'):
        raise ValueError('Nom de preuve non local : ' + str(name))
    file = folder / name
    if not file.resolve().is_relative_to(folder.resolve()):
        raise ValueError('Preuve hors du répertoire : ' + name)
    return file


def verify_hash(inputs, file, expected, issues):
    file = pathlib.Path(file)
    relative = inputs.relative(file)
    try:
        with file.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        inputs.hashes[relative] = actual
        if actual != expected:
            issues.append('SHA-256 différent : ' + relative)
    except OSError as error:
        issues.append('Preuve inaccessible : ' + relative + ' (' + str(error) + ')')
        return False
    return actual == expected


def gc_isolate(inputs, file, expected, begin, end):
    """Independently check counter deltas and heap summaries against JSONL."""
    raw = inputs.raw(file)
    if raw is None:
        raise ValueError('Trace GC absente : ' + str(file))
    if hashlib.sha256(raw).hexdigest() != expected.get('sha256'):
        raise ValueError('SHA isolate différent : ' + file.name)
    rows = [json.loads(line) for line in raw.decode('utf-8').splitlines()]
    starts = [row for row in rows if row.get('event') == 'start']
    if len(starts) != 1 or rows[0] != starts[0]:
        raise ValueError('Identité isolate absente ou répétée : ' + file.name)
    identity = starts[0]
    if identity.get('schema') != 1 or identity.get('node') != 'v24.19.0' or identity.get('gcDurationIsCpu') is not False:
        raise ValueError('Version/sémantique GC non vérifiée : ' + file.name)
    previous, stamp = None, None
    for row in rows:
        if any(row.get(key) != identity.get(key) for key in ['schema', 'runId', 'pid', 'threadId', 'isMainThread']):
            raise ValueError('Identité isolate variable : ' + file.name)
        current = row.get('unixMs')
        if not finite(current) or stamp is not None and current < stamp:
            raise ValueError('Horodatage GC invalide : ' + file.name)
        stamp = current
        if row.get('event') not in ['sample', 'stop']:
            continue
        if row.get('invalidEntries') != 0:
            raise ValueError('Événements GC invalides : ' + file.name)
        counters = row.get('gc')
        if not isinstance(counters, dict) or not counters or previous is not None and set(counters) != set(previous):
            raise ValueError('Compteurs GC absents ou variables : ' + file.name)
        for kind, values in counters.items():
            count = values.get('count')
            if not isinstance(count, int) or isinstance(count, bool) or count < 0 or not all(finite(values.get(key)) for key in ['durationMs', 'maxDurationMs']):
                raise ValueError('Compteur GC non fini : ' + file.name)
            if values['maxDurationMs'] > values['durationMs'] + 1e-9 or previous is not None and any(values[key] < previous[kind][key] for key in ['count', 'durationMs', 'maxDurationMs']):
                raise ValueError('Compteur GC incohérent/non monotone : ' + file.name)
        previous = counters
    samples = [row for row in rows if row.get('event') == 'sample' and begin <= row['unixMs'] <= end]
    if len(samples) < 2:
        raise ValueError('Couverture GC insuffisante : ' + file.name)
    first, last = samples[0], samples[-1]
    coverage = (last['unixMs'] - first['unixMs']) / 1000
    if coverage < max(0, (end - begin) / 1000 - 3):
        raise ValueError('Fenêtre GC incomplète : ' + file.name)
    delta = {kind: {'count': last['gc'][kind]['count'] - value['count'],
                    'elapsedDurationMs': last['gc'][kind]['durationMs'] - value['durationMs']}
             for kind, value in first['gc'].items()}
    heap = {}
    for name in ['heapUsed', 'heapTotal', 'external', 'arrayBuffers']:
        values = [row.get('heap', {}).get(name) for row in samples]
        if not all(finite(value) for value in values):
            raise ValueError('Mesure de tas invalide : ' + file.name)
        heap[name] = {'medianBytes': statistics.median(values), 'maxBytes': max(values), 'firstBytes': values[0], 'lastBytes': values[-1]}
    if expected.get('gcDelta') != delta or expected.get('heap') != heap or expected.get('counterCoverageSeconds') != coverage or expected.get('completeCoverage') is not True:
        raise ValueError('Résumé GC différent des traces : ' + file.name)
    if any(row.get('reason') != 'isolate-exit' for row in rows if row.get('event') == 'stop'):
        raise ValueError('Sonde GC arrêtée par une limite : ' + file.name)
    limits = identity.get('limits', {})
    if len(raw) > limits.get('maxBytes', 0) or len(rows) > limits.get('maxRecords', 0):
        raise ValueError('Borne de trace GC dépassée : ' + file.name)
    return {'source': inputs.relative(file), 'runId': identity['runId'], 'pid': identity['pid'], 'threadId': identity['threadId'],
            'host': identity['isMainThread'], 'node': identity['node'], 'v8': identity.get('v8'),
            'execArgv': identity.get('execArgv'), 'resourceLimits': identity.get('resourceLimits'),
            'heap': heap, 'gcDelta': delta, 'counterCoverageSeconds': coverage}


def collect_gc(inputs):
    folder = inputs.base / 'diagnostics/gc'
    result = {'state': 'non exécuté ou preuve absente', 'issues': [], 'runs': [], 'source': inputs.relative(folder / 'result.json')}
    record = inputs.read(folder / 'result.json', optional=True)
    if record is None:
        return result
    issues = result['issues']
    try:
        if record.get('complete') is not True or record.get('diagnosticOnly') is not True or record.get('nodeVersion') != 'v24.19.0':
            issues.append('Campagne GC incomplète ou identité instrumentée/version absente.')
        scripts = record.get('scriptSha256', {})
        if not {'windows-gc-v5.py', 'gc-observer-v5.cjs'} <= set(scripts):
            issues.append('Analyseur/sonde GC immuables manquants.')
        for name, expected in scripts.items():
            verify_hash(inputs, local(folder / 'scripts', name), expected, issues)
        if not record.get('runs'):
            issues.append('Aucune exécution GC enregistrée.')
        labels = set()
        for run in record.get('runs', []):
            label = run['label']
            directory = local(folder, label)
            row = {'label': label, 'profile': run.get('profile'), 'variant': run.get('variant'),
                   'source': inputs.relative(directory / 'result.json') if (directory / 'result.json').is_file() else None, 'valid': False, 'issues': [], 'isolates': []}
            result['runs'].append(row)
            if label in labels:
                row['issues'].append('Exécution GC dupliquée.')
            labels.add(label)
            if inputs.read(directory / 'result.json') != run:
                row['issues'].append('La preuve locale diffère du résultat global.')
            if run.get('complete') is not True or run.get('buildUnchanged') is not True or run.get('backgroundInterference'):
                row['issues'].append('Exécution incomplète, build modifié ou interférence.')
            diagnostic = [phase for phase in run.get('phases', []) if phase.get('phase') == 'diagnostic']
            if len(diagnostic) != 1:
                row['issues'].append('Une fenêtre diagnostique exacte est requise.')
                continue
            phase = diagnostic[0]
            value = phase.get('value', {})
            count = value.get('count')
            if not isinstance(count, int) or isinstance(count, bool) or count <= 0 or value.get('started') != count or value.get('errors') != 0 or value.get('statuses') != {'200': count}:
                row['issues'].append('Réponses diagnostiques incomplètes ou en erreur.')
            row['http'] = {'rps': value.get('rps'), 'rssMiB': phase.get('rssMedianMiB'), 'cpuMsPerResponse': phase.get('cpuMsPerResponse')}
            trace_hashes = run.get('traceSha256', {})
            if not trace_hashes:
                row['issues'].append('Inventaire des traces GC absent.')
            for name, expected in trace_hashes.items():
                verify_hash(inputs, local(directory / 'isolates', name), expected, row['issues'])
            actual_files = {file.name for file in (directory / 'isolates').glob('*') if file.is_file()}
            if actual_files != set(trace_hashes):
                row['issues'].append('Inventaire des fichiers GC différent des traces conservées.')
            expected_isolates = run.get('gc', {}).get('isolates', [])
            if {item['file'] for item in expected_isolates} != {name for name in trace_hashes if name.endswith('.jsonl')}:
                row['issues'].append('Inventaire des isolates incomplet.')
            for isolate in expected_isolates:
                file = local(directory / 'isolates', isolate['file'])
                if trace_hashes.get(isolate['file']) != isolate.get('sha256'):
                    row['issues'].append('SHA isolate absent de l’inventaire : ' + isolate['file'])
                    continue
                row['isolates'].append(gc_isolate(inputs, file, isolate, phase['beginUnixMs'], phase['endUnixMs']))
                if row['isolates'][-1]['runId'] != label:
                    row['issues'].append('Trace GC rattachée à une autre exécution.')
            if not any(item['host'] for item in row['isolates']) or not any(not item['host'] for item in row['isolates']):
                row['issues'].append('Couverture hôte + Worker RSC manquante.')
            row['valid'] = not row['issues'] and not issues
        result['state'] = 'terminé — diagnostic instrumenté vérifié' if not issues and all(row['valid'] for row in result['runs']) else 'incomplet ou non vérifié — exclu des conclusions'
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        issues.append(str(error))
        result['state'] = 'incomplet ou non vérifié — exclu des conclusions'
    return result


def collect_etw(inputs):
    folder = inputs.base / 'etw/static-final'
    result = {'state': 'non exécuté ou analyse absente', 'issues': [], 'traces': [],
              'source': inputs.relative(folder / 'result.json'), 'analysisSource': inputs.relative(folder / 'analysis.json')}
    capture = inputs.read(folder / 'result.json', optional=True)
    analysis = inputs.read(folder / 'analysis.json', optional=True)
    if capture is None or analysis is None:
        return result
    issues = result['issues']
    try:
        if capture.get('complete') is not True or capture.get('instrumented') is not True or capture.get('labels') != ['v4', 'v5'] or analysis.get('complete') is not True or analysis.get('instrumented') is not True:
            issues.append('Paire ETW ou analyse instrumentée incomplète.')
        analyzer = inputs.base / 'diagnostics/analyzers/analyze-etw-v5.py'
        verify_hash(inputs, analyzer, analysis.get('analyzerSha256'), issues)
        result['analyzerSource'] = inputs.relative(analyzer) if analyzer.is_file() else None
        traces = analysis.get('traces', [])
        if [trace.get('label') for trace in traces] != ['v4', 'v5']:
            issues.append('Deux traces ordonnées v4/v5 sont requises.')
        if len({trace.get('wireSha256') for trace in traces}) != 1 or not traces:
            issues.append('Représentations HTTP différentes ou absentes.')
        for trace in traces:
            trace_source = local(folder, trace['label'] + '.json')
            row = {'label': trace['label'], 'valid': False, 'issues': [], 'source': inputs.relative(trace_source) if trace_source.is_file() else None,
                   'lost': trace.get('lost'), 'modules': [], 'fileIoEventsPerResponse': {},
                   'instrumentedRps': trace.get('instrumentedRps'), 'jobCpuMsPerResponse': trace.get('jobCpuMsPerResponse'), 'instrumentedRssMiB': trace.get('instrumentedRssMiB')}
            result['traces'].append(row)
            recorded = inputs.read(folder / (trace['label'] + '.json'))
            if not recorded or recorded.get('complete') is not True or recorded.get('binarySha256') != trace.get('binarySha256') or recorded.get('wireSha256') != trace.get('wireSha256'):
                row['issues'].append('Identité de capture différente de l’analyse.')
            hashes = trace.get('inputsSha256', {})
            required = {'plan.json', 'result.json', trace['label'] + '.json', trace['label'] + '.etl', *[trace['label'] + '-' + suffix + '.csv' for suffix in ['profile', 'diskio', 'dumper', 'tracestats']]}
            if set(hashes) != required:
                row['issues'].append('Inventaire ETW/exports incomplet.')
            for name, expected in hashes.items():
                verify_hash(inputs, local(folder, name), expected, row['issues'])
            losses = trace.get('lost')
            stats = inputs.raw(folder / (trace['label'] + '-tracestats.csv'))
            observed_losses = {}
            if stats is not None:
                text = stats.decode(analysis.get('csvEncoding', 'cp1252'))
                for kind in ['Buffers', 'Events']:
                    found = re.search(r'Total # Lost ' + kind + r'\s*:\s*(\d+)', text)
                    if found:
                        observed_losses[kind] = int(found[1])
            if set(observed_losses) != {'Buffers', 'Events'} or losses != observed_losses:
                row['issues'].append('Pertes ETW différentes ou absentes dans le CSV brut.')
            if not isinstance(losses, dict) or set(losses) != {'Buffers', 'Events'} or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in losses.values()):
                row['issues'].append('Comptage des pertes ETW absent ou invalide.')
            elif any(losses.values()) or any(observed_losses.values()):
                row['issues'].append('Pertes ETW : attribution CPU/fichiers invalide.')
            if trace.get('httpErrors') != 0 or not finite(trace.get('responses')) or trace['responses'] <= 0:
                row['issues'].append('Trafic ETW en erreur ou non compté.')
            row['valid'] = not row['issues'] and not issues
            if row['valid']:
                row['fileIoEventsPerResponse'] = trace.get('fileIoEventsPerResponse', {})
                row['modules'] = [{'pid': process['pid'], 'name': process['name'], 'sampleWeight': process.get('sampleWeight'), 'modules': process.get('modules', [])[:6]} for process in trace.get('processes', [])]
        result['state'] = 'terminé — diagnostic ETW sans perte vérifié' if not issues and result['traces'] and all(row['valid'] for row in result['traces']) else 'incomplet ou attribution invalide — exclu des conclusions'
    except (OSError, ValueError, LookupError, TypeError, AttributeError) as error:
        issues.append(str(error))
        result['state'] = 'incomplet ou attribution invalide — exclu des conclusions'
    return result


def collect(inputs):
    return {'gc': collect_gc(inputs), 'etw': collect_etw(inputs)}


def escape(value):
    return html.escape(str(value), quote=True)


def number(value, decimals=2):
    return f'{value:,.{decimals}f}'.replace(',', ' ') if finite(value) else '—'


def link(source, label):
    if source is None:
        return escape(label) + ' (absent)'
    return '<a href="' + escape(urllib.parse.quote(source, safe='/._-')) + '">' + escape(label) + '</a>'


def render(data, base=None):
    out = ['<section id="diagnostics"><h2>Diagnostics instrumentés GC et ETW</h2>',
           '<p>Ces essais exploratoires incluent le coût des sondes. Leurs débits et latences ne sont pas des résultats HTTP finaux et ne prouvent pas à eux seuls un gain.</p>']
    for name, title in [('gc', 'Garbage collection par isolate'), ('etw', 'Traces Windows ETW')]:
        item = data[name]
        out.append('<h3>' + title + '</h3><p>' + escape(item['state']) + '.</p>')
        if item['state'].startswith('non exécuté'):
            continue
        out.append('<p>' + link(item['source'], 'Résultat brut et provenance SHA-256') + '</p>')
        for issue in item['issues']:
            out.append('<p class="warning">' + escape(issue) + '</p>')
        if name == 'gc':
            out.append('<p>La durée GC est une durée écoulée, pas du CPU ; les événements peuvent se chevaucher. Le tas de chaque isolate n’est pas le RSS : les tas, external et ArrayBuffers ne sont jamais additionnés ici. Les compteurs portent sur les bornes des échantillons et leur livraison peut être retardée.</p>')
            for run in item['runs']:
                out.append('<h4>' + escape(run['label']) + '</h4><p>' + link(run['source'], 'Preuve de cette exécution') + '</p>')
                if not run['valid']:
                    out.append('<p>Non vérifié : ' + escape('; '.join(run['issues']) or 'preuve globale invalide') + '.</p>')
                    continue
                http = run['http']
                out.append('<p>Mesure instrumentée : ' + number(http['rps']) + ' req/s ; CPU Job ' + number(http['cpuMsPerResponse'], 3) + ' ms/réponse ; RSS Job médian ' + number(http['rssMiB']) + ' Mio.</p>')
                out.append('<table><thead><tr><th>Isolate</th><th>Couverture s</th><th>Tas utilisé / engagé médian Mio</th><th>GC mineur nombre / durée ms</th><th>GC majeur nombre / durée ms</th></tr></thead><tbody>')
                for isolate in run['isolates']:
                    def gc(kind):
                        value = isolate['gcDelta'].get(kind, {})
                        return number(value.get('count'), 0) + ' / ' + number(value.get('elapsedDurationMs'))
                    out.append('<tr><td>' + link(isolate['source'], ('hôte' if isolate['host'] else 'Worker') + ' ' + str(isolate['pid']) + ':' + str(isolate['threadId'])) + '</td><td>' + number(isolate['counterCoverageSeconds']) + '</td><td>' + number(isolate['heap']['heapUsed']['medianBytes'] / 1048576) + ' / ' + number(isolate['heap']['heapTotal']['medianBytes'] / 1048576) + '</td><td>' + gc('minor') + '</td><td>' + gc('major') + '</td></tr>')
                out.append('</tbody></table>')
        else:
            out.append('<p>Les poids d’échantillons CPU décrivent les modules, sans attribution aux fonctions sources. Toute perte de buffers/événements invalide l’attribution. FileIoRead compte des octets demandés ; ce n’est ni le trafic réseau ni nécessairement une lecture du disque physique.</p>')
            out.append('<p>' + link(item['analysisSource'], 'Analyse et empreintes des ETL/CSV') + (' · ' + link(item['analyzerSource'], 'Analyseur figé') if item.get('analyzerSource') else '') + '</p>')
            for trace in item['traces']:
                out.append('<h4>' + escape(trace['label']) + '</h4><p>' + link(trace['source'], 'Capture brute') + ' ; pertes : ' + escape(trace['lost']) + '.</p>')
                if not trace['valid']:
                    out.append('<p>Attribution non utilisée : ' + escape('; '.join(trace['issues']) or 'preuve globale invalide') + '.</p>')
                    continue
                out.append('<p>Instrumenté : ' + number(trace['instrumentedRps']) + ' req/s ; CPU Job ' + number(trace['jobCpuMsPerResponse'], 3) + ' ms/réponse ; RSS Job ' + number(trace['instrumentedRssMiB']) + ' Mio.</p>')
                for process in trace['modules']:
                    out.append('<p>' + escape(process['name']) + ' (' + str(process['pid']) + ') : ' + '; '.join(escape(module['module']) + ' ' + number(module.get('processSamplePercent')) + '% des échantillons de ce processus' for module in process['modules']) + '.</p>')
                out.append('<p>Événements FileIO par réponse : ' + '; '.join(escape(key) + ' ' + number(value, 4) for key, value in trace['fileIoEventsPerResponse'].items()) + '.</p>')
    out.append('</section>')
    return '\n'.join(out)
