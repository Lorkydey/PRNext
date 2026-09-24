"""Validate raw measurements and create portable HTML, CSV and Markdown reports."""
import csv
import hashlib
import json
import math
from pathlib import Path
from statistics import median

root = Path('reports/hot-path-optimization')
report = json.loads((root / 'results.json').read_text())
runs = report['results']
assert len(runs) == 99
assert report['repetitions'] == 3
assert hashlib.sha256(Path('target/release/rustyx').read_bytes()).hexdigest() == report['hashes']['rustyx']
assert hashlib.sha256((root / 'baseline/target/release/rustyx').read_bytes()).hexdigest() == report['hashes']['before']
assert hashlib.sha256(Path('scripts/migration-load.mjs').read_bytes()).hexdigest() == report['hashes']['client']
def validate_measurement(row):
    assert row['cpuValid'] and not row['errors'] and not row['reachedCap']
    assert not row['disappearedPids'] and row['requests'] == row['attempts']
    assert row['memorySamples'] >= 10
    assert math.isclose(row['requestsPerSecond'], row['requests'] * 1000 / row['elapsedMs'], rel_tol=1e-10)
    assert math.isclose(row['cpuMsPerRequest'], row['serverCpuMs'] / row['requests'], rel_tol=1e-10)
    assert math.isclose(row['serverCpuMs'], row['afterLoad']['cpuMs'] - row['afterWarmup']['cpuMs'], abs_tol=1e-7)

for row in runs:
    validate_measurement(row)
for site, hashes in report['projects'].items():
    assert hashlib.sha256((root/'projects'/site/'.rustyx/manifest.json').read_bytes()).hexdigest() == hashes['manifest']

sustained_path = root/'sustained.json'
sustained = json.loads(sustained_path.read_text()) if sustained_path.exists() else None
if sustained:
    assert sustained['durationMs'] == 60000 and sustained['repetitions'] == 1
    assert sustained['hashes'] == report['hashes'] and sustained['projects'] == report['projects']
    assert len(sustained['results']) == 2
    assert {row['engine'] for row in sustained['results']} == {'next','rustyx'}
    for row in sustained['results']:
        assert row['site'] == 'dashboard' and row['scenario'] == 'mixed-64' and row['concurrency'] == 64
        validate_measurement(row)
        validate_measurement(row['recovery'])
        assert row['idleAfter']['processes']

flight_path = root/'flight-sustained.json'
flight = json.loads(flight_path.read_text()) if flight_path.exists() else None
if flight:
    assert flight['durationMs'] == 30000 and flight['repetitions'] == 1
    assert flight['hashes'] == report['hashes'] and flight['projects'] == report['projects']
    assert len(flight['results']) == 2 and {row['engine'] for row in flight['results']} == {'next','rustyx'}
    for row in flight['results']:
        assert row['site'] == 'dashboard' and row['scenario'] == 'ppr-flight' and row['concurrency'] == 4
        validate_measurement(row)

labels = {'isr-hit':'Hit ISR', 'image-hot':'Image en cache', 'api-pages':'API Pages', 'ppr-flight':'Flight PPR', 'ppr-html':'HTML PPR', 'api-async':'API attente 30 ms', 'upload':'Upload API 32 Kio', 'mixed-64':'Parcours mixte · C64', 'async-512':'API asynchrone · C512'}
metrics = ['requestsPerSecond','cpuMsPerRequest','loadMedianRssMiB','sampledPeakRssMiB','p95Ms','p99Ms','cpuPercentOneCore','meanBodyBytes']
summary = []
for site, scenario in dict.fromkeys((row['site'],row['scenario']) for row in runs):
    label = labels[scenario]
    if scenario == 'api-pages':
        label += ' POST' if site == 'journal' else ' GET'
    item = {'site':site,'scenario':scenario,'label':f'{label} · {site}', 'engines':{}}
    for engine in ['before','rustyx','next']:
        rows = [row for row in runs if (row['site'],row['scenario'],row['engine']) == (site,scenario,engine)]
        assert sorted(row['repetition'] for row in rows) == [1,2,3]
        item['engines'][engine] = {metric:median(row[metric] for row in rows) for metric in metrics}
        item['engines'][engine]['ranges'] = {metric:[min(row[metric] for row in rows),max(row[metric] for row in rows)] for metric in metrics}
    item['versusNext'] = {metric:100*(item['engines']['rustyx'][metric]/item['engines']['next'][metric]-1) for metric in metrics}
    item['versusBefore'] = {metric:100*(item['engines']['rustyx'][metric]/item['engines']['before'][metric]-1) for metric in metrics}
    summary.append(item)
