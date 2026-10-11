"""Release evidence summary. Raw unsuccessful trials remain linked and hashed."""
import json, pathlib, statistics
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/release-0.1.12-alpha'
data=json.loads((OUT/'analysis.json').read_text(encoding='utf-8'))
tests=OUT/'tests/final-v2'
for name in ['host','release','fmt','clippy','rust','unit','types','types-basic','types-app','e2e','next-oracle']:
 assert json.loads((tests/(name+'.json')).read_text())['exitCode']==0,name
for name in ['package','package-nested','artifacts']:
 assert json.loads((OUT/'tests/packages-final'/(name+'.json')).read_text())['exitCode']==0,name
binary=json.loads((tests/'e2e.json').read_text())['binarySha256']
lines=[f'''# Préparation de PRNext 0.1.12-alpha

**Verdict : prêt pour une alpha sur Windows x64.** La publication des six cibles
reste bloquée par les cinq archives natives qui doivent encore être construites
et testées sur leur plateforme par la matrice CI. Aucun push, tag, publication
npm, déploiement ou accès au VPS n'a été effectué.

## État exact et portée

- Windows 11 build 26100, Ryzen 5 3600, 6 cœurs physiques / 12 logiques ; même PC que V6.
- PRNext 0.1.12-alpha ; Node 24.19.0, npm 11.12.1 ; React 19.3.0 ; référence Next.js 16.3.5 ; Rust 1.98.0.
- SHA-256 du binaire final : `{binary}`.
- Les applications et binaires V5/V6 gelés restent inchangés. Le binaire alpha change la version et les trois en-têtes d'erreurs du proxy ; les réglages de workers/admission V6 sont conservés.
- Les mesures utilisent un Job Windows commun : un CPU logique 10, générateur séparé sur 8/9, CPU cumulé incluant les enfants terminés, somme RSS de tous les processus du Job. Superviseur Python et consoles de test inclus. La RSS additionne les pages partagées et le budget est un **commit Windows**, pas une limite RSS Linux. Pagefile inchangé.
- Réponses dynamiques vérifiées pour fraîcheur et séparation des cookies ; aucun cache de page ajouté. Les requêtes ordinaires sont drainées avant de compter les échecs.

## Corrections et préparation

La saturation du proxy de `host` produisait des 503 sans `Cache-Control: no-store`.
Le test a échoué sur V6, puis réussi après correction. Les 502/504 générés par le
transport reçoivent aussi cet en-tête. Les réponses de l'application restent
transmises telles quelles et ne sont pas rejouées.

Les versions npm/Cargo et les six dépendances natives sont synchronisées.
`npm ci` a réussi dans un répertoire vide : 307 packages installés. Les natives
non publiées restent optionnelles ; leurs entrées de lock ne contiennent aucun
hash inventé. Le contrôle de publication refuse les natives absentes, sans
modifier le lock. Le parcours consommateur est testé avec les vrais `.tgz`,
via un registre temporaire local, sans workspace/link/PRNEXT_BINARY/Cargo.

Les commandes exactes se trouvent dans [RELEASE.md](../../RELEASE.md).
Le changelog et les deux README documentent le rebuild obligatoire des applications
dynamiques, les options réellement supportées et les limites restantes.

## Régression mémoire expérimentale : reproduite, non corrigée

Paramètres inchangés : huit applications `start`, un CPU, Job de 1 Gio,
`balanced` avec `NODE_OPTIONS=--max-semi-space-size=1`, cinq secondes
d'échauffement et vingt secondes de charge mixte, trois nouvelles paires en
ordre alterné. Ce n'est pas un profil intégré.

| Campagne | V5 en échec | V6 en échec |
|---|---:|---:|
| V6 antérieure | 0/5 | 2/5 |
| Nouvelle reproduction | 0/3 | 1/3 |

Le nouvel échec V6 est une allocation native de 65 712 octets refusée, suivie
de la sortie d'un serveur et de **507 requêtes échouées**, toutes conservées.
Il ne s'agit pas de 507 réponses 502 : les erreurs de connexion après sortie
du serveur sont comptées aussi. Aucun budget n'a été augmenté pour ce scénario.

Deux essais diagnostiques séparés, échantillonnés à 100 ms, ont comparé
démarrage statique, premier trafic dynamique, charge et cinq secondes après
drain. Ils n'ont pas échoué. Le commit privé Node domine : médianes cumulées
827,6 Mio V5 / 829,6 Mio V6, contre 23,4 / 23,6 Mio pour Rust. Les maxima
échantillonnés Node sont 907,5 / 931,2 Mio ; les pics de classes ne sont pas
nécessairement simultanés et ne capturent pas toutes les allocations brèves.

En V6, les files et permis statiques reviennent à zéro après drain, y compris
les octets d'en-têtes retenus ; le nombre soumis égale le nombre libéré.
Aucun passage en attente n'est observé dans ce diagnostic. Cela écarte une
accumulation persistante observée, **pas** une modification transitoire de
l'ordonnancement ou des pics V8. La cause précise reste non identifiée :
aucune correction mémoire n'est revendiquée et cette densité expérimentale
reste déconseillée.

Sources : [reproduction](release-reproduce.json), [diagnostic](release-diagnose.json),
[synthèse des ressources](analysis.json), répertoire `multi/release-*`.

## Profils par défaut : comparaison ciblée

Trois paires par profil, toujours huit apps/un CPU, cinq secondes de chauffe et
vingt secondes mesurées. Budgets identiques entre versions : `memory` à 1 Gio,
`balanced` à 2 Gio, comme les cas V6 correspondants. Ce contrôle n'est pas une
augmentation du budget du cas expérimental ci-dessus. Aucun échec, 503, problème
de validation ou événement de limite dans les douze essais ; aucun message
de redémarrage pour requête défectueuse dans leurs logs.

Débit, CPU/réponse et RSS : médianes des trois essais. Les p50/p95/p99 sont des
plages de quantiles **par application et par essai**, pas des percentiles agrégés.

| Profil/budget | Version | req/s | CPU ms/rép. | RSS Mio | p50 ms | p95 ms | p99 ms |
|---|---|---:|---:|---:|---:|---:|---:|''']
def latrange(phases,key):
 values=[v[key] for p in phases for v in p['latencies']]
 return f'{min(values):.1f}–{max(values):.1f}'
