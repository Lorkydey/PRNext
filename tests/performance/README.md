# Performance and lifecycle measurements

## Production regression fixture

`production-fixture.mjs <empty-directory>` creates the same App/Pages SSR,
Suspense, JSON and public-file workload for PRNext and Next.js. It refuses a
nonempty destination. `production-load.mjs <config.json>` loads loopback HTTP
only; it must never target a production URL. Configuration includes `url`,
`route`, `seconds`, `connections`, and optionally `encoding: 'gzip'` or
`mode: 'open', rate`. The fixed-arrival schedule starts at its first interval;
latency from the scheduled departure and from the actual request are separate.

The generator validates fresh UUIDs, the request cookie identity and every API
row. Failed statuses, invalid bodies and disconnects never count as useful
throughput. Started requests are drained; their completion, errors and CPU
remain recorded after the offered-load window. Run its accounting tests with
`node --test tests/performance/production-load.test.mjs`.

HTML table routes also require the complete expected table: all three cells of
each of 100 rows for SSR, Pages, guarded and static fixtures, or 1,000 rows for
the heavy fixture. A table serialized only in a script/comment is insufficient.
The check deliberately follows this fixture's React table markup. RSC mode is
rejected for those table routes (and mixed traffic) until their Flight bodies
can be decoded and validated; JSON, payload and streaming checks retain their
own response validation.

## Compare exact release archives locally

`release-regression.mjs` compares two independently installed copies of the
production fixture. Generate each copy with `production-fixture.mjs`, install
the intended framework and matching native archives there, and retain both
tarballs. The harness performs no installation. It checks every installed file
against the archives, rejects package/workspace links and additional workload
sources, then builds each fixture with its verified CLI. Build output remains
in these explicitly provided application directories; only the harness's own
temporary generator configurations and owned server processes are cleaned up.

The React, React DOM and React Server Components packages resolved from each
application, plus scheduler resolved from React DOM, are inventoried by version
and SHA-256 of their installed file bytes. Different identities are rejected
before either build. This proof does not certify other build or transitive
dependencies; prepare those with matching dependency lockfiles and retain that
installation evidence separately.

```json
{
  "baseline": {
    "directory": "./baseline-app",
    "archives": ["./baseline-framework.tgz", "./baseline-native.tgz"],
    "source": "BASELINE_SOURCE_COMMIT"
  },
  "candidate": {
    "directory": "./candidate-app",
    "archives": ["./candidate-framework.tgz", "./candidate-native.tgz"],
    "source": "CANDIDATE_SOURCE_COMMIT"
  },
  "workload": {
    "seconds": 10,
    "warmupSeconds": 2,
    "connections": 8,
    "workers": 2,
    "repetitions": 6
  },
  "budgets": {
    "throughputDropPercent": 10,
    "p95IncreasePercent": 15,
    "maxNoisePercent": 15,
    "maxGeneratorCpuPercent": 85
  }
}
```

Replace both source labels with the intended 40-character Git commit IDs.
These are declared labels: the harness verifies archive/installed bytes, but
does not independently establish the Git-to-archive association. Preserve the
release build's separate provenance proof. Paths are relative to the JSON
configuration. Use a new report filename:

```sh
node tests/performance/release-regression.mjs run comparison.json comparison-result.json
node tests/performance/release-regression.mjs check comparison-result.json
node --test tests/performance/release-regression.test.mjs tests/performance/release-regression-controls.test.mjs tests/performance/release-regression-dependencies.test.mjs
```

All targets are owned `127.0.0.1` servers on automatically allocated ports; a
public URL cannot be supplied. The existing validated load generator runs SSR,
JSON API and streaming scenarios with identity encoding. Six to twenty even
repetitions alternate baseline/candidate and candidate/baseline, rotating route
order. Each server starts afresh for its turn and each scenario has a separate
warmup. Useful throughput excludes incorrect responses; transport, status,
validation, dropped-request and latency-overflow errors invalidate the report.
Missing repetitions, mismatched source fixtures, workload or machine/resource
controls are rejected too. Raw samples and both archive hashes remain in the
report; a failed run retains completed samples with `complete: false`.

The gate compares paired candidate/baseline useful-throughput and p95 ratios.
Its conservative sign-based median intervals have at least 95% nominal coverage
**assuming independent paired repetitions**. Shared-host contention can violate
that assumption. A regression must clear the complete interval beyond the
relative budget; passing requires the complete interval inside both budgets.
Intervals crossing a budget remain `inconclusive`. Robust relative dispersion
uses 1.4826 × median absolute deviation / median across each variant's repeated
throughput and p95 samples. Excess dispersion or a measured generator above
its CPU budget also gives `inconclusive`, without widening the performance
budget. Both `inconclusive` and `regressed` exit nonzero; shorten neither the
repetitions nor correctness checks to turn a noisy result into a pass.

