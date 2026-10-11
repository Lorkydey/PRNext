"""Render evidence-derived HTML. Publishing the active report is a separate step."""
import argparse
import collections
import html
import importlib.util
import json
import pathlib
import re
import statistics
import math

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('analysis', HERE/'analyze-v6.py')
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
OUT = a.OUT
e = html.escape


def num(value, digits=1):
    return '—' if value is None else f'{value:,.{digits}f}'.replace(',', '\u202f')


def span(value, digits=1):
    if not value:
        return '—'
    return num(value['median'], digits) + f'<span class="range">{num(value["min"], digits)}–{num(value["max"], digits)} · n={value["n"]}</span>'


def link(path, title=None):
    return f'<a href="{e(path, quote=True)}">{e(title or path)}</a>'


def table(headers, rows, caption=''):
    return '<div class="scroll"><table>' + (f'<caption>{caption}</caption>' if caption else '') + '<thead><tr>' + ''.join(f'<th scope="col">{h}</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>'+''.join('<td>'+(str(v) if v is not None else '—')+'</td>' for v in row)+'</tr>' for row in rows) + '</tbody></table></div>'


def details(title, body):
    return f'<details><summary>{title}</summary>{body}</details>'


def section(identifier, title, body):
    return f'<section id="{identifier}"><h2>{title}</h2>{body}</section>'


def paired(data, key, digits=1):
    old, new = data.get('v5'), data.get('v6')
    if not old or not new:
        return 'En attente'
    x, y = old['stats'][key], new['stats'][key]
    if not x or not y:
        return '—'
    delta = 100 * (y['median']/x['median']-1) if x['median'] else None
    eligible = all(r['cleanCapacityRuns']==r['attemptedRuns']==r['repetitions'] for r in (old,new))
    note = f'Δ {num(delta)} %' if eligible else 'indicatif · voir erreurs/marge'
    extent = f'V5 {num(x["min"], digits)}–{num(x["max"], digits)} · V6 {num(y["min"], digits)}–{num(y["max"], digits)} · n={x["n"]}/{y["n"]}'
    return f'{num(x["median"], digits)} → {num(y["median"], digits)}<span class="range">{note}<br>{extent}</span>'


