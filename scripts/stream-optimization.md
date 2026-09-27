# Optimisation du streaming : reproduction

La campagne compare cinq configurations : PRNext avant/après en standard, avant/après en compact, et Next.js. Elle conserve le fixture dynamique et le générateur de charge existants. Le rapport précédent `reports/runtime-resources` reste disponible séparément.

## Préparer une nouvelle expérience

À exécuter **avant de changer le runtime**, avec un binaire release correspondant aux sources et les fixtures de `npm run bench:dynamic -- --parity-only` disponibles :

```sh
npm run build:native
node scripts/bench-stream-optimization.mjs snapshot
```

Le snapshot refuse d'écraser un dossier existant. Il reconstruit l'application PRNext et fige son runtime ainsi que son binaire natif. Utiliser `RESOURCE_BENCH_OUTPUT` pour un autre dossier. Le snapshot de cette expérience reprend les artefacts déjà vérifiés du candidat de `runtime-resources` : le sélecteur de streams et le profil compact étaient donc déjà présents dans la version « avant ».

Après la modification :

```sh
npm run build:native
node scripts/bench-stream-optimization.mjs build
node scripts/bench-stream-optimization.mjs validate
node scripts/bench-stream-optimization.mjs
node scripts/report-stream-optimization.mjs
```

Les cinq validations exécutent chacune les 21 contrôles existants, avec 10 000 requêtes SSR identiques donnant 10 000 rendus réels. Pour cette expérience, les preuves Next et PRNext avant sont reprises de leurs artefacts figés déjà validés ; les preuves du nouveau binaire sont rejouées. Avant toute campagne, le script compare les empreintes des builds, les options standard/compact et la parité des scénarios sélectionnés.

## Ce qui est mesuré

- Streaming/Suspense : shell immédiat, composant async avec un fetch `no-store` et un délai backend déterministe de 40 ms.
- SSR sans cache et SSR avec données : contrôles pour détecter une régression hors streaming.
- Trois passages par configuration et scénario, à 250 requêtes/s pendant 6 secondes et à concurrence 32 pendant 4 secondes. L'ordre est inversé au deuxième passage.
- Serveur neuf, 64 requêtes de chauffe, remise à zéro des compteurs et du backend avant chaque mesure.
- Contrôle de chaque réponse, statut, headers significatifs, gzip, cookies et contenu. Les compteurs doivent prouver un rendu et, pour le streaming, une exécution async, une complétion et un appel backend par réponse.
- RSS de tout l'arbre serveur, CPU par réponse, charge CPU, latences et TTFB p50/p95/p99, octets compressés, débit backend. Client et backend exclus de la consommation serveur.

Les mesures courtes détectent une différence locale ; elles ne prouvent pas une capacité maximale universelle ou l'endurance d'un VPS. Les gains de débit à concurrence identique ne représentent pas un travail total identique. Consulter aussi la comparaison à 250 requêtes/s.

## Admission en deux étapes

Le natif accepte au plus 32 réponses de pages vivantes par worker concurrent, mais seulement 16 démarrages avant réception des headers du worker. Dès que les headers sont prêts, seul le permis de démarrage est rendu. Le permis de réponse reste détenu jusqu'à la consommation, la déconnexion ou l'expiration du flux.

Cette séparation permet aux pages Suspense d'attendre leurs données sans monopoliser tous les démarrages. Elle conserve la limite du travail avant headers et les budgets existants : file bornée, buffers de réponse natifs partagés de 8 Mio par défaut, quotas de corps de requêtes, pression de retour et délais d'expiration. Ces quotas ne plafonnent pas la mémoire utilisée par les composants React ou le code npm.

Un simple passage global de 16 à 32 a d'abord été essayé puis écarté après une régression CPU du SSR compact. Ces mesures sont archivées dans `global-32-pilot.json`, séparément de `final-results.json`. Les autres fichiers `*-pilot.json` restent également exploratoires.

Les tests d'intégration prouvent que 32 shells peuvent progresser, que le 33e attend, qu'une annulation lui rend une place sans annuler ses pairs, que les cookies/headers restent isolés et que seuls 16 rendus sans shell peuvent démarrer à la fois. Les tests Rust vérifient séparément la durée de vie des deux permis.