Node executable, OS, CPU model/count, total memory, workload hashes and worker
configuration are recorded. On Linux, the harness reads kernel CPU affinity and
all accessible cgroup-v2 ancestors before and after measurements, including
observed server descendants, and rejects a mismatch. Membership is mapped using
the cgroup2 mount's actual root and mount point. The tightest visible CPU and
memory ceilings and every observed ancestor remain in the report, so a change
only in a parent is detected even when the leaf says `max`. Host-effective
cgroup ceilings remain explicitly **unknown**: mount and cgroup namespaces can
hide further ancestors. Missing or malformed controller files also remain
unknown rather than being treated as unlimited. The harness imposes no quotas.
On Windows and macOS, enforced quota and affinity are explicitly **not verified**;
processor count is not treated as proof of a Windows Job CPU limit. Arrange a
quiet, controlled runner separately for release measurements. Server CPU and
memory are `null` because this harness has no complete descendant-aware sampler;
generator CPU comes from the existing generator's actual `process.cpuUsage()`.
A pass applies to this fixture and environment, not every application.

The manual `performance-release.yml` workflow uses the existing dedicated
`self-hosted`, `linux`, `prnext-performance` runner labels. Provide the absolute
path to its prepared comparison JSON outside the checkout, its reviewed SHA-256,
and the two explicit source commit labels through workflow dispatch. The labels
must match the JSON and remain declarations rather than proof of Git/archive
association. Before any load, a new output directory retains the original config,
a snapshot with paths resolved from its original location, and both hashes. The
comparison reads only that snapshot; output directories and uploaded artifacts
are never overwritten. One fixed workflow concurrency group serializes runs. Reserve that
runner exclusively for the experiment; the workflow does not change host
resource limits, install comparison applications or publish a release. It
retains the report and fails on an invalid, noisy or regressed result.

Use an isolated service/container per target, with identical measured CPU,
memory and Node heap limits. Include all descendants in CPU/memory accounting.
Record generator CPU and host contention, alternate variant order, retain each
sample and distinguish ranges from confidence intervals. On multiple workers,
compare equivalent process counts, including the reference load balancer's
resource cost. Keep compressed traffic separate from identity encoding.

The Flight unit/browser regressions cover changing table content, bounded
transport blocks, compression-aware fallback, slow source flushes, malformed
frames, cancellation and large-small-large navigation with all 3,000 visible
cells checked. A same-URL byte reduction is not a substitute for real navigation
timing or a comparison with Next.js segment caching.

Endurance should include both load and a quiet period longer than extra-lane
retirement, then verify fresh responses and descriptor/memory recovery. A short
increase in RSS or retained keep-alive connections does not prove a leak.
Record cold HTTP readiness, first SSR, explicit prewarm and wake after host
retirement independently. Never disable correctness checks to obtain a score.

The [26 October framework follow-up](NPM-IMPROVEMENTS-20261026.md) describes the
ten local improvements to caching, SSR diagnostics/deadlines, Webpack/CSS/HMR,
installation checks, types, migration and bundle analysis. It keeps its own frozen
baseline and does not replace the older platform comparisons below.

For the v4 continuation, frozen **uncommitted final v3** baseline, longer
campaign, runtime contract and retirement configuration, use [V4.md](V4.md).
The procedures and compatibility conclusions below describe the earlier
campaign; they do not override v4's explicit rejection of old worker builds.

These diagnostic tools reconstruct a production App Router workload from the
reported scenarios. They do not reproduce an unavailable original benchmark
application. Dynamic pages use `force-dynamic`, per-request UUIDs and cookies;
the streaming page waits 40 ms behind Suspense. No dynamic response cache is
added. The JSON API returns a fresh UUID and `private, no-store`.

`fixture.mjs <directory>` writes identical application sources for Next.js and
PRNext. Install its pinned dependencies, build once with each implementation,
and retain separate build directories and native binaries for before/after.
The reference used for the October 2026 measurements is commit
`63847087826f178de3a32f165231b20b6c66b92e` (0.1.11-alpha).