def matrix_section(data):
    summary = data['summary']
    buckets = collections.defaultdict(dict)
    for row in summary:
        if row['phase'] == 'all':
            buckets[(row['apps'], row['budgetMiB'], row['profile'])][row['variant']] = row
    rows = []
    for (apps, budget, profile), pair in sorted(buckets.items()):
        quality = []
        for version in ('v5', 'v6'):
            r = pair.get(version)
            quality.append(f'{version}: {r["cleanCapacityRuns"]}/{r["attemptedRuns"]}<br>{r["missingPhaseRuns"]} phase absente, {r["incompleteRuns"]} exécution interrompue' if r else version+': attente / aucune phase mesurée')
        errors = ' → '.join(f'{pair[v]["errors"]} / {pair[v]["warmupErrors"]}' if v in pair else '—' for v in ('v5', 'v6'))
        events = ' → '.join(str(pair[v]['runMemoryLimitEvents']) if v in pair else '—' for v in ('v5', 'v6'))
        rows.append([f'{apps} / {budget}', e(profile), paired(pair, 'rps'), paired(pair, 'cpuMsPerUseful', 3), paired(pair, 'rssMedianMiB'), paired(pair, 'privateCommitMedianMiB'), errors, events, '<br>'.join(quality)])
    body = '<p>Instances <code>prnext start</code> indépendantes : un cœur CPU et un budget de commit communs au groupe. Ce test ne mesure pas le proxy de <code>prnext host</code>. Deux répétitions, ordre V5/V6 inversé ; 5 s d’échauffement puis 20 s toutes actives, 40 s une seule active, 20 s avec un voisin bruyant. Quelques références V5 du premier passage sont réutilisées après le dernier correctif : leurs paires ne sont pas contiguës dans le temps ; le second passage est neuf, en ordre inverse. Sous pression (4/512 et 8/1024), seule la phase toutes actives est exécutée. Le mélange alterne SSR, streaming et API ; aucun cache de page dynamique.</p>'
    body += table(['Apps / budget Mio', 'Profil', 'req/s V5 → V6', 'CPU ms/rép.', 'RSS médiane Mio', 'Commit privé Mio', 'Erreurs charge / échauff.', 'Limite mémoire, essai entier', 'Essais avec marge générateur'], rows, 'Médianes par configuration. Les erreurs, allocations refusées et essais avec générateur chargé restent visibles ; ils ne démontrent pas un gain de capacité. Les écarts ne sont calculés que pour des paires entièrement admissibles. Deux répétitions ne fournissent pas un intervalle de confiance.')
    body += '<h3>Confirmation du budget limite avec balanced-small</h3><p>Dans les 80 essais initiaux, huit applications sous 1 Gio passent deux fois en V5 ; V6 subit un refus d’allocation native dans un passage sur deux (721 requêtes échouées). Trois paires supplémentaires, alternées et isolées, examinent ce résultat. Elles restent séparées des essais initiaux.</p>'
    body += phase_table([r for r in data['runs'] if r.get('pressureConfirmation')],lambda r,p:p['phase']=='all')
    body += '<p><strong>Résultat confirmé, limitation restante :</strong> en réunissant les deux passages initiaux et les trois confirmations, 2/5 essais V6 rencontrent une limite mémoire, contre 0/5 en V5. Le premier tue un processus natif, le second un processus Node et provoque quatre réponses 502. Les logs restent visibles. Le manque de commit est confirmé ; l’origine fine de l’écart entre versions n’est pas isolée. Les '+link('pressure-memory-breakdown.json','sommes de commit par type de processus')+' montrent des valeurs natives proches, tandis que Node domine le budget. Cette variante n’est pas retenue par défaut.</p>'
    rows = []
    for r in summary:
        if r['variant'] != 'v6' or r['phase'] not in ('one', 'noisy') or r['apps'] == 1:
            continue
        neighbours = r['latencyByApplication'][1:]
        neighbour_p95 = [v['p95']['median'] for v in neighbours if v['p95']]
        neighbour_p99 = [v['p99']['median'] for v in neighbours if v['p99']]
        rows.append([f'{r["apps"]} / {r["budgetMiB"]}', r['profile'], r['phase'], span(r['stats']['rps']), span(r['stats']['rssAfterMiB']), span(r['stats']['nodesAfter'], 0), span(a.spread(neighbour_p95)), span(a.spread(neighbour_p99)), r['errors']])
    body += '<h3>Applications voisines et retrait des workers</h3><p>Dans <code>one</code>, les applications voisines ne reçoivent aucune requête : leurs quantiles sont absents (« aucun échantillon »). Le repos de 40 s dépasse le délai <code>memory</code> de 30 s, mais pas celui de <code>balanced</code> (300 s). Dans <code>noisy</code>, l’application 0 a 128 connexions ; chaque voisine a une connexion espacée de 100 ms.</p>'
    body += table(['Apps / budget', 'Profil V6', 'Phase', 'req/s utiles', 'RSS après Mio', 'Node après', 'p95 voisines ms', 'p99 voisines ms', 'Erreurs'], rows, 'Pour les voisines, médiane et étendue des quantiles par application ; aucune fusion artificielle en quantile global.')
    rows = []
    for r in summary:
        for app in r['latencyByApplication']:
            rows.append([f'{r["apps"]}/{r["budgetMiB"]}', r['variant'], r['profile'], r['phase'], app['index'], span(app['rps']), span(app['p50']), span(app['p95']), span(app['p99']), span(app['maxLatencyMs']), '<br>'.join(link(p, 'Brut '+str(i+1)) for i, p in enumerate(r['runs']))])
    body += details('Débit, p50/p95/p99 et maximum de chaque application et répétition', table(['Apps/Mio','Version','Profil','Phase','App','req/s','p50 ms','p95 ms','p99 ms','Max. ms','Preuves'], rows))
    rows = []
    for r in data['runs']:
        rows.append([link(r['path'], r['label']), 'retenu' if r['includedInComparison'] else 'confirmation séparée' if r.get('pressureConfirmation') else 'exclu / interrompu', r['complete'], sum(p['errors'] for p in r['phases']), r['memoryLimitEvents'], r['workerLogCounts']['restarting render worker after failed request'], r['workerLogCounts']['epipe'], e(str(r['error'] or '')), '<br>'.join(e(line) for values in (r['oomLogs'] or {}).values() for line in values[:2])])
    body += details('Toutes les tentatives : erreurs et exclusions conservées', table(['Essai','Portée','Exécution finie','Événements d’erreur, échauffement inclus','Limite mémoire','Redémarrages consignés','EPIPE','Erreur du banc','Extraits allocation'], rows))
    return body


def phase_table(runs, select):
    rows = []
    for r in runs:
        for p in r.get('phases', []):
            if not select(r, p):
                continue
            app_p = lambda k: span(a.spread([x[k] for x in p['apps']]))
            rows.append([link(r['path'], r.get('label', r.get('variant'))), p['phase'], num(p['rps']) if p['apps'] else '—', num(p['cpuMsPerUseful'], 3), num(p['cpuPercent'],3), num(p['rssMedianMiB']), num(p['rssMaxMiB']), app_p('p50'), app_p('p95'), app_p('p99'), p['failedRequestsExcluding503'], p['rejected'], p['memoryLimitEvents'], 'oui' if p['capacity']['capacityClaimEligible'] else 'non'])
    return table(['Essai','Phase','req/s','CPU ms/rép.','CPU % d’un cœur','RSS méd.','RSS pic','p50 ms','p95 ms','p99 ms','Requêtes en échec hors 503','503','Limite','Marge client'], rows, 'Débits additionnés ; quantiles des réponses utiles résumés par application et générateur (pas de p99 global). RSS en Mio ; échantillonnage 0,5 s. Le CPU du repos inclut le retrait des workers et le superviseur. Échecs distincts = lancées − utiles − 503 après drainage ; les événements bruts peuvent compter deux erreurs pour une même requête.')


