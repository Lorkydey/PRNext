# Projets Next.js pour comparer une migration vers PRNext

Cinq sites fictifs et une variante Node, avec des données déterministes pour reproduire les écarts :

- `boutique` : catalogue, images optimisées, pages produit statiques, panier client, Server Actions Node et Edge, cookies, API et redirection.
- `journal` : Pages Router, français/anglais, articles SSG/ISR, recherche SSR, navigation shallow, composant chargé avec `next/dynamic`, API avec validation et 404.
- `dashboard` : Cache Components/PPR, profil personnalisé par cookie sous Suspense, formulaire serveur, navigation interceptée avec modal, état du layout et accès canonique.
- `boutique-node` : variante de diagnostic de la boutique. Seuls le nom du package et `runtime='nodejs'` sur `/edge` diffèrent. Cette page devient pré-rendue sur les deux moteurs ; ce n'est donc pas un benchmark de SSR Node. Les Server Actions restent exercées séparément.
- `portail` : App SSR personnalisé, recherche, package npm `clsx`, état client conservé, proxy avec cookie, API JSON immédiate et avec attente de 30 ms, export volumineux et streaming Suspense avec attente de 80 ms.
- `documentation` : Pages Router, 100 pages SSG avec texte volumineux, ISR et revalidation explicite, API de recherche, fichier public compressible et 404.

Les projets utilisent React, les API Next et, pour le portail, `clsx`. Aucun composant n'est réécrit pour PRNext. Les sources sont conservées ici ; leurs empreintes sont vérifiées avant compilation. L'ancien runner utilise des copies temporaires pour les quatre premiers projets ; le nouvel audit conserve les six paires de copies dans son dossier de rapport.

## Audit complet des six configurations

```sh
PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next \
AUDIT_REPORT_DIR=reports/next-audit-nouveau \
node scripts/audit-next-projects.mjs

AUDIT_REPORT_DIR=reports/next-audit-nouveau node scripts/report-next-audit.mjs
```

Le dossier de sortie doit être nouveau. L'audit conserve les projets sous `projects/<nom>/next` et `projects/<nom>/prnext`, leurs builds et les commandes pour les relancer. Les dépendances restent des liens locaux ; pour déplacer ces projets sur une autre machine, réinstaller les packages depuis leurs `package.json`. La référence Next doit pouvoir charger sa dépendance native Sharp ; une installation endommagée ferait retourner l'image originale au lieu d'une image optimisée.

Le rapport généré dans le dossier de sortie local fournit les graphiques interactifs, tableaux CPU/RAM/débit/latence, 44 contrôles fonctionnels, captures avant/après, volumes réseau, builds froids et incrémentaux, premières requêtes, images, essais à concurrence 1/16/128 et deux charges de 60 secondes. `measurements.csv` et `summary.csv` s'ouvrent dans Excel ou LibreOffice. Les rapports sont ignorés par Git. Les mesures serveur excluent le client ; le CPU du navigateur et de compilation n'est pas mesuré.

Les routes sont mesurées trois fois pendant 3 s, les parcours mixtes trois fois pendant 10 s, avec quatre requêtes simultanées. Les essais de forte concurrence sont distincts : les refus y sont conservés, et leurs débits ne sont pas présentés comme un travail équivalent. Un worker PRNext est configuré. Ne pas exécuter d'autres tests lourds pendant l'audit.

`AUDIT_PHASE=prepare` prépare et vérifie les projets ; `AUDIT_PHASE=load` reprend uniquement les passages absents. `AUDIT_SITES=portail,documentation` sélectionne les projets et `AUDIT_SCENARIOS=api-async,stream` peut restreindre une reprise. Un passage déjà enregistré, même en échec, n'est pas écrasé automatiquement. `AUDIT_REPETITIONS`, `AUDIT_DURATION_MS` et `AUDIT_MIXED_MS` doivent conserver les mêmes valeurs lors d'une reprise.

## Rejouer la comparaison

Depuis la racine du dépôt, avec ses dépendances, le serveur Rust compilé et Chromium Playwright installés :

```sh
PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next node scripts/compare-migration-sites.mjs
```