`windows-runner.py` requires Python 3 and psutil. A JSON configuration specifies
`command` (argv array), `cwd`, `node`, `url`, `cpu`, `idleCpu` and optional
`scenarios` (`[[route, connections], ...]`). It starts the target suspended,
assigns a Windows Job with one logical CPU, then resumes it. All Rust and Node
descendants inherit that limit. CPU comes from cumulative Job accounting, so
terminated workers remain counted. RSS is summed over the Job's live process
IDs every 500 ms; Windows console helpers are included. Threads and process
starts are recorded. The Node generator runs outside the Job on CPUs 8/9.
Do not schedule builds or other load on the target or generator cores.

```powershell
python tests/performance/windows-runner.py --config before.json --seconds 30 --repeats 3 --output before-results.json
python tests/performance/windows-runner.py --config after.json --mode idle --output idle-results.json
python tests/performance/windows-runner.py --config after.json --mode endurance --seconds 600 --repeats 1 --output endurance-results.json
node tests/performance/validate.mjs http://127.0.0.1:3000
python tests/performance/report.py
python -m unittest discover -s tests/performance -p "test_report.py"
```

Throughput mode warms each scenario for 5 seconds, then measures repeated
closed-loop keep-alive traffic. Requests started before the deadline are drained;
the rate counts responses completed within the measurement window. CPU per
response includes that final drain and divides by all completed responses.
Latency uses 0.1 ms histogram buckets (overflow at 12 seconds). All non-200
statuses, timeouts and transport errors count as errors. Cancellation is tested
separately rather than discarded from a generator's error totals.

Idle mode first measures 60 seconds with no dynamic traffic, then performs three
load/idle/resume cycles with 60, 300 and 900 seconds of real inactivity. Resume
checks freshness and cookie isolation and records both the first and second
request. Endurance uses a continuous streaming load. Reports retain individual
samples rather than only medians.

For static comparison, use exactly the same frozen build directory for both
native binaries, including the existing gzip files. Include a plain Pages page,
a public file and a built asset: these take different routing paths. Never
extrapolate Windows results (where the existing small-file byte cache is
disabled) to Linux, or compare these rates directly with a Linux Nginx result.

Raw local results, CPU profiles, exact argv and fixture hashes are retained in
`artifacts/performance`. The Windows Job accounting method includes nested
worker jobs; see Microsoft's [nested job accounting documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs#resource-accounting-for-nested-jobs).

## Lecture du rapport et limites des mesures

Les essais locaux du 10 octobre 2026 utilisent Windows 11 Pro 10.0.26100,
Ryzen 5 3600, 32 Gio, Node 24.19.0, Next.js 16.3.5 et React 19.3.0. Le serveur
chargé est sur CPU 2, le générateur sur 8/9, les orchestrateurs/compilations sur
10/11. Les essais au repos peuvent utiliser d'autres CPU dédiés, consignés dans
chaque JSON. Les processus déjà terminés restent inclus dans le CPU du Job,
ainsi que tous leurs threads. Les créations comptent tous les types de processus,
pas seulement Node ; les threads RSC partagent le PID du processus Node.

La RSS est une somme des working sets Windows, pas une mesure de PSS : les pages
partagées peuvent être comptées plusieurs fois et un pic bref peut échapper à
l'échantillonnage de 500 ms. Le CPU en pourcentage est rapporté à un cœur
logique. Les quantiles du tableau sont les médianes des p50/p95/p99 par mesure,
sans fusion des histogrammes. Le débit exclut les réponses du drainage final ;
le CPU par réponse l'inclut, divisé par toutes les réponses terminées. Les essais
sont séquentiels, sans randomisation : une différence faible ne suffit pas à
conclure. L'endurance ne prouve rien au-delà de sa durée réellement terminée.

`report.py` écrit `summary.json` et `report.html` en UTF-8 ; `--base <répertoire>`
sélectionne une autre collection. Chaque JSON est lu en une seule photographie.
Sans marqueur `final`, ou en cas de JSON tronqué/invalide, il reste exclu des
tableaux de performance et son état est affiché. Les sondes fonctionnelles,
sans ce marqueur, sont présentées séparément. L'effectif, les durées, débits
min/médian/max, configurations et SHA-256 proviennent des fichiers effectivement
lus. Les première/dernière minutes d'endurance utilisent les horodatages, pas un
nombre supposé d'échantillons. On peut régénérer le rapport pendant les mesures :
il indique alors explicitement les entrées encore absentes ou incomplètes.

## Corrections, constats confirmés et compatibilité