def control_summary(runs, prefix, *, large=False):
    rows=[]
    for version in ['v5','v6']:
        phases=[p for r in runs if r['label'].startswith(prefix) and r['variant']==version for p in r['phases'] if p['phase']=='measure']
        if not phases:continue
        latencies=lambda k:a.spread([app[k] for p in phases for app in p['apps']])
        row=[version,span(a.spread([p['rps'] for p in phases])),span(a.spread([p['cpuMsPerUseful'] for p in phases]),3),span(a.spread([p['rssMedianMiB'] for p in phases])),span(latencies('p95')),span(latencies('p99')),f'{sum(p["successfulCapacityClaimEligible"] for p in phases)}/{len(phases)}']
        if large:row.insert(2,span(a.spread([p['rps']/32 for p in phases]),3))
        rows.append(row)
    headers=['Version','req/s médiane et étendue','CPU ms/rép.','RSS Mio','p95 ms','p99 ms','Répétitions avec marge']
    if large:headers.insert(2,'Gio/s utiles')
    return table(headers,rows,'Synthèse des répétitions. Débits additionnés entre générateurs dans chaque essai ; quantiles résumés par générateur, jamais fusionnés en p99 global.')


def static_section(d):
    body = '<p><strong>Problème reproduit :</strong> V5 atteint un pic de 2 048 tâches en file ; le maximum de tâches actives est de 4. Le candidat limite le travail soumis à 16, avec 64 opérations/réponses de fichier actives et 128 attentes par porte. Une attente expire après 2 s ; l’excès reçoit 503, <code>Retry-After: 1</code> et <code>Cache-Control: no-store</code>.</p><p>Le plafond de threads seul ne suffisait pas. Les permis suivent l’exécution réelle et la lecture en cours, y compris après une déconnexion. Une file de transfert d’une trame assure la backpressure des gros fichiers. Aucun timer d’observation ne tourne sans activation explicite.</p>'
    body += '<h3>Surcharge progressive</h3>'
    body += phase_table(d['static']['runs'], lambda r, p: r['instrumented'])
    body += '<p>À 2 048 connexions sur le fichier de 32 Mio, V5 enregistre un événement de limite mémoire et des échecs de transport ; le candidat répond explicitement à l’excès et récupère. Les générateurs saturent dans certains essais : ces chiffres prouvent le comportement en surcharge et les bornes observées, pas un gain de débit maximal.</p>'
    body += '<h3>Petit HTML gzip : coût de la correction</h3><p>Le premier candidat d’admission avait montré −5,7 % de débit, avec une marge insuffisante du cœur générateur dans certains intervalles. Toutes les mesures de la version finale sont répétées. La série ci-dessous utilise deux générateurs, 32 connexions au total, 3 × 30 s, sans instrumentation ; les essais avec un seul générateur restent dans les données brutes.</p>'
    body += control_summary(d['extras']['runs'],'small-')
    body += '<p>Médianes finales : 3 665,4 → 3 522,0 req/s (−3,9 %) et 0,2655 → 0,2762 ms CPU/réponse (+4,0 %). Une répétition sur trois dispose de la marge conservatrice requise dans chaque version ; les étendues se chevauchent. C’est une régression observée sur cette machine, pas une estimation précise et universelle du coût du code.</p>'
    body += phase_table(d['extras']['runs'], lambda r, p: r['label'].startswith('small-') and p['phase'] == 'measure')
    body += '<h3>Gros fichiers et réglage de concurrence</h3><p>La première série de gros transferts utilisait un générateur saturé ; elle est exclue des conclusions de capacité. Le contrôle ci-dessous répartit huit connexions sur quatre générateurs. Le balayage 4/16/32/64 change uniquement <code>PRNEXT_FILE_WORK_CONCURRENCY</code> : même binaire, pas un nouveau profil.</p>'
    body += control_summary(d['followup']['runs'],'large-',large=True)
    body += '<p>Les quatre générateurs de gros fichiers réduisent leur CPU moyen individuel à environ 44–57 %, mais le p95 d’activité de leurs cœurs reste trop élevé pour une conclusion de capacité. Aucun gain net n’est démontré. Sur le petit statique, passer de 16 à 64 tâches soumises donne environ +5 % dans deux essais courts ; le défaut 16 reste celui couvert par la surcharge et l’heure d’endurance finales.</p>'
    body += phase_table(d['followup']['runs'], lambda r, p: (r['label'].startswith('large-') or r['label'].startswith('work-limit-')) and p['phase'] == 'measure')
    rows = []
    for r in d['followup']['runs']:
        if r.get('burst'):
            b = r['burst']; v = b['value']
            rows.append([link(r['path'], r['label']), v.get('started'), e(str(v.get('statuses'))), v.get('unexpectedErrors'), v.get('invalid503'), v.get('plannedCloses'), num(b['rssMaxMiB']), num(b['cpuSeconds'],3), e(str(r['recovery'])), r['complete']])
    body += '<h3>Rafales de clients lents et annulation</h3>' + table(['Essai','Clients','Statuts','Erreurs inattendues','503 invalides','Fermetures voulues','RSS pic Mio','CPU total s','Reprise HTTP','Exécution finie'], rows)
    rows = []
    for r in d['static']['runs'] + d['followup']['runs']:
        for m in r.get('metrics', []):
            if not m:
                continue
            f = m['final']; gate = f.get('fileAdmission') or {}; work = f.get('fileWorkAdmission') or {}
            prep = next((v for v in f['operations'] if v['origin'] == 'static.prepare'), {})
            rows.append([link(m['path'], r.get('label', r.get('variant'))), prep.get('peakQueued'), prep.get('peakActive'), gate.get('peakActive'), gate.get('peakWaiting'), gate.get('peakWaitingHeaderBytes'), num(gate.get('maxWaitNs',0)/1e6), gate.get('cancelledWaits'), f'{gate.get("active", "—")}/{gate.get("waiting", "—")}', f'{work.get("active", "—")}/{work.get("waiting", "—")}'])
    body += details('Compteurs de files après drainage', table(['Brut','File bloquante pic','Actives pic','Fichiers pic','Attentes pic','Octets en-têtes pic','Attente max ms','Attentes annulées','Fichiers act./att. fin','Travail act./att. fin'], rows))
    body += '<p><code>waitingHeaderBytes</code> estime seulement le contenu URI + en-têtes, pas la RAM totale. Le compteur <code>static.prepare</code> ne voit pas les lectures asynchrones internes de ServeFile : celles-ci conservent un des 64 permis de fichier jusqu’à leur fin, y compris après annulation. La borne 16 concerne les tâches auxiliaires suivies, pas toute la file interne de Tokio ni les I/O applicatives. Ces contrôles ne plafonnent pas toutes les connexions ou les buffers TCP. Une panne disque peut occuper durablement la capacité bornée. Un stream actif n’est pas coupé par le délai d’admission.</p>'
    return body


