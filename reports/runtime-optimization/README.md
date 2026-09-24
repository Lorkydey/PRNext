# CPU, mémoire et récupération des workers

Ouvrir [performance.html](performance.html). Les mesures sont dans [results.json](results.json), les médianes dans [summary.csv](summary.csv), les conclusions dans [analysis.md](analysis.md).

Cette campagne compare Next.js, Rustyx **après l’optimisation async précédente** et Rustyx avec les nouvelles optimisations du runtime. Le point de départ « avant » est donc plus récent que celui du rapport `async-concurrency`. Les trois projets ont des sources identiques entre moteurs ; leurs copies optimisées sont conservées sous `projects/`.

Les scénarios retenus ciblent les changements : API immédiate, proxy applicatif + SSR, PPR HTML et Flight personnalisés, API Pages POST courte et avec 32 Kio de données JSON, charge mixte à 128 clients. Trois passages de huit secondes, ordre des moteurs alterné, nouveau serveur et préchauffage à chaque passage. Chaque stress du dashboard est suivi de 35 secondes de repos pour laisser expirer les ports TIME_WAIT de la référence antérieure, dont le pool du cache renouvelait excessivement ses connexions. Les tests fonctionnels vérifient séparément les uploads binaires de 2 Mio, les limites à 8 Mio, les annulations, le proxy externe, la concurrence et la récupération après blocage.

## Reproduction

Préparer une nouvelle destination avec le même binaire de référence et les builds conservés :

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next \
SOLID_BASELINE=/chemin/vers/binaire-avant \
SOLID_REPORT=reports/runtime-nouveau \
SOLID_PHASE=prepare node scripts/bench-solid-runtime.mjs
```

La sauvegarde locale de cette campagne est `/tmp/rustyx-before-solid/rustyx`. Les builds Rustyx antérieurs restent sous `reports/async-concurrency/projects/`, ceux de Next sous `reports/next-audit/projects/*/next`. Ne pas reconstruire ces références avec le nouveau runtime. Les dépendances, builds et liens locaux `node_modules` sont ignorés par Git.

Après arrêt des tests et compilations :

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next \
SOLID_BASELINE=/chemin/vers/binaire-avant \
SOLID_REPORT=reports/runtime-nouveau SOLID_PHASE=load \
SOLID_SCENARIOS=api-fast,proxy,ppr-html,ppr-flight,api-pages,api-upload,capacity-128 \
node scripts/bench-solid-runtime.mjs
```

Les hashes SHA-256 empêchent de mélanger des versions lors d’une reprise. Le texte d’analyse provient de `analysis.md` ; générer les graphiques et le tableau avec :

```sh
SOLID_REPORT=reports/runtime-nouveau node scripts/report-solid-runtime.mjs
```

Le CPU et le RSS incluent le serveur et ses descendants, y compris les threads RSC dans le RSS de leur processus. Le client de charge est exclu mais partage la machine. Le RSS peut compter plusieurs fois des pages physiques partagées. La charge est en boucle fermée : le nombre de clients est imposé, pas un débit d’arrivée indépendant. Ces essais courts ne remplacent ni une charge distribuée, ni un test d’endurance, ni une preuve de compatibilité Next.js exhaustive.

La première campagne exploratoire et ses perturbations sont archivées dans [initial-results.json](initial-results.json) et [port-exhaustion.json](port-exhaustion.json). Elle a révélé le défaut de réutilisation du pool du cache, corrigé avant la campagne finale. Les résultats exploratoires ne sont pas mélangés aux chiffres finaux.