Le transport distingue l'annulation normale d'une panne de worker. Une lane de
socket dont la trame est incomplète peut être remplacée en conservant l'hôte Node
sain. Les permis et buffers se libèrent à l'annulation. L'admission RSC bornée
ferme temporairement les nouvelles admissions lors d'une rafale d'annulations
sans raccourcir les échéances des réponses légitimes. Les véritables dépassements
d'échéance restent un motif de retrait. `storm-verified.json` vérifie 32 annulations,
la survie d'un stream tiers et le SSR suivant. Les tentatives intermédiaires
conservées ne remplacent pas la vérification finale explicitement identifiée.

`validate.mjs` contrôle 96 UUID distincts, 32 cookies utilisateurs par route,
l'arrivée du fallback avant le résultat différé et 20 annulations successives.
Un PID Node conservé ne démontre pas l'absence de redémarrage d'un thread RSC.
`restarting render worker after failed request` compte une remise à zéro de lane,
pas nécessairement un processus relancé. `App Router worker exited` peut se
répéter pour plusieurs requêtes et ne compte pas des isolats uniques. Le rapport
conserve séparément ces occurrences, les EPIPE, les retraits pour non-réponse et
les créations de processus. Aucun compteur d'erreurs n'est retranché.

Les workers sont créés à la demande. Le retrait vise une économie de RAM avec
un coût éventuel de reprise : memory/compact 30 s, balanced principale 300 s,
speed/classic principale conservée ; lanes supplémentaires 30 s. L'attente se
fait par échéance, sans polling. Les réponses/streams actifs conservent leur
lane. Le signal d'activité négocié garde l'hôte Node réutilisable tant qu'une
invocation ou du travail suivi reste actif, même après retrait de ses lanes.
Il est regroupé avec le heartbeat existant, sans message par chunk.

Après un terminal HTTP normal, le contrôleur de réponse est dissocié du socket
avant `finalizeCache` : la fermeture d'une lane au repos n'annule plus cette
finalisation. Le délai de réponse RSC s'arrête à son terminal. Tant que du
travail RSC après réponse reste suivi, un watchdog partagé sonde sa réactivité
après 5 s et attend l'accusé pendant 30 s. Ce délai ne borne pas la durée totale
d'un travail asynchrone légitime ; le watchdog ne possède aucun timer au vrai
repos. Le suivi du travail dure jusqu'au message de settlement.

La destruction explicite du pool relâche sa rétention d'activité. Le protocole
négocié ferme stdin (EOF), laisse drainer les invocations et attend le processus
pendant 30 s ; en cas de dépassement, le collecteur le tue puis attend sa sortie.
À la destruction du runtime, `kill_on_drop` reste actif : les 30 s ne sont pas
une promesse de drainage après terminaison du serveur. Les anciens workers
sans négociation gardent leur ancien protocole ; les tâches détachées
arbitraires ne sont pas garanties. Aucun bug initial de polling
au repos n'a été démontré ; le rapport compare les mesures sans le supposer.

Ces garanties d'activité, de finalisation après réponse et de drainage exigent
de reconstruire l'application avec le runtime corrigé (`prnext build`, déjà
requis par la procédure de mise à niveau). Le nouveau binaire accepte encore
techniquement un ancien artefact manifestv1, mais un ancien worker sans
`activity`/`gracefulShutdown` ne protège pas une finalisation après End contre
le retrait de lane, y compris les lanes supplémentaires de speed/classic.
La compatibilité du protocole ne garantit donc pas ce nouveau comportement
avec d'anciens artefacts non reconstruits.

Le chemin statique regroupe confinement, métadonnées et lecture courte dans une
tâche bloquante. Le gzip sélectionné conserve son chemin canonique et ses
métadonnées. Le traitement HTTP complet reste disponible pour les requêtes
particulières. Les tests couvrent GET/HEAD, gzip pondéré, Range/If-Range, 304,
POST, changement/suppression de fichier et traversée de chemin. Les tests Unix
de symlink et d'invalidation du cache nécessitent toujours une exécution Unix.
Le scanner d'enveloppe HTML évite les copies intermédiaires par balise ; ses
tests couvrent les découpages de chunks, raw text, balises incomplètes et limites.

memory final passe de 16 à 20 réponses actives en conservant 8 démarrages de
rendu, 1 Mio de buffers, les petits heaps et optimizeForSize. Les résultats à
24 réponses restent exploratoires ; ils ne valident pas le réglage final à 20.

