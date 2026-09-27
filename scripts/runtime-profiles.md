# Comparaison des profils PRNext

Le benchmark utilise la fixture de parité dynamique existante. Il mesure les cinq profils actuellement disponibles (`classic`, `compact`, `balanced`, `speed` et `memory`) sur **un seul build applicatif et un seul binaire PRNext**. `balanced` est le défaut de production ; `classic` reprend les réglages de l’ancien `standard`. Next.js sert à vérifier la parité fonctionnelle ; ses performances ne sont pas rechronométrées dans cette campagne.

## Reproduire

Préparer les dépendances et les fixtures comme indiqué dans [le protocole dynamique](dynamic-benchmark/README.md). Sur un dépôt neuf, `npm run bench:dynamic -- --parity-only` produit les projets sous `reports/dynamic-parity/projects`.

Utiliser un dossier neuf pour préserver les rapports précédents :

```sh
npm run build:native
export RESOURCE_BENCH_OUTPUT=reports/runtime-profiles-new
node scripts/bench-profiles.mjs snapshot
node scripts/bench-profiles.mjs build
node scripts/bench-profiles.mjs validate
node scripts/bench-profiles.mjs run
```

Le snapshot refuse d’écraser un projet existant. Le build prépare la copie candidate avec le runtime actuel. La validation rejoue 21 contrôles pour Next.js et chacun des cinq profils : SSR, paramètres, headers, cookies, API GET/POST, données, cache, revalidation, navigation Flight, Actions et ordre du streaming. Elle inclut 10 000 rendus dynamiques pour 10 000 requêtes SSR identiques dans chaque configuration.

Avant chaque campagne de mesure, le programme vérifie les sources communes, les empreintes des artefacts, le binaire validé, les variables des profils et la parité des scénarios retenus. Un changement du runtime demande un rebuild et une nouvelle validation. Les adaptations Flight/Actions restent signalées dans les preuves.

`node scripts/bench-profiles.mjs pilot` lance une exploration plus courte, séparée dans `pilot-results.json`. Ce fichier est remplacé par chaque nouveau pilote ; utiliser un autre dossier pour conserver plusieurs expériences. Il n’entre pas dans le rapport final.

## Mesures

60 mesures : cinq profils × deux scénarios × deux charges × trois répétitions. SSR sans cache et streaming avec un appel backend déterministe retardé de 40 ms. Gzip identique, réponse vérifiée intégralement et comptage des rendus/backend à chaque passage.

La charge fixe demande 250 req/s pendant 6 secondes avec au plus 32 requêtes simultanées. La charge concurrente utilise 128 clients pendant 4 secondes. Serveur neuf par mesure, 64 requêtes de chauffe, ordre des profils inversé un passage sur deux. Aucune compilation ou suite de tests ne doit tourner pendant le benchmark.

La RSS comprend l’arbre serveur Rust + Node et les threads RSC ; le client et l’API locale sont exclus. Le CPU par réponse est distinct de la charge CPU par seconde. Le CSV contient aussi la RSS au repos, le pic sous charge, p50/p95/p99, TTFB, octets compressés et appels backend/s.

## Produire le rapport

Exécuter les tests appropriés séparément. Enregistrer leurs résultats dans `validation.json` dans le dossier de sortie, puis :

```sh
node scripts/report-profiles.mjs
```

Le générateur vérifie les 60 mesures, les 126 contrôles de parité, les empreintes des preuves et les six compteurs de 10 000 exécutions. Il écrit `index.html`, `README.md`, `metrics.csv`, `summary.json` et `verification.json`. Les chiffres sont des médianes de trois passages ; le JSON inclut les minima et maxima. Les écarts utilisent `classic` comme référence, ou `standard` pour les campagnes historiques, dont les étiquettes et mesures restent conservées. Les mesures courtes ne prouvent pas l’endurance ni un classement universel des profils.

Le mode `cpu` a été retiré du runtime. Les anciennes campagnes à six ou quatre profils restent des archives et peuvent être relues avec leurs preuves. Pour comparer Next.js aux quatre profils présentés dans le README, la préparation reconstruit maintenant les deux moteurs depuis les mêmes sources avant les contrôles de parité :

```sh
export RESOURCE_BENCH_OUTPUT=reports/next-all-profiles-new
export PROFILE_COMPARE_ENGINES=next,balanced,speed,memory,classic
node scripts/compare-profile-modes.mjs prepare
node scripts/compare-profile-modes.mjs run
node scripts/compare-profile-modes.mjs report
```

`DYNAMIC_BENCH_REFERENCE` permet de choisir l'installation Next.js de référence épinglée par la fixture. Les [résultats du 27 septembre](../reports/next-all-profiles-2026-09-27/README.md) comparent ces cinq configurations dans une même campagne de 60 mesures.