def lifecycle_section(d):
    rows = []
    for r in d['wake']:
        stages = r['isolatedFirstResponseStages']
        rows.append([link(r['path'], r['variant']+' '+r['profile']), span(r['first']), span(r['second']), span(stages.get('node-ready')), span(stages.get('module:http')), span(stages.get('module:app-render')), span(stages.get('rsc-ready')), span(stages.get('rsc-ready-to-native-response-wall-ms'))])
    body = '<p>Le contrat des builds, le retrait sur échéance, <code>keepWarm</code>, le suivi du travail post-réponse et la réutilisation d’un host sain existent déjà en V4/V5. Ils n’ont pas été réécrits. Les modules Node et politiques de profils restent identiques à V5. Le nouveau candidat sert les artefacts V5 exacts ; les anciens runtimes incompatibles restent rejetés avec demande de reconstruction.</p>'
    body += table(['Version / profil','1re réponse ms','2e réponse ms','Spawn → Node prêt','Module HTTP','Module rendu','RSC prêt','Après RSC → réponse native'], rows, 'Cinq réveils isolés par version/profil. Retrait forcé à 1 s pour balanced/memory ; speed conserve son host. Les phases instrumentées se chevauchent : elles ne s’additionnent pas. La dernière colonne mesure le temps mural entre RSC prêt et la réponse native : chargement de route, premier rendu et transport restent regroupés ; ce n’est pas du CPU de rendu pur. La première réponse complète comprend le backend de 40 ms.')
    body += '<p>Aucune réduction nette du réveil n’est démontrée. Le lancement, les imports et l’initialisation expliquent une partie du réveil froid. Le candidat conserve ces étapes ; aucune ressource cachée ou requête artificielle n’est ajoutée pour réchauffer les applications.</p>'
    body += '<h3>Reprises simultanées et trafic intermittent</h3>'
    rows = []
    for r in d['followup']['runs']:
        if not r['label'].startswith('intermittent-'):
            continue
        wakes = [p for p in r['phases'] if p['phase'].startswith('resume')]
        lats = [p['individualReplies']['latencyMs']['median'] for p in wakes if p['individualReplies']]
        loads = [p for p in r['phases'] if p['phase'] == 'intermittent-30s']
        rows.append([link(r['path'], r['label']), r['complete'], span(a.spread(lats)), sum(p['errors']+p['validationErrors'] for p in loads), e(str(r['error'] or ''))])
    body += table(['Quatre applications','Contrôle terminé','Médianes des reprises ms','Erreurs trafic','Échec du contrôle'], rows, 'Trois cycles, 32 arrivées simultanées (8/application), puis 30 s de requêtes espacées de 1,5 s. Délais de retrait diagnostiques 1 s, distincts des défauts de production.')
    rows = []
    for r in d['extras']['runs']:
        if r['settled']:
            p, start = r['settled'], r['startup']
            rows.append([link(r['path'], r['label']), num(start['cpuSeconds'],3), num(p['cpuPercent'],3), num(p['rssMedianMiB']), p['processesAfter'], p['threadsAfter'], p['nodesAfter']])
    body += '<h3>Huit applications démarrées sans trafic</h3>'+table(['Profil / version','CPU démarrage + 60 s','CPU repos %','RSS Mio','Processus','Threads','Node'], rows, 'Aucune sonde HTTP/TCP. Repos stabilisé mesuré pendant 10 s après les 60 s initiales ; superviseur de mesure inclus. Un CPU arrondi à zéro ne prouve pas une consommation strictement nulle.')
    body += '<p>Les repos 1/5/15 minutes de V5 restent des preuves héritées : le cycle de vie Node n’a pas changé. Les nouveaux contrôles ajoutent les instances multiples, le repos après l’heure d’endurance et les reprises concurrentes. Les tests de cache, finalisation, retrait et contrat runtime ont été relancés sur le candidat exact.</p>'
    return body