Le lockfile complète les six dépendances natives optionnelles manquantes.
L'installation isolée avec Node 24.19.0 et npm 11.12.1 a installé 308 paquets
en 18,43 s, scripts actifs, code de sortie 0 et empreinte du lockfile inchangée
(`npm-ci-node24.19.json`).
Cette installation réelle concerne Windows x64 seulement. Les six plateformes
optionnelles sont vérifiées dans le lockfile et les métadonnées, sans installation
native sur chacun de leurs systèmes.
`reactCompiler: false` et `typedRoutes: false` sont honorés ; leur activation
échoue explicitement, car ni React Compiler ni les déclarations de routes typées
ne sont implémentés. `typescript: {}` active un contrôle de production `noEmit`
dans un processus court, avec le TypeScript déjà installé dans l'application.
`tsconfigPath` sélectionne la configuration du contrôleur et du compilateur,
alias hérités inclus. `ignoreBuildErrors: true` désactive explicitement ce
contrôle ; le développement ne le lance pas. Sans option `typescript`, PRNext
conserve sa transpilation seule historique, contrairement à Next.js. Aucun
package, `next-env.d.ts`, type de route ou plugin de langage Next.js n'est créé
implicitement.

Les vérifications finales couvrent notamment cache/revalidation, Server Actions,
middleware, routage, workers et streaming :

- `unit-tests-verified.log` : v3, 665 tests, 664 réussis, 0 échec, 1 ignoré.
- `e2e-workers-verified.log` : v3, 85 tests E2E réussis, 0 échec.
- `next-conformance-verified.log` : 2 comparaisons Next.js16.3.5/PRNext réussies,
  exécutées en v2, couvrant import, rendu, navigation, API et routage des
  locales/domaines. Ces composants du compilateur n'ont pas changé en v3.
- `pool-owner-postresponse.log` : 33 tests Rust ciblés réussis, 0 échec ; les
  autres tests sont exclus par filtre. Exécution v2, code et binaire Rust
  inchangés en v3. `worker-control-pipe-tests.log` contient 3 tests ciblés de
  fermeture des pipes, également couverts par la nouvelle suite complète.

Commandes, versions et SHA du binaire : `unit-tests-verified.exit.json`,
`next-conformance-verified-exit.json` et `native-v3-build.json`. Le premier
candidat v1 a été archivé avant la correction supplémentaire du travail RSC
après réponse ; ses anciens chiffres (653 unités réussies/1 ignorée, 85 E2E,
33 RSC ciblés, 31 pool et2 profils Rust) restent dans son rapport propre.
Le test unitaire ignoré nécessite les headers de développement Node-API,
absents de cette machine. Les deux contrats ciblés avec Next ne constituent
pas une preuve de conformité exhaustive à Next.js.

Ces suites se recouvrent ; leurs effectifs ne s'additionnent pas. Les échecs
intermédiaires restent visibles : nettoyage Windows EBUSY, puis sortie du CLI
avec code 0 avant publication du manifeste. Ce second défaut venait d'un
`unref()` tardif pendant la terminaison du worker ; un test permanent vérifie
dix continuations après fermeture dans un sous-processus. Le suivi RSC attend
aussi la fin réelle du travail de cache après la fin du corps ou une annulation.

Les fenêtres du candidat v1 archivé et de ses contrôles cumulaient
**4 326 156 réponses, 0 erreur** :
2 351 056 en dynamique, 1 360 972 en statique et 614 128 en endurance, avant/après
et Next réunis. Le candidat v1 représente **1 979 945 réponses, 0 erreur**.
Ces effectifs incluent le drainage, mais excluent l'échauffement, la charge des
cycles de repos et les sondes fonctionnelles ; les annulations volontaires sont
testées séparément. Ce total historique ne valide pas la version v2. Les copies
et leur manifeste se trouvent dans `artifacts/performance/candidate-v1` ; le
runtime est conservé dans `app/.prnext-candidate-v1`, le binaire dans
`prnext-candidate-v1.exe`. Les argv historiques restent inchangés : le manifeste
indique les chemins à substituer pour rejouer les snapshots archivés.

Le candidat v2 est également conservé dans `candidate-v2`, avec son snapshot
`.prnext-after` laissé en place ; le runtime final est `.prnext-after-v3`.
Les noms `*-after-*.json`, `static-after.json` et
`endurance-after-results.json` à la racine sont réservés aux nouvelles mesures
v3. Le rapport ne comble jamais une donnée actuelle absente avec une ancienne mesure.
`summary.json.responseTotals` calcule les totaux actuels à partir des seules
mesures retenues, sans ajouter l'archive ou les essais exploratoires. Les anciens
logs vérifiés encore identiques à une copie sont étiquetés avec le candidat
archivé correspondant ; ils ne sont pas présentés comme une nouvelle exécution.

