# Utiliser un projet Next.js existant

Rustyx compile directement les conventions `app/`, `pages/`, `src/`, `next.config.*` et les imports `next/*` pris en charge. Il n'est pas nécessaire de copier le projet dans ce dépôt ni de renommer ses composants. Le CLI de ce dépôt reste nécessaire : le paquet n'est pas encore publié comme distribution npm autonome.

## Migration avec `rx`

`rx` et `rustyx` sont deux noms du même CLI, fournis par le paquet **rustyx**. Il ne faut pas installer un paquet npm nommé `rx`. Après `npm install` dans le dépôt Rustyx, lancer depuis ce dépôt :

```sh
npx --no-install rx migrate /chemin/vers/mon-projet --dry-run
npx --no-install rx migrate /chemin/vers/mon-projet
```

Une fois Rustyx installé dans l'application, `npx --no-install rx migrate` accepte aussi le dossier courant. `rustyx migrate` est équivalent. La migration :

- vérifie la configuration et les conventions de routes avant les modifications ;
- sauvegarde `package.json` et les lockfiles existants sous un nom `.rustyx-backup`, avec suffixe en cas de conflit ;
- remplace les scripts simples `next dev/build/start` par `rx dev/build/start`, et conserve leurs originaux dans `dev:next`, `build:next`, `start:next` ;
- conserve les ports, noms d'hôte et dossiers explicitement définis ; retire les sélecteurs de bundler `--turbo`, `--turbopack`, `--webpack` ;
- ajoute Rustyx, aligne `react`, `react-dom` et `react-server-dom-webpack` sur la version requise par le runtime, puis lance `npm install` et vérifie les versions installées.

Next.js reste dans les dépendances. Les sources et `next.config.*` sont conservés. Les scripts shell complexes ou les options non prises en charge bloquent la migration avant toute réécriture, avec une indication de l'adaptation manuelle à faire. Les préfixes simples de variables d'environnement et `cross-env` sont reconnus, y compris un `PORT` littéral. Les incompatibilités de peer dependencies ne sont pas contournées avec `--force`.

Dans ce checkout privé, la dépendance Rustyx est un lien local `file:` : conserver le dépôt à son emplacement. Le CLI n'est pas encore autonome pour une publication npm. Pour pnpm, Yarn, Bun ou un workspace, utiliser `--no-install`, puis installer avec le gestionnaire du projet depuis la bonne racine. `--dry-run` affiche les changements sans écrire ni installer ; `--json` produit un rapport structuré. La configuration JavaScript du projet est exécutée pendant la vérification, comme pour `check`.

Après migration, depuis le projet :

```sh
npx --no-install rx check
npm run build
npm start
# Développement : npm run dev
```

Le statut `migrated` confirme l'installation et la pré-vérification, pas une compatibilité complète : compiler puis tester l'application reste nécessaire. Avec `--no-install`, le statut `prepared` signifie que l'installation et la validation des versions restent à faire. Si npm échoue, la commande retourne un échec avec les chemins des sauvegardes ; `node_modules` peut avoir été partiellement modifié. Pour revenir en arrière, restaurer les sauvegardes de `package.json` et du lockfile, puis réinstaller avec le gestionnaire d'origine. Les scripts `*:next` permettent de relancer Next, avec les versions de dépendances actuellement installées.

## Tester le checkout local avec Yarn

Avec Yarn et `nodeLinker: node-modules`, un lien `portal:` peut échouer avec `YN0071` lorsque l'application utilise d'autres versions d'esbuild ou de PostCSS. Pour ce cas, Yarn recommande un lien `link:` avec les dépendances du framework installées séparément. Installer d'abord les dépendances dans le dépôt Rustyx avec `npm ci`. En supposant que le dépôt et l'application sont deux dossiers voisins, exécuter depuis l'application :

```sh
corepack yarn add --exact rustyx@link:../rustyx/packages/rustyx react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0 webpack@5.111.1
```

Le protocole `link:` ne lit pas les dépendances et les exécutables du paquet. Ajouter donc ces deux entrées aux scripts de l'application pour exposer le CLI local :

```json
{
  "rx": "node ../rustyx/packages/rustyx/cli.mjs",
  "rustyx": "node ../rustyx/packages/rustyx/cli.mjs"
}
```

`corepack yarn rx --version` vérifie le CLI, puis `corepack yarn rx check` vérifie l'application. Il s'agit d'une installation de développement liée au checkout, pas d'une validation du futur paquet publié. Les scripts Next existants peuvent rester en place pour les comparaisons. La compatibilité de l'application reste à valider même après une installation réussie ; les scripts shell personnalisés nécessitent toujours une adaptation avant `migrate`.

Référence : [Yarn — erreur YN0071 et lien local](https://yarnpkg.com/advanced/error-codes#yn0071--nm_cant_install_external_soft_link).

## Vérifier et compiler sans migration

Depuis le dépôt Rustyx, avec les dépendances du projet déjà installées :

```sh
node packages/rustyx/cli.mjs check /chemin/vers/mon-projet
node packages/rustyx/cli.mjs build /chemin/vers/mon-projet
node packages/rustyx/cli.mjs start /chemin/vers/mon-projet --port 3000
```

`check --json` fournit un rapport exploitable par un outil. Cette pré-vérification contrôle la configuration, les conventions de routes et les versions installées ; elle ne compile pas le graphe des imports et ne garantit pas le fonctionnement de toutes les dépendances. `build` reste indispensable. Les sources, scripts npm et dépendances ne sont pas réécrits par `check`. La configuration du projet est néanmoins exécutée, comme lors d'un build.

L'App Router utilise le protocole RSC de React **19.3.0**. Si `check` indique un décalage, exécuter dans une copie de travail du projet :

```sh
npm install --save-exact react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0
```

Pour développer, remplacer `build` puis `start` par `node packages/rustyx/cli.mjs dev /chemin/vers/mon-projet`. Les scripts Next existants restent disponibles pour comparer les comportements.

Le serveur HTTP, le routage, les images et les caches sont en Rust. Le code React et les packages npm JavaScript restent exécutés par Node/V8. Une application statique peut être servie sans démarrer ces workers, ou être publiée avec [`output: 'export'`](static-export.md).

## Compatibilité vérifiée et limites

Le blog réel `tailwind-nextjs-starter-blog` a également été testé avec Contentlayer : configuration, génération MDX, développement, build et interactions navigateur. Consulter les [résultats et limites de cette validation](contentlayer.md).

La suite `npm run test:next-compat` compare un même projet temporaire à **Next 16.3.5** et Rustyx : rendu App/Pages, paramètres statiques, redirections/réécritures, API JSON, Preview Mode, métadonnées, hydratation, navigation et état du layout. Elle utilise un Next installé séparément :

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next npm run test:next-compat
```

Cette installation de référence doit contenir `next@16.3.5`, `react@19.3.0` et `react-dom@19.3.0` côte à côte. Le test partage leurs fichiers React pour éviter deux instances lors du chargement du paquet Next lié.

Ce contrat limité ne certifie pas une compatibilité à 100 %. L'[i18n Pages](i18n.md), les [loaders et certains hooks webpack/Turbopack](compiler.md), les Server Actions Edge et les échantillons de validation PPR sont pris en charge. Les plugins webpack arbitraires, les dépendances aux internes de Next, Pages Edge, Cache Components Edge, le préchargement PPR avancé et l'incrémentalité de toutes les étapes restent des écarts. Consulter la [matrice](compatibility.md) et les guides associés avant de migrer un projet complexe.