La référence doit contenir Next **16.3.5**, React **19.3.0** et React DOM **19.3.0** côte à côte. Le runner lie ces mêmes packages aux deux copies, ainsi que le package RSC et scheduler du dépôt. Aucun téléchargement ni installation ne se fait pendant la comparaison.

Résultats : `reports/next-migration/index.html`, `results.json`, captures PNG et journaux de build/serveur. Un code de sortie **1** signale un écart ou un build bloqué ; le runner termine quand même les autres projets. `MIGRATION_REPORT_DIR` permet de choisir un autre répertoire de sortie.

Pour ajouter une comparaison CPU/RAM/débit sur les mêmes projets :

```sh
MIGRATION_BENCH=1 PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next node scripts/compare-migration-sites.mjs
```

Elle ajoute `performance.html`, trois graphiques SVG, `performance.md` et les mesures brutes dans `results.json`. Trois répétitions par moteur, un accueil seul et une charge mixte, quatre requêtes concurrentes, deux secondes de mesure après 200 requêtes d'échauffement. Chaque charge démarre un nouveau serveur. La recherche SSR et le profil PPR utilisent des valeurs différentes à chaque requête, vérifiées dans la réponse. Exécuter cette commande sans lancer simultanément d'autres tests ou benchmarks.

La campagne optimisée est conservée séparément dans `reports/next-migration-optimized` (utiliser `MIGRATION_REPORT_DIR`), pour conserver les chiffres de référence. Pour compléter par deux minutes de charge PPR à huit requêtes concurrentes par moteur :

```sh
PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next node scripts/check-ppr-stability.mjs
node scripts/report-migration-optimization.mjs
```

La première commande écrit `reports/next-migration-optimized/stability.json`, avec les séries RSS et une observation au repos. La seconde compare les deux campagnes et produit `optimization.html` et `optimization.md` ; elle vérifie que les versions, la machine et les sources des sites correspondent. Elle exige que les deux campagnes et l'essai prolongé aient été exécutés.

Pour essayer un projet à la main, entrer dans son dossier, installer les dépendances et utiliser ses scripts `npm run build` / `npm start`. Pour PRNext, installer le package dans le projet, puis utiliser `npx --no-install prn migrate`, `npx --no-install prn build` et `npx --no-install prn start`.

La comparaison CPU PPR utilise des passages plus longs et un ordre tournant :

```sh
MIGRATION_REPORT_DIR=reports/next-migration-cpu PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next node scripts/bench-ppr-cpu.mjs
MIGRATION_REPORT_DIR=reports/next-migration-cpu PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next node scripts/check-ppr-stability.mjs
```

Le premier essai effectue trois passages de 30 secondes à huit connexions par moteur, avec des serveurs et bases de cache neufs. `PPR_DURATION_MS` et `PPR_REPETITIONS` règlent ces valeurs. Pour ajouter PRNext avant, `PPR_BASELINE_DIR` désigne un dossier contenant son binaire `prnext` et ses anciens modules à substituer sous `runtime/` et `compat/` ; les fichiers absents restent ceux du build actuel. Les bundles applicatifs sont identiques. Les SHA-256 du binaire, des modules et des sources sont conservés dans `cpu-results.json`. Le rapport CPU local distingue les passages répétés et le contrôle de 120 secondes. Il se régénère avec `node scripts/report-ppr-cpu.mjs`, après les mesures et le relevé de validation `validation.json`.

## Portée

Les assertions comparent les résultats visibles, les statuts HTTP, les réponses API et les interactions. Les octets HTML et Flight, les noms de chunks et les identifiants d'actions diffèrent normalement selon le moteur et ne sont pas comparés littéralement. Les captures attendent les contenus utiles, notamment la partie dynamique PPR.

Les mesures locales servent de repères, sans démontrer une compatibilité universelle ni la capacité maximale en production. Le rapport précise le protocole de chaque série et distingue les observations uniques des répétitions. Le CPU est celui du serveur et de ses descendants ; la RAM est leur RSS additionné, pas uniquement le heap JavaScript. Les relevés au démarrage, après parcours et sous charge ne sont pas interchangeables. Les pics des essais de charge sont des maxima échantillonnés, qui peuvent manquer des pointes très brèves.