functional = json.loads((root/'functional.json').read_text())
assert all(check['equal'] for site in functional['sites'] for check in site['comparisons'])
assert sum(len(site['comparisons']) for site in functional['sites']) == 36
validation = {'status':'passed','trials':len(runs),'responses':sum(row['requests'] for row in runs),'errors':sum(row['errors'] for row in runs),'functionalPairs':36,'binarySha256':report['hashes']['rustyx'],'sourceParity':report['projects']}
if sustained:
    validation['sustained'] = {'trials':2,'durationMs':60000,'responses':sum(row['requests'] for row in sustained['results']),'recoveryResponses':sum(row['recovery']['requests'] for row in sustained['results']),'errors':0}
if flight:
    validation['flightSustained'] = {'trials':2,'durationMs':30000,'responses':sum(row['requests'] for row in flight['results']),'errors':0}
(root/'validation.json').write_text(json.dumps(validation,indent=2)+'\n')
(root/'summary.json').write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n')
with (root/'summary.csv').open('w',newline='') as out:
    writer=csv.DictWriter(out,fieldnames=['site','scenario','engine',*metrics]);writer.writeheader()
    for item in summary:
        for engine,values in item['engines'].items():writer.writerow({'site':item['site'],'scenario':item['scenario'],'engine':engine,**{key:values[key] for key in metrics}})
with (root/'measurements.csv').open('w',newline='') as out:
    fields=['site','scenario','engine','repetition','concurrency','requests','errors',*metrics]
    writer=csv.DictWriter(out,fieldnames=fields);writer.writeheader()
    for row in runs:writer.writerow({key:row[key] for key in fields})

lines=['# Comparaison après optimisation des chemins fréquents','',f"{len(runs)} essais, {validation['responses']:,} réponses valides, aucune erreur. Médianes de trois mesures de cinq secondes. C4 sauf les parcours mixtes C64 et l’API C512. Apple M4, 16 Gio, Node {report['machine']['node']}, Next {report['machine']['next']} / webpack.",'','| Scénario | CPU Next → Rustyx, ms/réponse | CPU vs Next | RAM Next → Rustyx, Mio | RAM vs Next | Débit vs Next |','|---|---:|---:|---:|---:|---:|']
for item in summary:
    n,r=item['engines']['next'],item['engines']['rustyx'];v=item['versusNext']
    lines.append(f"| {item['label']} | {n['cpuMsPerRequest']:.4f} → {r['cpuMsPerRequest']:.4f} | {v['cpuMsPerRequest']:+.1f} % | {n['loadMedianRssMiB']:.1f} → {r['loadMedianRssMiB']:.1f} | {v['loadMedianRssMiB']:+.1f} % | {r['requestsPerSecond']/n['requestsPerSecond']:.2f}× |")
lines += ['','## Face à l’ancien Rustyx','','| Scénario | CPU/réponse | RAM médiane | Débit |','|---|---:|---:|---:|']
for item in summary:
    v=item['versusBefore'];lines.append(f"| {item['label']} | {v['cpuMsPerRequest']:+.1f} % | {v['loadMedianRssMiB']:+.1f} % | {v['requestsPerSecond']:+.1f} % |")