for profile,budget in [('balanced','2 Gio'),('memory','1 Gio')]:
 for variant in ['v5','candidate']:
  rows=[r for r in data['memory'] if '/final-' in r['path'] and f'-{profile}-{variant}/' in r['path']]
  assert len(rows)==3 and all(r['complete'] and r['limitEvents']==0 for r in rows)
  assert all(not any(p['failedRequests'] or p['rejected'] or p['validationErrors'] for p in r['phases']) for r in rows)
  p=[next(p for p in r['phases'] if p['phase']=='all') for r in rows]
  lines.append(f"| {profile} / {budget} | {'alpha finale' if variant=='candidate' else 'V5'} | {statistics.median(x['rps'] for x in p):.1f} | {statistics.median(x['cpuMsPerResponse'] for x in p):.3f} | {statistics.median(x['rssMiB'] for x in p):.1f} | {latrange(p,'p50')} | {latrange(p,'p95')} | {latrange(p,'p99')} |")
lines.append('''
Ces résultats ne montrent pas de gain de débit net à revendiquer. Les variations
et les mesures de charge du générateur restent dans `analysis.json`.
Cette validation courte ne remplace pas une endurance sur l'alpha exacte.
L'endurance d'une heure V6 reste une preuve du candidat V6 antérieur, pas un
nouveau test `host` ou Linux.

## Véritable `prnext host`

Le nouveau test d'intégration construit trois applications distinctes et vérifie
SSR, API, cookies multiples, caches séparés, fichiers/304, streaming progressif,
48 arrivées après sommeil, surcharge de 300 connexions et annulations,
accessibilité d'un voisin, absence de replay, crash/cooldown/reprise et arrêt
des descendants. Les tests `hosting.test.mjs` existants vérifient aussi qu'un
stream actif conserve sa réservation et qu'un dépassement RSS reste isolé.
Le test est inclus dans les 305 intégrations réussies.

Un 502 à l'instant exact d'un crash est attendu si la requête est déjà envoyée ;
après détection, le superviseur impose des 503 pendant son délai de cinq secondes.
Ce comportement est testé et documenté, sans retry caché.

### Coût mesuré

Quatre apps, profil `memory`, un CPU/Job 1 Gio, 8 connexions/app, mix SSR 100 lignes,
streaming 40 ms et API ; deux essais de trente secondes après cinq secondes de
chauffe. Même `--max-old-space-size=192` dans les deux chemins. Les contrôles
directs corrigés suivent les essais host ; l'ordre n'est pas alterné, donc
la comparaison reste indicative. Les deux premiers contrôles directs sans cette
limite sont conservés mais exclus de ce calcul (`host-control-correction.json`).

| Chemin | req/s médian | CPU ms/rép. | RSS Mio | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|''')
hostgroups={}
for mode in ['direct','host']:
 rows=[r for r in data['host'] if (r['path'].startswith('host-direct-matched/') if mode=='direct' else r['mode']=='host')]
 assert len(rows)==2 and all(r['complete'] and not r['limitEvents'] for r in rows)
 phases=[next(p for p in r['phases'] if p['phase']=='mixed') for r in rows]
 assert all(not p['failed'] and not p['rejected'] for p in phases)
 hostgroups[mode]=phases
 lines.append(f"| {mode} | {statistics.median(p['rps'] for p in phases):.1f} | {statistics.median(p['cpuMsPerResponse'] for p in phases):.3f} | {statistics.median(p['rssMedianMiB'] for p in phases):.1f} | {latrange(phases,'p50')} | {latrange(phases,'p95')} | {latrange(phases,'p99')} |")
