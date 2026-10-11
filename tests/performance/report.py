"""Summarize retained measurements, excluding missing, partial or malformed runs."""
import argparse
import datetime
import fnmatch
import hashlib
import html
import json
import math
import pathlib
import re
import statistics
from urllib.parse import quote

DEFAULT_BASE = pathlib.Path(__file__).resolve().parents[2] / 'artifacts/performance'
REFERENCE = '63847087826f178de3a32f165231b20b6c66b92e'
median = statistics.median


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def reject_constant(value):
    raise ValueError('Non-finite JSON number: ' + value)


def decode_log(raw):
    # Windows PowerShell redirection emits UTF-16; subprocess logs use UTF-8.
    encoding = 'utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
    return re.sub(r'\x1b\[[0-9;]*m', '', raw.decode(encoding, errors='replace'))


class Inputs:
    def __init__(self, base, report):
        self.base, self.report = base, report

    def read(self, name, final=False):
        status = {'source': name}
        self.report['inputs'].append(status)
        try:
            raw = (self.base / name).read_bytes()
            value = json.loads(raw.decode('utf-8-sig'), parse_constant=reject_constant)
        except FileNotFoundError:
            status['status'] = 'absent'
            return None
        except (OSError, UnicodeDecodeError, ValueError) as error:
            status.update(status='illisible ou écriture en cours', detail=str(error))
            return None
        if not isinstance(value, dict):
            status['status'] = 'schéma invalide'
            return None
        if final and not isinstance(value.get('final'), dict):
            status['status'] = 'incomplet : marqueur final absent'
            return None
        if final and not isinstance(value.get('results'), list):
            status['status'] = 'schéma invalide : results absent'
            return None
        status['status'] = 'terminé' if final else 'lu'
        self.report['files'][name] = hashlib.sha256(raw).hexdigest()
        if final:
            self.report['configurations'][name] = {k: value.get(k) for k in ('config', 'serverCpu', 'mode', 'startup', 'final')}
        return value

    def invalid(self, name, error):
        for status in self.report['inputs']:
            if status['source'] == name:
                status.update(status='schéma invalide', detail=str(error))


def groups(value):
    result = {}
    for row in value['results']:
        label = row['label']
        if label.startswith('warmup-'):
            continue
        values = row['value']
        numbers = [values[k] for k in ('rps', 'durationSeconds', 'p50', 'p95', 'p99', 'count', 'errors')]
        numbers += [row[k] for k in ('cpuMsPerResponse', 'cpuPercent', 'rssMedianMiB', 'rssMaxMiB', 'processesStarted')]
        if not all(finite(number) for number in numbers):
            raise ValueError('Invalid numeric measurement: ' + label)
        result.setdefault(label.rsplit('-', 1)[0], []).append(row)
    if not result:
        raise ValueError('No completed measurement rows')
    return result


def summarize(name, route, rows, source):
    rates = [r['value']['rps'] for r in rows]
    durations = [r['value']['durationSeconds'] for r in rows]
    return {
        'implementation': name, 'scenario': route, 'source': source, 'runs': len(rows),
        'secondsPerRun': durations[0] if len(set(durations)) == 1 else durations, 'durationsSeconds': durations,
        'rps': median(rates), 'rpsRange': [min(rates), max(rates)], 'rpsSamples': rates,
        'cpuMsPerResponse': median(r['cpuMsPerResponse'] for r in rows), 'cpuPercent': median(r['cpuPercent'] for r in rows),
        'rssMedianMiB': median(r['rssMedianMiB'] for r in rows), 'rssPeakMiB': max(r['rssMaxMiB'] for r in rows),
        'p50Ms': median(r['value']['p50'] for r in rows), 'p95Ms': median(r['value']['p95'] for r in rows),
        'p99Ms': median(r['value']['p99'] for r in rows), 'completed': sum(r['value']['count'] for r in rows),
        'errors': sum(r['value']['errors'] for r in rows), 'processesStartedDuringMeasures': sum(r['processesStarted'] for r in rows),
        'maxGeneratorCpuPercent': max(r['value'].get('generatorCpuPercent', 0) for r in rows),
    }


def comparisons(rows, section):
    pairs = {}
    for row in rows:
        version, _, profile = row['implementation'].partition('-')
        if version in ('before', 'after'):
            pairs.setdefault((profile, row['scenario']), {})[version] = row
    result = []
    for (profile, route), pair in pairs.items():
        if set(pair) != {'before', 'after'}:
            continue
        before, after = pair['before'], pair['after']
        change = lambda key: 100 * (after[key] / before[key] - 1) if before[key] else None
        result.append({'section': section, 'profile': profile or 'balanced', 'scenario': route,
                       'beforeRps': before['rps'], 'afterRps': after['rps'], 'rpsChangePercent': change('rps'),
                       'cpuChangePercent': change('cpuMsPerResponse'), 'rssChangePercent': change('rssMedianMiB'),
                       'p95ChangePercent': change('p95Ms'), 'p99ChangePercent': change('p99Ms'),
                       'beforeSource': before['source'], 'afterSource': after['source']})
    return result