La paire statique finale (`static-final/evidence.json`) attend la fin des profils
balanced/memory et de l'endurance. Elle peut occuper la fenêtre des 15 minutes
de repos si les trois profils disposent encore d'au moins 680 s avant reprise ;
sinon elle attend leurs marqueurs finaux. Référence puis final, trois mesures
de 30 s par route après 5 s d'échauffement, puis 30 s de repos et une première
réponse identity par serveur. Ces diagnostics de reprise restent hors des
totaux de débit. L'évidence vérifie les hashes inchangés et l'absence de reprise
pendant la paire avant de publier atomiquement `complete: true`.
Le repos statique inclut le retrait des threads bloquants, avec une seule
fenêtre de 30 s par serveur ; il ne remplace pas les cycles de repos des workers
dynamiques. La reprise statique mesure uniquement un statut 200 et sa latence :
les champs génériques `freshness`/`isolation` sont faux en l'absence d'UUID et
de cookie attendus sur ce fichier. Les contrôles de fraîcheur et d'isolation
concernent les sondes dynamiques distinctes.

L'EPIPE du signalement initial sous déconnexions client n'a pas été reproduit.
Un autre EPIPE a été identifié pendant le développement du candidat v2 :
le heartbeat écrivait encore après fermeture du lecteur stdout lors de l'arrêt
explicite du pool. Avec une finalisation de cache de 2500 ms, le processus
sortait après 999,63 ms, code1, travail incomplet. Après correction du pipe de
contrôle, il sort après 2534,83 ms, code0, travail terminé. Sources :
`control-pipe-shutdown-before.json` et `control-pipe-shutdown-after.json`.
Ces observations concernent le candidat développé, pas la référence initiale.

## Diagnostics exploratoires, distincts de la validation finale

`static-preparation-results.json` (Rust debug, non épinglé) et
`html-envelope-results.json` (Node) isolent une opération ; leurs gains ne sont
pas ceux du serveur HTTP entier. `tuning/summary.json` et
`tuning/memory24-summary.json` utilisent deux répétitions de 15 s après 5 s
d'échauffement sur un binaire provisoire. Le premier balanced-default,
contaminé par une compilation initialement non épinglée, a été écarté et rejoué.
La suppression d'optimizeForSize a augmenté la RSS et n'a pas été retenue.

Les premiers profils Inspector de 5 s dans `tuning/` portent uniquement sur
l'isolat hôte Node. Les captures complémentaires `profile-rsc-ssr.cpuprofile`
et `profile-rsc-stream.cpuprofile` instrumentent le thread RSC, dans une copie
du build candidat v1 `.prnext-profile-rsc`, sur CPU 10 : 5 s capturées après 5,5 s
d'attente depuis le premier message, pendant une charge de 8 s précédée de
5 s d'échauffement. La session Inspector est connectée dans le thread RSC.
Le GC apparaît dans les samples SSR ; le stream est presque entièrement
échantillonné inactif. Le profilage perturbe l'exécution et ne couvre jamais Rust.
Ces samples ne permettent pas d'attribuer le CPU total au GC ni de comparer
directement sa part entre profils. Le CPU du Job reste la mesure globale.
Le drapeau V8 de diagnostic des essais antérieurs change à l'exécution et peut
affecter les futurs isolats ; cela ne reproduit pas exactement son retrait au
démarrage. Les profils bruts et leurs résumés conservent ces limites. Les captures
RSC ne changent aucun drapeau V8 et ne servent pas à une comparaison de débit.

`blocking32/summary.json` conserve la répétition calme de la référence et de v1,
ainsi qu'un binaire diagnostic plafonnant le pool bloquant Tokio à 32 threads.
Chaque route a deux mesures de 15 s après 5 s d'échauffement, puis 15 s de repos
et une première réponse sans compression. Les 512 threads observés en statique
avant comme après sont des threads bloquants Tokio, sans worker Node. Le plafond
réduit leur nombre mais augmente la RSS statique et produit des résultats de
débit mixtes ; il n'est pas intégré. Les effets d'ordre, le petit effectif et
l'identité différente du crate binaire restent des limites. Cette répétition ne
retrouve pas les régressions de débit asset et SSR balanced du premier passage
v1 ; elle ne les remplace pas et ne valide pas le runtime final v3.