lines.append('''
Soit environ **−7,7 % de débit** et **+8,6 % de CPU/réponse** avec le gateway dans
cette fixture. La RAM est proche. Aucune erreur ni rejet ; pas de saturation du
générateur selon le critère conservateur V6 (CPU moyen et p95 des deux threads
du cœur physique ≤85 %). Ce critère n'est pas un intervalle de confiance.

### Sommeil et réveil

Trois cycles par essai, `idleSeconds: 3` uniquement pour accélérer le contrôle
(défaut inchangé : 300 s). Les 32 réponses de chaque salve après sommeil arrivent
en **1,92–2,35 s**, sans démarrage dupliqué : exactement une incrémentation
`starts` par app et par réveil. Cette salve est différente des quatre requêtes
simultanées mesurées dans V6 ; elle ne démontre pas une régression de réveil.

Après retrait : zéro serveur applicatif et zéro Node. Les deux fenêtres de
repos stabilisé de 10 s mesurent **1,09 % d'un CPU** pour le Job et environ
49–50 Mio RSS, dont 12,8–13,2 Mio pour le gateway ; le reste comprend Python et
les consoles du banc. Il reste 4 processus de banc, dont un seul serveur
PRNext, et 18–30 threads selon la retraite des threads de travail. Le suivi
RSS/statut du host continue chaque seconde. Aucun cycle de redémarrage n'est
observé ; 36 processus cumulés correspondent au superviseur et aux lancements
applicatifs attendus, y compris ceux terminés.

Sources : [mesures](analysis.json), `host/r*-host/`, `host-direct-matched/`,
[contrôle fonctionnel](tests/final-v2/host-functional.json).

## Installation, archives et tests réellement exécutés

- `npm ci` propre : réussi (16,6 s, 307 packages), [preuve](clean-install/result.json).
- Formatage, Clippy, 159 tests Rust réussis ; 1 microbenchmark ignoré.
- 669 tests unitaires réussis ; 1 sauté faute d'en-têtes de développement Node-API.
- Trois projets TypeScript vérifiés.
- 305 tests d'intégration réussis ; 1 test de signal SIGTERM Unix sauté sur Windows.
- Deux contrôles de conformité avec Next.js 16.3.5 réussis.
- Deux installations isolées du **package final réellement produit**, `hoisted`
  et `nested`, dix groupes de contrôles chacune : natif automatique, version
  JS/native, contrat runtime, App/Pages/Edge, SSR/cookies/Flight/API, streaming
  progressif, standalone déplacé, commandes persistantes, dev/rebuild et erreur
  explicite si le natif manque. Les hashes finaux sont revérifiés.
- [Archives finales](npm-final/) : framework et Windows x64 uniquement.
  Les deux premiers packs, antérieurs à la dernière correction de README,
  restent dans `npm/` ; seules les archives `npm-final/` sont à retenir.
- Aucun nouveau test navigateur complet, test Linux, benchmark Nginx ou test
  d'endurance host n'est déclaré réussi. Les essais courts ciblent la préparation
  alpha ; les anciennes preuves V6 restent séparées.

## Linux et publication

**Validation Linux non exécutée.** WSL absent, Docker/Podman indisponibles ; aucun
hôte Linux de test autorisé identifié. Le VPS existant n'a pas été utilisé.
Treize scripts Python ont été analysés syntaxiquement lors de la revue initiale ;
les workflows Linux V6, Linux alpha et la matrice d'archives ont été parsés et
revus. Cela ne vaut pas exécution Linux.

Le workflow manuel `release-alpha-linux.yml` ajoute un parcours fonctionnel
ciblé sur un runner CI jetable, sans imposer la campagne longue Next/Nginx.
La matrice native existante doit produire les cinq autres cibles après votre
push. Leur absence bloque la publication complète, pas la validité des tests
Windows réalisés. `RELEASE.md` contient l'ordre natifs → vérification registre →
lock réel → wrapper, ainsi que les commandes et les étapes de collecte.

## Limites et essais écartés des conclusions

- Régression `balanced-small` conservée et non résolue ; les profils par défaut
  passent la charge ciblée mais ne garantissent pas toutes les densités/apps.
- Le coût du proxy, son CPU au repos et la latence de réveil restent présents.
- Pas de compatibilité Next exhaustive : React Compiler/typedRoutes activés
  restent refusés ; les limites TypeScript figurent dans le README.
- Un premier test supposait un ETag sur un fichier public ; il a été corrigé
  pour utiliser le vrai `Last-Modified`. Un autre attendait 503 exactement à la
  frontière d'un crash ; il vérifie désormais 502/503 à cet instant, puis exige
  le 503 de cooldown. Ces deux corrections de test ne sont pas des bugs runtime.
- L'échec V6 sur les 503 sans `no-store` est le défaut runtime effectivement
  reproduit et corrigé. Ses logs, ceux du cas mémoire et les contrôles moins
  comparables ne sont pas supprimés.
''')
(OUT/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
print('Release report written; final binary',binary)