def collect(base, exclude_test_logs=()):
    report = {
        'generatedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'referenceCommit': REFERENCE, 'node': '24.19.0', 'next': '16.3.5', 'react': '19.3.0',
        'machine': 'Windows 11 Pro 10.0.26100; AMD Ryzen 5 3600; 32 GiB; one logical CPU per server Job',
        'dynamic': [], 'static': [], 'staticIdle': [], 'idle': [], 'endurance': [], 'probes': [], 'shutdownProbes': [],
        'files': {}, 'inputs': [], 'configurations': {}, 'serverLogs': {}, 'testLogs': [],
    }
    inputs = Inputs(base, report)
    archives = sorted((path for path in base.glob('candidate-v*')
                       if re.fullmatch(r'candidate-v\d+', path.name) and (path / 'archive-manifest.json').is_file()),
                      key=lambda path: int(path.name.split('-v')[1]))
    report['archivedCandidates'] = []
    if archives:
        report['measurementGeneration'] = 'v' + str(int(archives[-1].name.split('-v')[1]) + 1)
    for archive in archives:
        name = archive.name
        version = name.removeprefix('candidate-')
        previous = inputs.read(name + '/summary.json')
        provenance = inputs.read(name + '/archive-manifest.json')
        item = {'version': version, 'stage': 'candidat ' + version + ' remplacé ; exclu des tableaux et totaux actuels',
                'report': name + '/report.html', 'manifest': name + '/archive-manifest.json',
                'responseTotals': (previous or {}).get('responseTotals'),
                'archivedAtUTC': (provenance or {}).get('archivedAtUTC')}
        report['archivedCandidates'].append(item)
    if report['archivedCandidates']:
        report['archivedCandidate'] = report['archivedCandidates'][-1]

    def verification_stage(name, default):
        current = base / name
        for archive in archives:
            archived = archive / name
            if archived.is_file() and current.is_file() and hashlib.sha256(archived.read_bytes()).digest() == hashlib.sha256(current.read_bytes()).digest():
                return 'candidat ' + archive.name.removeprefix('candidate-') + ' archivé'
        if '-verified.' in name and report.get('archivedCandidate'):
            return 'vérification ' + report['measurementGeneration']
        return default

    def throughput(name, source, section):
        data = inputs.read(source, final=True)
        if not data:
            return
        try:
            items = []
            for route, rows in groups(data).items():
                item = summarize(name, route, rows, source)
                if section == 'endurance':
                    samples = [s for r in rows for s in r['samples']]
                    start, end = rows[0]['before']['time'], rows[-1]['after']['time']
                    first = [s['rssMiB'] for s in samples if s['time'] <= start + 60]
                    last = [s['rssMiB'] for s in samples if s['time'] >= end - 60]
                    item.update(rssFirstMinuteMiB=median(first) if first else None, rssLastMinuteMiB=median(last) if last else None,
                                threadsStart=rows[0]['before']['threads'], threadsEnd=rows[-1]['after']['threads'])
                items.append(item)
        except (KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            inputs.invalid(source, error)
            return
        report[section].extend(items)
        if section == 'static' and isinstance(data.get('postLoadIdle'), dict):
            idle = data['postLoadIdle']
            try:
                diagnostic = {'implementation': name, 'source': source, 'elapsedSeconds': idle['elapsedSeconds'],
                              'cpuSeconds': idle['cpuSeconds'], 'cpuPercent': idle['cpuPercent'],
                              'rssBeforeMiB': idle['before']['rssMiB'], 'rssAfterMiB': idle['after']['rssMiB'],
                              'threadsBefore': idle['before']['threads'], 'threadsAfter': idle['after']['threads'],
                              'processesStarted': idle['processesStarted'], 'firstResponseMs': data['resume']['latencyMs']}
                if not all(finite(value) for key, value in diagnostic.items() if key not in ('implementation', 'source')):
                    raise ValueError('Invalid static idle diagnostic')
                report['staticIdle'].append(diagnostic)
            except (KeyError, TypeError, ValueError) as error:
                report.setdefault('diagnosticWarnings', []).append({'source': source, 'detail': str(error)})

    for name in ('next', 'before-balanced', 'after-balanced', 'before-memory', 'after-memory', 'before-speed', 'after-speed'):
        throughput(name, 'throughput-' + name + '.json', 'dynamic')
    for name in ('before', 'after'):
        throughput(name, 'static-' + name + '.json', 'static')
        throughput(name, 'endurance-' + name + '-results.json', 'endurance')
        for profile in ('balanced', 'memory', 'speed'):
            source = 'idle-' + name + '-' + profile + '.json'
            data = inputs.read(source, final=True)
            if not data:
                continue
            try:
                items = []
                for row in data['results']:
                    if row['label'].startswith('load-'):
                        continue
                    item = {'implementation': name + '-' + profile, 'source': source, 'phase': row['label'],
                            'elapsedSeconds': row['elapsedSeconds'], 'cpuSeconds': row['cpuSeconds'], 'cpuPercent': row['cpuPercent'],
                            'rssMedianMiB': row['rssMedianMiB'], 'rssEndMiB': row['after']['rssMiB'],
                            'processes': row['after']['processes'], 'threads': row['after']['threads'], 'processesStarted': row['processesStarted']}
                    if row['label'].startswith('resume-'):
                        item.update(firstResponseMs=row['value']['first']['latencyMs'], secondResponseMs=row['value']['second']['latencyMs'])
                    if not all(finite(v) for k, v in item.items() if k not in ('implementation', 'source', 'phase')):
                        raise ValueError('Invalid idle numeric measurement')
                    items.append(item)
            except (KeyError, TypeError, ValueError, AttributeError) as error:
                inputs.invalid(source, error)
                continue
            report['idle'].extend(items)
    for name in ('validate-next.json', 'validate-before.json', 'validate-final.json', 'validate-verified.json', 'storm-fixed.json', 'storm-verified.json'):
        probe = inputs.read(name)
        if probe:
            default_stage = 'comparateur Next.js' if name == 'validate-next.json' else 'vérification finale' if '-verified.' in name else 'référence' if '-before.' in name else 'intermédiaire'
            stage = verification_stage(name, default_stage) if '-verified.' in name else default_stage
            report['probes'].append({**probe, 'source': name, 'stage': stage})
    for name, stage in [('control-pipe-shutdown-before.json', 'candidat v2 pendant développement, pas la référence'),
                        ('control-pipe-shutdown-after.json', 'correction finale v3')]:
        if (base / name).is_file():
            probe = inputs.read(name)
            if probe:
                report['shutdownProbes'].append({**probe, 'source': name, 'stage': stage})
    if (base / 'static-final/evidence.json').is_file():
        report['staticComparisonEvidence'] = inputs.read('static-final/evidence.json')
    for p in sorted(base.glob('*.json.server.log')):
        if p.name.removesuffix('.server.log') not in report['files']:
            continue
        raw = p.read_bytes()
        text = decode_log(raw)
        report['files'][p.name] = hashlib.sha256(raw).hexdigest()
        report['serverLogs'][p.name] = {
            'failedLaneWarnings': text.count('restarting render worker after failed request'),
            'unresponsiveWorkers': text.count('retiring unresponsive Node worker'),
            'gracefulDeadlineExceeded': text.count('retiring Node worker that exceeded graceful shutdown deadline'),
            'unresponsiveRscWork': text.count('RSC background worker stopped responding:'),
            'rscBackgroundWorkErrors': text.count('RSC background work failed:'),
            'rscExitErrors': text.count('App Router worker exited'), 'epipe': text.count('EPIPE'),
        }
    patterns = ('unit-tests*.log', 'e2e-workers*.log', 'rsc-*.log', 'dev-env-isolated*.log', 'runtime-final*.log', 'e2e-final*.log',
                'final-pool-tests.log', 'final-profile-tests.log', 'pool-postresponse.log', 'pool-owner-postresponse.log',
                'worker-finalize-tests.log', 'worker-control-pipe-tests.log', 'next-conformance-verified.log')
    for p in sorted({p for pattern in patterns for p in base.glob(pattern) if not p.name.endswith('.err.log')}):
        if any(fnmatch.fnmatch(p.name, pattern) for pattern in exclude_test_logs):
            continue
        raw = p.read_bytes()
        text = decode_log(raw)
        counters = {}
        for key in ('tests', 'pass', 'fail', 'skipped', 'cancelled'):
            matches = re.findall(r'(?m)^[ \t]*(?:ℹ|#)?[ \t]*' + key + r'[ \t]+(\d+)[ \t]*\r?$', text)
            if matches:
                counters[key] = int(matches[-1])
        rust = re.findall(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;', text)
        if rust:
            # Cargo can run both lib and main test binaries; a trailing empty
            # binary must not hide the preceding library's failures or count.
            passed, failed, ignored, measured, filtered = (sum(int(row[i]) for row in rust) for i in range(5))
            counters.update(tests=passed + failed + ignored + measured, **{'pass': passed, 'fail': failed},
                            skipped=ignored, measured=measured, filteredOut=filtered, testBinaries=len(rust))
        stage = 'vérification finale' if '-verified.' in p.name else 'vérification finale ciblée (Rust)' if rust and p.name.startswith('final-') else 'intermédiaire / ciblé'
        stage = verification_stage(p.name, stage) if '-verified.' in p.name or rust else stage
        counters.update(source=p.name, stage=stage,
                        status='résumé présent' if 'duration_ms ' in text or rust else 'résumé absent / en cours')
        report['testLogs'].append(counters)
        report['files'][p.name] = hashlib.sha256(raw).hexdigest()
    for name in ('prnext-before.exe', 'prnext-final.exe', 'static-fixture-evidence.json', 'implementation-evidence.json',
                 'native-v3-build.json', 'unit-tests-verified.exit.json', 'next-conformance-verified-exit.json',
                 'npm-ci-node24.19.json', 'validation-final.json', 'SHASUMS256.txt'):
        p = base / name
        if p.exists():
            report['files'][name] = hashlib.sha256(p.read_bytes()).hexdigest()
    sections = ('dynamic', 'static', 'endurance')
    def totals(rows):
        return {'completed': sum(row['completed'] for row in rows), 'errors': sum(row['errors'] for row in rows)}
    report['responseTotals'] = {
        'scope': 'Mesures dynamique, statique et endurance terminées ; drainage inclus, échauffement, cycles de repos et sondes fonctionnelles exclus.',
        'allImplementations': totals([row for section in sections for row in report[section]]),
        'afterOnly': totals([row for section in sections for row in report[section] if row['implementation'].startswith('after')]),
        'sections': {section: totals(report[section]) for section in sections},
    }
    report['comparisons'] = [row for section in sections for row in comparisons(report[section], section)]
    return report


def link(name, label=None):
    return '<a href="' + html.escape(quote(name, safe='/'), quote=True) + '">' + html.escape(label or name) + '</a>'


def display(value, key=''):
    if value is None:
        return '—'
    if isinstance(value, bool):
        return 'oui' if value else 'non'
    if isinstance(value, float):
        return f'{value:.4f}' if key in ('cpuPercent', 'cpuSeconds') else f'{value:.2f}'
    if isinstance(value, list):
        return ' – '.join(display(v, key) for v in value)
    return str(value)


def table(rows, fields, caption):
    if not rows:
        return '<p class="pending">En attente de mesures terminées.</p>'
    out = '<div class="scroll"><table><caption>' + html.escape(caption) + '</caption><thead><tr>'
    out += ''.join('<th scope="col">' + html.escape(title) + '</th>' for key, title in fields)
    out += '</tr></thead><tbody>'
    for row in rows:
        out += '<tr>'
        for key, title in fields:
            value = row.get(key)
            out += '<td>' + (link(value) if (key == 'source' or key.endswith('Source')) and value else html.escape(display(value, key))) + '</td>'
        out += '</tr>'
    return out + '</tbody></table></div>'


def render(report, base):
    fields = [('implementation', 'Version / profil'), ('scenario', 'Scénario'), ('runs', 'Mesures'),
              ('secondsPerRun', 'Secondes / mesure'), ('rps', 'req/s méd.'), ('rpsRange', 'req/s min – max'),
              ('cpuMsPerResponse', 'CPU ms/rép.'), ('cpuPercent', 'CPU % cœur'), ('rssMedianMiB', 'RSS méd. Mio'),
              ('rssPeakMiB', 'RSS max Mio'), ('p50Ms', 'p50 ms'), ('p95Ms', 'p95 ms'), ('p99Ms', 'p99 ms'),
              ('errors', 'Erreurs'), ('processesStartedDuringMeasures', 'Processus créés'), ('source', 'Source')]
    page = '''<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PRNext — mesures vérifiées</title><style>
body{font:16px/1.55 system-ui;max-width:1500px;margin:32px auto;padding:0 24px;color:#17202a;background:#fff}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0 28px}caption{text-align:left;font-weight:600;padding:8px 0}
th,td{text-align:left;border-bottom:1px solid #d4dae0;padding:8px;vertical-align:top}th{background:#edf2f7}h1,h2{line-height:1.25}
code{background:#edf2f7;padding:2px 4px;overflow-wrap:anywhere}a{color:#19569b}.note,.pending{background:#f4f6f8;padding:16px;border-left:4px solid #526b84}
li{margin:8px 0}details{margin:20px 0}summary{cursor:pointer;font-weight:600}
</style></head><body><h1>PRNext — validation du 10 octobre 2026</h1>'''
    page += '<p>Référence 0.1.11-alpha, commit <code>' + REFERENCE + '</code>. Node 24.19.0, Next.js 16.3.5, React 19.3.0. Ryzen 5 3600, Windows 11, 32 Gio. Serveur limité à un processeur logique ; générateur sur un autre cœur.</p>'
    pending = [row for row in report['inputs'] if row['status'] not in ('terminé', 'lu')]
    page += '<p class="note">' + (f'Rapport provisoire : {len(pending)} fichiers attendus sont absents, incomplets ou invalides. ' if pending else '')
    page += 'Seules les exécutions portant un marqueur final entrent dans les tableaux de performance. L’effectif, la durée et l’étendue des débits sont indiqués par ligne. Scénarios reconstruits : l’application et les scripts d’origine n’étaient pas fournis. Ces résultats Windows ne reproduisent pas les chiffres Linux/Nginx communiqués.</p>'
    page += '<p>Médianes entre mesures ; les p50/p95/p99 sont les médianes des quantiles de chaque mesure, sans fusion des histogrammes. Le CPU cumulé du Job couvre Rust, Node, leurs threads et les processus terminés. La RSS additionne les processus vivants, console Windows incluse, toutes les 500 ms ; un pic entre échantillons peut échapper à la mesure. Aucun cache de réponse dynamique ajouté.</p>'
    if report.get('archivedCandidate'):
        page += '<p class="note">Les lignes <code>after</code> présentes ci-dessous désignent les nouvelles mesures ' + html.escape(report['measurementGeneration']) + '. Après corrections supplémentaires du cycle de vie, les candidats précédents ont été archivés. Leurs mesures ne sont ni substituées aux données actuelles manquantes, ni ajoutées à leurs totaux. Les journaux encore identiques à une copie archivée restent explicitement identifiés. '
        page += ' · '.join(link(item['report'], 'Rapport candidat ' + item['version'] + ' archivé') + ' / ' + link(item['manifest'], 'copies et SHA-256 ' + item['version']) for item in report['archivedCandidates']) + '.</p>'
    totals = report['responseTotals']
    page += '<p>Effectif des mesures retenues : <strong>' + f"{totals['allImplementations']['completed']:,}".replace(',', ' ') + '</strong> réponses terminées, ' + str(totals['allImplementations']['errors']) + ' erreur(s), avant/après et Next réunis. Dont <strong>' + f"{totals['afterOnly']['completed']:,}".replace(',', ' ') + '</strong> réponses sur la version corrigée, ' + str(totals['afterOnly']['errors']) + ' erreur(s). ' + html.escape(totals['scope']) + '</p>'
    page += '<p>' + link('summary.json', 'Synthèse JSON, configurations exactes et SHA-256') + ' · ' + link('../../tests/performance/README.md', 'Méthodologie et commandes') + '</p>'
    for name, label in [('implementation-evidence.json', 'Preuves de configuration, installation et instantané final'),
                        ('validation-final.json', 'Contrôle final des marqueurs, empreintes et compteurs'),
                        ('npm-ci-node24.19.json', 'Installation npm ci isolée avec Node 24.19.0'),
                        ('SHASUMS256.txt', 'Empreintes de l’instantané des artefacts')]:
        if (base / name).exists():
            page += '<p>' + link(name, label) + '.</p>'
    page += '<h2>Corrections et comportement conservé</h2><ul>'
    page += '<li>Les déconnexions normales libèrent les permis et distinguent une lane de transport incomplète d’un hôte Node défectueux. Une lane peut être remplacée sans relancer le processus. L’admission RSC bornée laisse se terminer les requêtes légitimes lors d’une rafale d’annulations ; une échéance réellement dépassée reste un motif de retrait.</li>'
    page += '<li>Le retrait au repos attend une échéance et le relâchement des réponses actives. memory vise 30 s, balanced 300 s pour sa lane principale ; speed la conserve. Les lanes supplémentaires se retirent après 30 s. L’activité suivie garde l’hôte Node réutilisable même sans lane : une tâche de cache légitime ne devient pas du repos simplement parce que son corps HTTP est terminé.</li>'
    page += '<li>Après le terminal HTTP normal, le contrôleur de la réponse est dissocié du socket avant finalizeCache : fermer une lane au repos ne transforme plus sa finalisation en annulation. Le délai de réponse RSC s’arrête à son terminal ; tant que du travail RSC reste suivi, un watchdog partagé sonde la réactivité après 5 s et attend son accusé pendant 30 s. Il limite une absence de réponse, pas la durée totale d’un travail asynchrone légitime, et n’a aucun timer au vrai repos.</li>'
    page += '<li>La destruction explicite du pool libère sa rétention d’activité et ferme stdin (EOF négocié). Le collecteur attend alors jusqu’à 30 s, puis tue et attend le processus bloqué. L’arrêt du runtime conserve kill_on_drop ; il ne promet pas ces 30 s après terminaison du serveur. Les tâches détachées arbitraires ne bénéficient pas d’une garantie de fin.</li>'
    page += '<li>Le chemin statique regroupe confinement du chemin, métadonnées et lecture courte dans une seule tâche bloquante ; le gzip précompressé conserve son chemin résolu et ses métadonnées. Les requêtes HTTP particulières gardent le traitement complet. Le scanner d’enveloppe HTML évite les copies intermédiaires par balise.</li>'
    page += '<li>memory autorise 20 réponses actives au lieu de 16, avec 8 démarrages de rendu et le budget de buffers de 1 Mio conservés. Les petits heaps et optimizeForSize restent actifs ; les expériences à 24 réponses et sans optimizeForSize sont séparées des résultats finaux.</li>'
    page += '<li>Le lockfile inclut les six dépendances natives optionnelles manquantes. reactCompiler:false et typedRoutes:false sont honorés ; leur activation est refusée explicitement. typescript:{} active un contrôle noEmit avec le TypeScript déjà installé dans l’application ; tsconfigPath sélectionne la configuration et ignoreBuildErrors:true désactive explicitement ce contrôle.</li></ul>'
    page += '<h2>Comparaison avant/après</h2>' + table(report['comparisons'], [('section', 'Campagne'), ('profile', 'Profil'), ('scenario', 'Scénario'),
        ('beforeRps', 'Avant req/s'), ('afterRps', 'Après req/s'), ('rpsChangePercent', 'Δ débit %'),
        ('cpuChangePercent', 'Δ CPU/réponse %'), ('rssChangePercent', 'Δ RSS médiane %'),
        ('p95ChangePercent', 'Δ p95 %'), ('p99ChangePercent', 'Δ p99 %'), ('beforeSource', 'Avant'), ('afterSource', 'Après')],
        'Variations des médianes ; seules les paires terminées sont comparées')
    page += '<p>Une hausse du CPU par réponse indique un coût accru, même si le débit augmente. Une hausse de RSS ou de p95/p99 est aussi un recul sur cet indicateur. Les étendues et effectifs ci-dessous permettent de juger la variabilité ; trois mesures ne donnent pas à elles seules un intervalle de confiance.</p>'
    page += '<h2>Dynamique</h2>' + table(report['dynamic'], fields, 'SSR 100 lignes / 64 connexions ; streaming 40 ms / 128 ; API JSON / 64')
    page += '<h2>Statique — mêmes fichiers et gzip</h2>' + table(report['static'], fields, 'Build figé commun aux deux exécutables ; 32 connexions')
    if (base / 'static-fixture-evidence.json').exists():
        page += '<p>' + link('static-fixture-evidence.json', 'Empreintes des sources, HTML, gzip, asset et fichier public') + '.</p>'
    if report.get('staticComparisonEvidence'):
        page += '<p>La paire statique finale dispose d’une fenêtre réservée après balanced, memory et l’endurance, pendant les 15 minutes de repos des trois profils avec au moins 680 s avant toute reprise (ou après leurs marqueurs finaux). Référence puis version corrigée, 3×30 s par route après 5 s d’échauffement. ' + link('static-final/evidence.json', 'Marqueurs de départ, fenêtre disponible, argv, horaires et SHA avant/après') + '. Ordre fixe ; aucune comparaison Nginx locale.</p>'
    if report.get('staticIdle'):
        page += table(report['staticIdle'], [('implementation', 'Version'), ('elapsedSeconds', 'Repos s'), ('cpuSeconds', 'CPU s'),
            ('cpuPercent', 'CPU % cœur'), ('rssBeforeMiB', 'RSS avant Mio'), ('rssAfterMiB', 'RSS après Mio'),
            ('threadsBefore', 'Threads avant'), ('threadsAfter', 'Threads après'), ('processesStarted', 'Créations'),
            ('firstResponseMs', '1re réponse ms'), ('source', 'Source')], 'Diagnostic distinct : retraite des threads après la charge statique')
        page += '<p>Ces fenêtres de repos et reprises ne sont pas ajoutées aux débits ni aux totaux de réponses. Ce repos inclut le retrait des threads bloquants et ne remplace pas les cycles des workers dynamiques. Une seule première réponse identity est mesurée par serveur ; la charge de débit utilise gzip. Les indicateurs génériques freshness/isolation du JSON de reprise ne sont pas applicables à ce fichier statique sans UUID ni cookie. Les processus et threads comptent tout le Job, y compris la console Windows.</p>'
    page += '<h2>Repos et reprise</h2><p>60 s initiales sans trafic dynamique, puis trois cycles charge/repos/reprise de 1, 5 et 15 minutes réelles. Une faible consommation initiale ne démontre aucun bug au repos. Comparer RSS et première reprise pour juger le compromis de retrait.</p>'
    page += table(report['idle'], [('implementation', 'Version / profil'), ('phase', 'Phase'), ('elapsedSeconds', 'Durée s'),
        ('cpuSeconds', 'CPU s'), ('cpuPercent', 'CPU % cœur'), ('rssEndMiB', 'RSS finale Mio'), ('processes', 'Processus'),
        ('threads', 'Threads'), ('processesStarted', 'Créations'), ('firstResponseMs', '1re réponse ms'),
        ('secondResponseMs', '2e réponse ms'), ('source', 'Source')], 'Compteurs cumulés et reprise mesurée, sans extrapolation')
    page += '<h2>Endurance</h2>' + table(report['endurance'], fields + [('rssFirstMinuteMiB', 'RSS 1re minute'),
        ('rssLastMinuteMiB', 'RSS dernière minute'), ('threadsStart', 'Threads début'), ('threadsEnd', 'Threads fin')], 'Charge continue ; durée indiquée par ligne')
    page += '<p>Un essai sans erreur ne garantit pas l’absence de fuite sur une durée supérieure. Les médianes de RSS des première et dernière minutes utilisent les horodatages des échantillons.</p>'
    page += '<h2>Fraîcheur, isolation, streaming et annulations</h2>'
    page += table(report['probes'], [('source', 'Sonde'), ('stage', 'Étape'), ('uniqueResponses', 'Réponses uniques'), ('cookieIsolation', 'Cookies isolés'),
        ('progressiveStreaming', 'Streaming progressif'), ('firstChunkMs', '1er fragment ms'), ('streamCompleteMs', 'Fin du stream ms'),
        ('cancellations', 'Annulations'), ('sameWorker', 'PID Node conservé'), ('survivorCompleted', 'Stream tiers terminé'),
        ('subsequentSsrHealthy', 'SSR suivant sain')], 'Sondes fonctionnelles indépendantes du générateur de débit')
    page += '<p>La rafale de 32 annulations interrompait une réponse tierce avant correction. La sonde de rafale vérifie la survie de ce stream et du SSR suivant. Le PID Node ne révèle pas les redémarrages de worker_threads dans ce processus. Les tentatives intermédiaires conservées ne remplacent pas la vérification finale explicitement identifiée.</p>'
    page += table([{'source': n, **v} for n, v in report['serverLogs'].items()], [('source', 'Journal'), ('failedLaneWarnings', 'Avertissements de lane'),
        ('unresponsiveWorkers', 'Retraits hôte non réactif'), ('gracefulDeadlineExceeded', 'Délai arrêt dépassé'),
        ('unresponsiveRscWork', 'Watchdog RSC'), ('rscBackgroundWorkErrors', 'Erreurs travail RSC'),
        ('rscExitErrors', 'Occurrences sortie RSC'), ('epipe', 'Occurrences EPIPE')], 'Occurrences textuelles des journaux de mesures terminées')
    page += '<p>« restarting render worker after failed request » compte une lane remise à zéro, pas nécessairement un processus Node redémarré. Les créations du Job incluent tous les types de processus. Les occurrences de sortie RSC peuvent se répéter pour plusieurs requêtes : elles ne comptent pas des isolats uniques. Ces indicateurs restent séparés.</p>'
    page += '<h2>Arrêt du pool et drainage après réponse</h2>' + table(report['shutdownProbes'], [('source', 'Sonde'), ('stage', 'Étape'),
        ('cacheDurationMs', 'Travail cache ms'), ('shutdownToExitMs', 'Arrêt → sortie ms'), ('cacheCompleted', 'Travail terminé'), ('exitCode', 'Code sortie')],
        'Fermeture de stdin et du lecteur stdout pendant une finalisation asynchrone après réponse 200')
    page += '<p>L’EPIPE mentionné dans le signalement initial sous déconnexion client n’a pas été reproduit. Une autre erreur EPIPE a été identifiée pendant le développement du candidat v2 : son heartbeat écrivait encore après fermeture du lecteur de contrôle, et interrompait le cache lors de l’arrêt du pool. La correction v3 regroupe EOF et erreur du pipe en un arrêt idempotent qui laisse le travail suivi se terminer. Ce défaut découvert pendant l’implémentation n’est pas attribué à la référence initiale.</p>'
    page += '<h2>Tests et limites connues</h2>' + table(report['testLogs'], [('source', 'Journal'), ('stage', 'Étape'), ('tests', 'Tests'), ('pass', 'Succès'),
        ('fail', 'Échecs'), ('skipped', 'Ignorés'), ('filteredOut', 'Exclus par filtre'), ('status', 'État')], 'Dernier résumé Node ou somme des binaires de tests Cargo par journal ; les relances restent séparées')
    test_evidence = [('unit-tests-verified.exit.json', 'Commande et sortie de la suite complète'),
                     ('next-conformance-verified-exit.json', 'Comparaison Next/PRNext exécutée en v2, compilateur inchangé'),
                     ('native-v3-build.json', 'Build release final et empreintes des sources Rust')]
    page += '<p>' + ' · '.join(link(name, label) for name, label in test_evidence if (base / name).is_file()) + '</p>'
    page += '<p>Les journaux <code>*-verified.log</code> nouvellement exécutés identifient les vérifications finales : suite unitaire complète, E2E et tests RSC ciblés ; leurs copies précédentes restent étiquetées. Les journaux Rust ciblés indiquent aussi les tests exclus par leur filtre ; ces suites se recouvrent et leurs effectifs ne doivent pas être additionnés. Les échecs intermédiaires restent visibles : nettoyage Windows EBUSY, puis sortie prématurée du CLI avant publication du manifeste. La correction du second conserve la référence du worker pendant sa terminaison ; un test vérifie dix continuations de build dans un sous-processus. Les nouvelles régressions couvrent aussi le travail après réponse, le watchdog et la finalisation du cache après fermeture du socket.</p>'
    page += '<p>Sans option typescript, la transpilation seule reste le comportement historique ; aucun next-env.d.ts, type de route ou plugin de langage Next.js n’est généré. Le développement ne lance pas le contrôle de types.</p>'
    page += '<p>L’installation réelle a été exécutée sur Windows x64 uniquement ; les autres plateformes sont contrôlées par le lockfile et les métadonnées, sans essai natif local. Le test unitaire ignoré demande des headers de développement Node-API absents de cette machine. Les deux contrats de comparaison Next.js ciblent des comportements précis et ne prouvent pas une conformité exhaustive.</p>'
    page += '<p>La suite unitaire complète et les 85 E2E ont été relancés sur le runtime final v3. Les deux contrats Next et les 33 tests Rust datent de v2 : les composants du compilateur concernés et le code/binaire Rust sont inchangés par la dernière correction JavaScript du pipe de contrôle. Les trois tests ciblés de fermeture des pipes couvrent cette dernière modification.</p>'
    page += '<p>Les garanties de suivi d’activité, de finalisation après réponse et de drainage nécessitent de reconstruire l’application avec <code>prnext build</code>. Un ancien artefact peut rester compatible avec le protocole sans bénéficier de ces garanties : son worker ne protège pas le travail après End lors du retrait des lanes, y compris les lanes supplémentaires de speed/classic.</p>'
    page += '<p>Les tests statiques comparent GET, HEAD, gzip et négociation pondérée, Range/If-Range, validation 304, POST, modification/suppression de fichier et confinement des chemins. Les tests Unix de symlink et du cache de fichiers demandent une exécution Unix ; ce cache est désactivé sur Windows. Ni un gain face à Nginx, ni l’absence de toute fuite, ni un débit de production ne sont déduits de ces essais locaux.</p>'
    diagnostics = [('static-preparation-results.json', 'Micro-mesure du chemin statique'), ('html-envelope-results.json', 'Micro-mesure du scanner HTML'),
                   ('tuning/summary.json', 'Essai optimizeForSize'), ('tuning/memory24-summary.json', 'Essai exploratoire memory à 24 réponses'),
                   ('tuning/profile-rsc-ssr.cpuprofile', 'Profil RSC SSR brut'), ('tuning/profile-rsc-ssr.cpuprofile.summary.json', 'Résumé RSC SSR'),
                   ('tuning/profile-rsc-stream.cpuprofile', 'Profil RSC streaming brut'), ('tuning/profile-rsc-stream.cpuprofile.summary.json', 'Résumé RSC streaming'),
                   ('blocking32/summary.json', 'Répétition calme et essai du pool bloquant à 32 threads'), ('blocking32/README.md', 'Protocole et limites du diagnostic cap32')]
    page += '<h2>Diagnostics séparés des résultats finaux</h2><p>' + ' · '.join(link(n, label) for n, label in diagnostics if (base / n).exists()) + '</p>'
    page += '<p>Les micro-mesures isolent une opération, sans mesurer le serveur HTTP entier. Les réglages sont testés deux fois pendant 15 s, séquentiellement, sur un binaire provisoire ; le premier balanced-default contaminé par une compilation a été écarté et rejoué. Désactiver optimizeForSize augmente la RSS : changement non retenu. Le réglage à 24 réponses ne représente pas memory final à 20.</p>'
    page += '<p>Les premiers profils Inspector de 5 s couvrent seulement l’isolat hôte Node. Les captures complémentaires profile-rsc-ssr et profile-rsc-stream instrumentent uniquement le thread RSC dans une copie du build candidat v1 : le GC apparaît dans les samples SSR, tandis que le stream est presque entièrement échantillonné inactif. Aucun profil ne couvre Rust. L’échantillonnage et son coût empêchent d’attribuer le CPU total au GC ou de comparer directement sa part entre profils. Le CPU du Job reste la mesure globale. Le drapeau V8 de diagnostic est modifié à l’exécution et peut affecter les futurs isolats ; ce n’est pas exactement un changement au démarrage.</p>'
    if (base / 'blocking32/summary.json').is_file():
        page += '<p>Le diagnostic cap32 est limité au candidat v1 : deux mesures de 15 s par route, puis 15 s de repos, dans un ordre fixe. Le pool bloquant Tokio atteignait environ 512 threads sur le statique avant comme après correction ; il ne s’agit pas de workers Node. La variante à 32 réduit les threads, mais ses effets sur débit, RSS et reprise sont mitigés : elle n’est pas intégrée. Les mesures calmes ne reproduisent pas les régressions de débit asset et SSR balanced du premier passage v1 ; elles ne prouvent pas leur absence sur une charge plus longue. Les résultats complets et leurs étendues restent séparés des mesures finales.</p>'
    page += '<details><summary>État des entrées et provenance</summary>' + table(report['inputs'], [('source', 'Fichier'), ('status', 'État'), ('detail', 'Détail')], 'JSON tronqués ou sans marqueur final exclus')
    page += '<p>Généré à ' + html.escape(report['generatedAtUTC']) + '. SHA-256 des octets lus ; les journaux encore en cours peuvent évoluer.</p></details>'
    page += '<p>Comptabilité : <a href="https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs#resource-accounting-for-nested-jobs">Jobs Windows imbriqués, documentation Microsoft</a>. ' + link('summary.json', 'Résultats structurés et empreintes') + '.</p></body></html>\n'
    return page


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=pathlib.Path, default=DEFAULT_BASE)
    parser.add_argument('--exclude-test-log', action='append', default=[], help='Log glob to omit when freezing an earlier candidate while later tests run')
    args = parser.parse_args()
    args.base.mkdir(parents=True, exist_ok=True)
    report = collect(args.base, args.exclude_test_log)
    (args.base / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    (args.base / 'report.html').write_text(render(report, args.base), encoding='utf-8')
    print(json.dumps({section + 'Rows': len(report[section]) for section in ('dynamic', 'static', 'idle', 'endurance')}))


if __name__ == '__main__':
    main()