def soak_section(d):
    s = d['soak']
    if not s:
        return '<p>En attente.</p>'
    final = s['lastGeneratorRecord'] or {}
    apps = final.get('apps', [])
    body = f'<p><strong>{"Terminée" if s["complete"] else "En cours / incomplète"}</strong> : quatre applications memory, un cœur partagé, commit global 1 Gio. SSR, streaming, API et fichier statique dont les octets sont vérifiés ; annulations régulières. {num(final.get("elapsedSeconds"))} s, {num(sum(x["useful"] for x in apps),0)} réponses utiles, {num(final.get("plannedDisconnects"),0)} déconnexions voulues. '+link(s['path'],'Mesure brute')+'.</p>'
    body += phase_table([dict(path=s['path'], label='Endurance', phases=s['phases'])], lambda r,p: True)
    idle = next((p for p in s['phases'] if p['phase']=='idle-40s'), None)
    resume = next((p for p in s['phases'] if p['phase']=='simultaneous-resume'), None)
    if idle and resume and resume['individualReplies']:
        latencies = ', '.join(num(x) for x in resume['individualReplies']['latenciesMs'])
        body += f'<p>Après 40 s sans requête : {idle["nodesAfter"]} processus Node, {num(idle["rssAfterMiB"])} Mio de RSS totale. Premières réponses simultanées des quatre applications : <strong>{latencies} ms</strong>. Le CPU de la période de repos est inclus dans le tableau.</p>'
    rows = []
    for w in s['windows']:
        rows.append([f'{w["startSeconds"]//60}–{w["endSeconds"]//60} min', span(w['rps']), *[span(w['resources'][k], 1 if 'MiB' in k else 0) for k in ('rssMiB','privateCommitMiB','processes','threads','handles')]])
    body += table(['Période','req/s par intervalle','RSS Mio','Commit privé Mio','Processus','Threads','Handles'], rows, 'Les débits par intervalle sont recalculés à partir des différences de compteurs. Le champ rps des instantanés intermédiaires du générateur utilise la durée totale prévue et ne constitue pas un débit instantané.')
    series = s.get('memorySeries5s', [])
    if series:
        top = math.ceil(max(max(r['rssMiB'],r['privateCommitMiB']) for r in series)/100)*100
        end = max(r['seconds'] for r in series)
        svg = '<svg viewBox="0 0 1000 270" role="img" aria-labelledby="memory-chart-title" style="width:100%;height:auto;background:white"><title id="memory-chart-title">Mémoire totale des quatre applications pendant la charge puis le repos</title>'
        for value in range(0, top+1, 100):
            y = 220-180*value/top
            svg += f'<path d="M60 {y:.1f}H970" stroke="#d4dde4"/><text x="50" y="{y+5:.1f}" text-anchor="end" font-size="13">{value}</text>'
        for minute in range(0, int(end//60)+1, 10):
            x = 60+910*minute*60/end
            svg += f'<text x="{x:.1f}" y="247" text-anchor="middle" font-size="13">{minute} min</text>'
        for key,color,dash in [('rssMiB','#086c55',''),('privateCommitMiB','#1859a6','stroke-dasharray="6 3"')]:
            path = ' '.join(('M' if i==0 else 'L')+f'{60+910*r["seconds"]/end:.1f},{220-180*r[key]/top:.1f}' for i,r in enumerate(series))
            svg += f'<path d="{path}" fill="none" stroke="{color}" stroke-width="2" {dash}/>'
        svg += '<text x="65" y="23" font-size="14" fill="#086c55">RSS (Mio)</text><text x="220" y="23" font-size="14" fill="#1859a6">Commit privé (Mio, pointillé)</text></svg>'
        body += '<figure style="margin:20px 0">'+svg+'<figcaption>Un point toutes les 5 s environ ; les maxima complets restent dans les données brutes à 0,5 s. La fin comprend le repos de 40 s et la reprise.</figcaption></figure>'
    rows = []
    for m in s['metrics']:
        if not m:
            continue
        f=m['final'];w=f['workers'];gate=f.get('fileAdmission') or {}
        rows.append([link(m['path'],'Application'),w['hostStarts'],w['failedRequests'],w['consumerCancellations'],w['watchdogKills'],w['activeJobs'],w['queuedJobs'],gate.get('active'),gate.get('waiting')])
    body += table(['Compteurs finaux','Hosts créés','Échecs worker','Annulations','Watchdog','Jobs actifs','Jobs en file','Fichiers actifs','Attentes fichier'],rows, 'Le dernier échantillon peut précéder la réponse de reprise. Les créations initiales et après retrait normal ne sont pas des redémarrages de panne ; examiner aussi les logs et les périodes de repos.')
    return body


def main():
    if a.os.name=='nt':
        a.sys.path.insert(0,str(a.ROOT/'artifacts/performance/python'))
        import psutil
        psutil.Process().cpu_affinity([0,1])
    p=argparse.ArgumentParser();p.add_argument('--analysis',default='analysis.json');p.add_argument('--output',default='report.html');args=p.parse_args()
    d=a.read(OUT/args.analysis);assert d
    complete=bool((d['matrix']['progress'] or {}).get('complete') and (d['soak'] or {}).get('complete') and (d['followup']['execution'] or {}).get('complete') and (d['extras']['execution'] or {}).get('complete') and (a.read(OUT/'final-audit.json') or {}).get('complete'))
    old=(ROOT_REPORT:=a.ROOT/'artifacts/performance/report.html').read_text(encoding='utf-8')
    style=re.search(r'<style>(.*?)</style>',old,re.S).group(1)
    body='<h1>PRNext V6<br>Héberger plusieurs applications sous contrainte</h1><p>Référence : état final V5 figé, issu du commit <code>6384708</code> et de ses modifications conservées. Windows 11 · Node 24.19.0 · Next.js 16.3.5 · React 19.3.0. Aucun déploiement ni publication.</p>'
    body+=f'<div class="note"><strong>{"Campagnes exécutées — voir les résultats et réserves ci-dessous" if complete else "Rapport provisoire — des campagnes sont encore en cours"}</strong><p>La correction principale borne la file statique. Elle vise la stabilité sous surcharge et a un coût mesurable. Aucun gain Linux, Nginx ou compatibilité Next.js universelle n’est revendiqué.</p></div>'
    body+='<nav aria-label="Sections">'+''.join(f'<a href="#{key}">{name}</a>' for key,name in [('summary','Synthèse'),('multi','Multi-apps'),('static','Statique'),('workers','Repos et reprise'),('soak','Endurance'),('validation','Tests'),('method','Méthode'),('proof','Preuves')])+'</nav>'
    summary=table(['Priorité','Résultat et portée'],[
        ['Linux','Non exécuté : aucun WSL, Docker ou Podman disponible. Workflow reproductible préparé ; VPS de production non utilisé.'],
        ['Multi-applications','80 essais, 1/4/8 instances sur un cœur partagé. Memory passe les deux essais courts à 4/512 Mio et 8/1 Gio ; balanced protège mieux la latence des voisines lorsque le budget mémoire suffit.'],
        ['Régression sous budget serré','Balanced-small, 8 apps / 1 Gio : 2 essais V6 sur 5 avec refus d’allocation, contre 0/5 en V5. Cas reproduit, origine fine de l’écart non isolée ; variante non retenue par défaut.'],
        ['Saturation statique','File auxiliaire plafonnée à 16. Sur 512 clients lents, RSS pic d’une instance : 318 → 102 Mio, avec 503 explicites. Petit HTML gzip : débit médian −3,9 %, CPU/réponse +4,0 % ; marge des cœurs générateurs insuffisante dans certains passages.'],
        ['Workers et builds','Contrat V5 conservé. Réveil isolé V6 : 314 ms balanced, 410 ms memory, sans gain net. Les permis restent détenus jusqu’à la fin réelle des lectures annulées.'],
        ['Endurance','1 h sur le binaire final : 1 626 564 réponses utiles, 0 erreur, 960 annulations. Quatre applications memory / 1 Gio ; après 40 s de repos : 0 Node et 103 Mio de RSS totale.']])
    summary+='<p><strong>Défauts retenus :</strong> <code>start</code> conserve balanced ; <code>host</code> conserve memory. Pas de nouveau profil. Limite auxiliaire 16 conservée : 64 gagne environ 5 % sur le petit statique isolé, mais engage quatre fois plus de tâches et n’a pas la même validation d’endurance. Les budgets sont du commit Windows, avec fichier d’échange actif ; les essais courts aux plus petits budgets ne valent pas une heure d’endurance à ces plafonds.</p>'
    body+=section('summary','Synthèse courte',summary)
    multi=matrix_section(d['matrix'])
    multi+='<p>La variante <code>balanced-small</code> utilise <code>NODE_OPTIONS=--max-semi-space-size=1</code> : une option existante, pas un nouveau profil ni une reproduction intégrale de l’ancienne politique V8 optimize-for-size. À huit applications sous 2 Gio avec un voisin bruyant, les médianes de p99 des voisines vont de 244 à 348 ms en memory, contre 118 à 138 ms en balanced. Le choix par défaut privilégie donc la densité pour host et la latence des applications actives pour start ; le proxy host lui-même n’est pas mesuré ici.</p>'
    body+=section('multi','V5 → candidat : applications indépendantes',multi)
    body+=section('static','File statique, clients lents et coût CPU',static_section(d))
    body+=section('workers','Repos, réveil et compatibilité des builds',lifecycle_section(d))
    body+=section('soak','Une heure sur le candidat final',soak_section(d))
    validation='<p>Sur le candidat exact : <strong>159 tests Rust réussis, 1 micro-benchmark manuel ignoré</strong>, fmt et clippy réussis ; <strong>304 tests E2E réussis, 1 ignoré, et 2 contrôles Next réussis</strong>. Le test E2E ignoré concerne SIGTERM et la reconstruction sur Unix. Neuf contrôles fonctionnels vérifient fraîcheur, isolation cookies, streaming progressif, annulations et règles HTTP statiques.</p><p>Un test ajouté reproduit la saturation du cache Pages JSON : uniquement des succès ou 503 avec Retry-After et no-store, reprise correcte et aucune régénération indue. Avant correction, la reproduction obtenait 122 réponses 500 sur 128. Les suites couvrent cache, revalidation, Server Actions, middleware, routage, retrait et contrat runtime. Les validations Node/build et installation V5 sont réutilisées pour les sources inchangées.</p>'
    validation+='<p>Les 500 Pages provenaient du premier candidat d’admission V6, et non de V5 : la nouvelle erreur de saturation était confondue avec un échec de génération. Ce défaut a été corrigé avant le gel final. '+link('http-fix-interruption.json','Interruption et reprise des mesures')+' ; l’endurance antérieure interrompue n’est pas additionnée à l’heure finale.</p>'
    validation+='<p>'+ ' · '.join(link(path,title) for path,title in [('validation-scope-http.json','Portée des preuves'),('tests/final-http/rust.log','Tests Rust'),('tests/final-http/clippy.log','Clippy'),('tests/final-http/e2e.log','Suite E2E finale'),('tests/final-http/next-oracle.log','Oracle Next'),('functional-http/result.json','Contrôles fonctionnels'),('pages-admission-probe-3/result.json','Reproduction avant correction')])+'.</p><p>Les protections de parcours de chemins, variantes précompressées, Range/If-Range, HEAD, ETag, Last-Modified, cookies et Server Actions restent actives. Les suites Unix, symlinks et signaux Linux restent à exécuter sur Linux.</p>'
    body+=section('validation','Validation, provenance et limites des preuves',validation)
    method='<p>Toutes les opérations mesurées utilisent les mêmes sources et artefacts applicatifs V5. Les binaires sont immuables et leurs SHA-256 figurent dans chaque essai. Le Job Windows cumule le CPU des processus Rust, Node, consoles et superviseur Python, y compris les workers terminés. La RAM est une somme de RSS échantillonnée ; des pages partagées peuvent être comptées plusieurs fois. Le superviseur et les consoles ajoutent environ 36 Mio pour une application et 80 Mio pour huit ; ils sont inclus dans les totaux.</p><p>Les budgets Windows limitent le <strong>commit</strong>, pas le RSS comme un cgroup Linux. La configuration du fichier d’échange n’a pas été modifiée ; le relevé initial psutil indique environ 5,1 Gio utilisés (99,5 %). Sa taille peut évoluer automatiquement. Les compteurs sin/sout Windows de psutil sont des zéros fixes, pas une mesure des I/O de swap ; l’activité de pagination pendant chaque essai reste inconnue. Les événements de limite observés, les logs d’allocation et les sorties de processus restent séparés. Le compteur de pic de commit peut inclure une tentative d’allocation refusée ; il ne prouve pas qu’elle a été acceptée.</p><p>Serveur de matrice : CPU logique 10 ; générateur : 8/9. Endurance : serveur 2, générateur 4/5 ; les deux campagnes utilisent des cœurs physiques distincts, mais partagent la machine et sa mémoire. Pas de compilation pendant les mesures. Les générateurs sont contrôlés par CPU moyen et p95 des intervalles du cœur avec son frère SMT : seuil conservateur 85 %. Un dépassement exclut une conclusion de capacité, sans effacer l’essai.</p><p>Le débit utile exclut 503, erreurs et réponses invalides ; les requêtes lancées sont drainées. Le CPU par réponse inclut ce drainage et tout le travail du groupe. Les p50/p95/p99 sont par application ou générateur ; une médiane de p99 n’est pas un p99 global. Les étendues sont min–max des répétitions, pas des intervalles de confiance. Une heure ne garantit pas l’absence de fuite rare.</p><p>Les réglages sont documentés dans '+link('../../README.md','README')+'. Le protocole '+link('../../tests/performance/V6-LINUX.md','Linux V6')+' et le '+link('../../.github/workflows/performance-linux-v6.yml','workflow manuel')+' préparent les comparaisons V5/candidat/Next/Nginx avec cgroups, PSS et swap nul. Ils n’ont pas été exécutés. Aucune preuve Windows ne les remplace.</p>'
    method='<p>Machine : AMD Ryzen 5 3600, 6 cœurs / 12 processeurs logiques, environ 31,9 Gio de RAM utilisable ; Windows 11 build 26100. Les paires SMT sont vérifiées par l’API Windows : '+link('cpu-topology.json','topologie enregistrée')+'. Ce PC partagé n’est pas un runner de benchmark dédié.</p>'+method
    method+='<p>Les latences portent sur les réponses utiles : histogramme à pas de 0,1 ms, plafonné à 12 s, avec maximum exact conservé dans les données brutes. Le timeout de socket de 15 s mesure une inactivité, pas une durée totale ; le banc ajoute une garde externe de durée prévue + 60 s. Les événements d’erreur bruts peuvent compter deux fois une requête interrompue ; les échecs distincts sont calculés après drainage.</p>'
    body+=section('method','Méthode et limites',method)
    proof='<p>'+ ' · '.join(link(path,title) for path,title in [('reference-v5/reference.json','Référence V5'),('candidate-provenance-http.json','Candidat exact'),('fixtures.json','Artefacts applicatifs'),('analysis.json','Synthèse calculée'),('final-audit.json','Audit final'),('linux-availability.json','Disponibilité Linux'),('linux-preparation-check.json','Préparation vérifiée'),('matrix-interruption.json','Erreur de configuration du banc'),('sequence-http.json','Reprise de campagne'),('reference-v5-source.sha256','SHA archive V5')])+'.</p><p>Les échecs intermédiaires sont conservés : instantané pris avant fin de compilation (rejeté), course d’initialisation de l’observateur (corrigée et testée), variante NODE_OPTIONS refusée (exclue, remplacée par une option prise en charge), premiers générateurs de gros fichiers saturés. Les erreurs d’outil de mesure ne sont pas attribuées au runtime.</p>'
    proof+=details('Commandes de reproduction locale', '<pre>'+e('python tests/performance/campaign-v6.py matrix\npython tests/performance/static-campaign-v6.py\npython tests/performance/wake-v6.py\npython tests/performance/soak-v6.py\npython tests/performance/analyze-v6.py\npython tests/performance/report-v6.py\n\nUtiliser des répertoires de sortie neufs ; les scripts refusent de remplacer les mesures existantes.\nLe manifeste final archive les scripts exacts et toutes les tentatives de cette campagne.')+'</pre>')
    proof+='<p>'+link('final-code.diff','Diff de production V5 → V6')+' · '+link('pages-admission-probe-final/result.json','Saturation Pages après correction')+' · '+link('early-cancel-http/result.json','Annulation avant délai et intégrité du gros fichier')+' · '+link('environment-final.json','État de la machine après les essais')+' · '+link('pressure-confirm-http.json','Confirmations sous 1 Gio')+'.</p>'
    body+=section('proof','Preuves conservées',proof)
    body+='<footer>PRNext 0.1.11-alpha, campagne V6 locale. '+link('../performance/report-v5-before-v6.html','Rapport V5 préservé')+'. Les résultats décrivent cette machine et ces fixtures.</footer>'
    output='<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRNext V6 — multi-applications et admission bornée</title><style>'+style+'</style></head><body><main>'+body+'</main></body></html>'
    (OUT/args.output).write_text(output,encoding='utf-8');print(args.output, 'complete', complete)


if __name__=='__main__':
    main()
