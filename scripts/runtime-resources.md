# Mesurer une optimisation du runtime

`bench-runtime-resources.mjs` compare une copie figée du runtime à un candidat reconstruit et à Next.js. Il réutilise les sources, le générateur de charge et les vérifications du benchmark dynamique. Le rapport historique `reports/dynamic-parity` n'est pas remplacé.

## Protocole

1. Préparer les projets de référence avec `npm run bench:dynamic -- --parity-only`, ou utiliser leurs artefacts existants dont la parité a été vérifiée.
2. Avant de modifier le runtime : `node scripts/bench-runtime-resources.mjs snapshot`. Le script refuse d'écraser une copie existante. Les projets et le binaire de référence sont conservés sous `reports/runtime-resources/projects`, ignoré par Git.
3. Après les changements : `npm run build:native`, puis `node scripts/bench-runtime-resources.mjs build`. Le candidat conserve exactement les mêmes fichiers applicatifs que la référence.
4. Exécuter séparément `node scripts/validate-runtime-resources.mjs next`, puis les variantes `baseline`, `candidate` et `compact`. Chaque variante passe 21 contrôles, y compris 10 000 rendus SSR réels, Flight dans le navigateur, mutation/revalidation et streaming sous blocage contrôlé du backend.
5. Sans autre benchmark ni tests simultanés, lancer la campagne :

```sh
RESOURCE_REQUIRE_PARITY=1 \
RESOURCE_RESULT=final-results.json \
RESOURCE_VARIANTS='[{"name":"baseline","engine":"baseline"},{"name":"candidate","engine":"candidate"},{"name":"compact","engine":"candidate","env":{"PRNEXT_MEMORY_PROFILE":"compact"}},{"name":"next","engine":"next"}]' \
node scripts/bench-runtime-resources.mjs

node scripts/verify-runtime-resources.mjs
node scripts/report-runtime-resources.mjs
```

Le contrôle préalable compare les artefacts validés aux artefacts mesurés, les statuts, headers significatifs, cookies, données, contenu visible, traces d'exécution et appels backend. Il refuse un scénario différent ou une route dynamique pré-rendue. Les différences connues sur les redirections, 404, Flight et Server Actions restent explicitement exclues.

Six scénarios sont mesurés : SSR sans cache, SSR avec données, Route Handler GET, Pages API GET, données en cache avec HTML dynamique, et Streaming/Suspense. Les profils demandent 250 requêtes/s pendant 6 s, puis 32 requêtes simultanées pendant 4 s. Trois répétitions alternent l'ordre des quatre moteurs/configurations. Chaque réponse est validée et les compteurs applicatifs/backend sont contrôlés après chaque passage. Chaque mesure redémarre le serveur, chauffe 64 opérations et réinitialise les compteurs.

La RAM additionne les RSS du serveur natif et de tous ses descendants. Le CPU serveur exclut l'API déterministe et le générateur de charge. Les latences incluent le corps HTTP complet, tandis que TTFB mesure les premiers octets du corps. Le CSV et les fichiers JSON conservent les mesures individuelles ; le rapport présente les médianes et permet de consulter les variations min/max. Les chiffres à concurrence 32 peuvent avoir des débits différents : ne pas les présenter comme une consommation à débit identique.

`RESOURCE_BENCH_OUTPUT` choisit un autre répertoire. Les variables `RESOURCE_SCENARIOS`, `RESOURCE_PROFILE`, `RESOURCE_REPETITIONS` et `RESOURCE_VARIANTS` servent aux essais exploratoires. Les presets V8 essayés par `NODE_OPTIONS` sont enregistrés dans le résultat ; les profils exploratoires ne sont pas mélangés au résultat final. Le générateur de rapport final exige les 144 mesures et le contrôle de parité.

## Changements du runtime

- La sélection des sources de routage n'importe plus le moteur de métadonnées dans le renderer HTML. Le middleware n'est importé dans le thread RSC que pour un contrôle d'accès qui en a besoin.
- Le suivi des dépendances statiques évite de construire des chemins pour les requêtes purement dynamiques. La préparation des fetch ne crée plus un second objet Headers lorsque le corps n'est pas un FormData.
- Les recherches de rendus actifs/cancelés parcourent les entrées sans créer de tableaux temporaires. La vérification d'un cookie Draft Mode absent évite un parsing inutile.
- Le multiplexage HTML/Flight observe chaque lecture une fois. Une source lente ne conserve plus une succession de réactions Promise.race attachées pour chaque bloc de l'autre source.
- Le profil compact optionnel utilise `--optimize-for-size` et `--max-semi-space-size=4`. Le paramètre `maxYoungGenerationSizeMb` du worker RSC passe à 8 Mio ; Node donne toutefois la priorité au flag V8 de semi-espace. Les valeurs Node explicites pour le semi-espace sont respectées. Aucun plafond old-space, GC forcé, arrêt de worker ou cache HTML supplémentaire n'intervient.

Les options V8 sont documentées par [Node](https://nodejs.org/download/release/v22.17.1/docs/api/cli.html#--max-semi-space-sizesize-in-mib), ainsi que leur [priorité sur les limites des workers](https://nodejs.org/download/release/v22.17.1/docs/api/worker_threads.html#new-workerfilename-options) ; `node --v8-options` décrit `--optimize-for-size` comme un compromis mémoire/vitesse. Un conteneur très contraint peut déjà choisir une génération plus petite : mesurer sur le VPS cible avant de généraliser les résultats macOS.

Une tentative de généralisation des contextes paresseux a été écartée : les essais ont montré une hausse du RSS des API malgré des économies d'allocations attendues. Les contextes de requête existants sont conservés. La campagne partielle correspondante est archivée dans `lazy-api-pilot.json` et ne fait pas partie des chiffres finaux.

## Diagnostic de rétention

```sh
node scripts/diagnose-stream-retention.mjs
```

Cette sonde compare deux flux asymétriques avec 4 096 blocs de 4 Kio. Elle force le GC dans deux processus de diagnostic séparés pour distinguer les blocs encore vivants de la RSS réservée par V8. Ce n'est pas un benchmark de production ; le runtime ne force jamais cette collecte. Exécuter cette sonde séparément des mesures de performances.