if sustained:
    lines += ['','## PPR mixte prolongé à 64 clients','','Une observation de 60 secondes par moteur, puis 15 secondes de repos et un contrôle de récupération de deux secondes. Ces résultats restent séparés des médianes de la campagne principale.','','| Moteur | Réponses/s | CPU ms/réponse | RSS médian | Pic RSS échantillonné | RSS en fin de charge | RSS après 15 s de repos | Erreurs charge / récupération |','|---|---:|---:|---:|---:|---:|---:|---:|']
    for row in sustained['results']:
        lines.append(f"| {row['engine']} | {row['requestsPerSecond']:.0f} | {row['cpuMsPerRequest']:.4f} | {row['loadMedianRssMiB']:.1f} Mio | {row['sampledPeakRssMiB']:.1f} Mio | {row['afterLoad']['rssMiB']:.1f} Mio | {row['idleAfter']['rssMiB']:.1f} Mio | {row['errors']} / {row['recovery']['errors']} |")
    lines += ['','Le RSS peut rester élevé après repos : V8 et les allocateurs ne restituent pas immédiatement toute la mémoire inutilisée au système. Ces relevés ne suffisent pas à exclure une fuite lente. [Mesures prolongées](sustained.json).']
if flight:
    lines += ['','## Flight PPR seul pendant 30 secondes','','Une observation par moteur à quatre clients, pour vérifier le coût sur une durée supérieure aux essais courts. Elle ne constitue pas une répétition supplémentaire de la médiane principale.','','| Moteur | Réponses/s | CPU ms/réponse | RSS médian Mio | Pic RSS échantillonné Mio | Erreurs |','|---|---:|---:|---:|---:|---:|']
    for row in flight['results']:
        lines.append(f"| {row['engine']} | {row['requestsPerSecond']:.0f} | {row['cpuMsPerRequest']:.4f} | {row['loadMedianRssMiB']:.1f} | {row['sampledPeakRssMiB']:.1f} | {row['errors']} |")
    lines += ['','[Mesures Flight prolongées](flight-sustained.json).']
lines += ['','## Interprétation','','Le CPU indiqué est le temps processeur de tous les processus serveur, divisé par le nombre de réponses valides. Un serveur plus rapide peut consommer davantage de CPU total à saturation tout en coûtant moins par réponse. Le RSS inclut les workers Node et RSC ; il peut compter plusieurs fois certaines pages partagées. Les pics sont échantillonnés, pas garantis instantanés.','','Pendant la campagne finale, une analyse de stockage macOS a été observée à environ un cœur CPU en arrière-plan (background-observations.jsonl). Elle est exclue de la comptabilité serveur, mais peut augmenter la dispersion et modifier les conditions de concurrence. Aucune répétition n’a été éliminée en fonction de son résultat. Refaire le banc au repos avant de dimensionner un serveur.','','Les cinq projets ont les mêmes sources pour les deux moteurs, et 36 comparaisons fonctionnelles passent. Le générateur de charge est un processus séparé, mais partage ce Mac avec le serveur. Les moteurs sont lancés successivement, dans des ordres alternés. Les petits écarts et les plages de répétitions qui se recouvrent ne démontrent pas une supériorité stable.','','La compression est identique sur les charges de ce rapport : identity, et la même image WebP de 2 254 octets. Les tailles HTML/Flight peuvent différer entre implémentations. Chaque réponse dynamique est vérifiée avec un identifiant de visiteur ou de recherche propre à la requête.','','Chaque essai redémarre le serveur. Sur les hits ISR et images seuls, Rustyx peut éviter de lancer Node : leur très faible RSS ne représente pas un site après un rendu React dynamique. Les parcours mixtes mesurent aussi les workers démarrés.','','Ces mesures couvrent des charges locales de quelques secondes et des caches chauds. Elles ne prouvent ni une compatibilité Next exhaustive, ni la capacité d’un VPS Linux, ni l’endurance sur plusieurs jours. Le tas applicatif Node n’a pas de plafond global ajouté par ces optimisations. La RAM des pages dynamiques demeure principalement celle de JavaScript et React.','','[Données brutes](results.json) · [CSV](summary.csv) · [Contrôles indépendants](validation.json) · [Comparaisons fonctionnelles](functional.json) · [Détails des changements](../../docs/hot-path-optimization.md)']
(root/'analysis.md').write_text('\n'.join(lines)+'\n')

from render_hot_path_page import render_page

(root/'performance.html').write_text(render_page(summary, report, validation, sustained, flight))
print(json.dumps(validation,indent=2))
