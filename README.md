# Rustyx

Un framework React avec un serveur HTTP natif en **Rust**, des pages TypeScript et l'écosystème **npm**.

**Version actuelle : 0.1.0-alpha.1.** Rustyx fait fonctionner des applications Pages Router et App Router, avec de vrais React Server Components, le streaming App/API, la navigation client, les Server Actions, un cache de données persistant et des caches de pages avec ISR gérés par Rust pour les deux routeurs. Il inclut l'optimisation native des images, les routes parallèles/interceptées, les directives Cache Components et Fast Refresh. Il charge les `.env*` et un sous-ensemble de `next.config.*`, avec redirections et réécritures natives. La compatibilité intégrale avec Next.js reste en chantier ; la [matrice de compatibilité](docs/compatibility.md) décrit les comportements et limites vérifiés.

## Lancer la démo

Prérequis : Node.js 22+, npm et Rust stable. Dans ce dossier, un toolchain Rust local a déjà été installé dans `.toolchain/` ; les scripts le détectent sans modifier votre configuration shell.

```sh
npm install
npm run dev -- examples/app
```

Ouvrir **http://127.0.0.1:3000**. Le premier lancement compile le binaire Rust. Les modifications reconstruisent l'application et redémarrent le serveur ; Fast Refresh actualise le navigateur et conserve l'état des composants compatibles.

La page **/actions** présente les Server Actions : compteur avec cookie, formulaire `useActionState`, capture chiffrée et redirection après enregistrement. Les formulaires fonctionnent aussi avec JavaScript désactivé.

Après un build de production, **/static/welcome** montre le cache HTML/Flight App et sa régénération après dix secondes ; **/static/another-page** est générée à sa première visite.

L'API **/api/catalog** produit du JSON au build, puis Rust le sert et le régénère après 30 secondes. Observer `generatedAt` et l'en-tête `x-nextjs-cache` avec `curl -i http://127.0.0.1:3000/api/catalog`.

Le fichier **proxy.ts** de la démo redirige **/legacy-app** vers les actions et réécrit **/catalog** vers cette API, en ajoutant `x-rustyx-proxy: catalog`. Ses règles sont évaluées en Rust ; seuls ces deux chemins démarrent le worker du proxy.

La page **/stream** révèle deux composants serveur après 700 et 1 400 ms. Le layout reste interactif pendant leur chargement.

La page **/cache** conserve un message et sa date de lecture entre les requêtes. Son formulaire utilise `updateTag` pour afficher immédiatement le message enregistré. Le [guide du cache](docs/caching.md) détaille la persistance et les limites.

Dans `examples/basic`, **/isr/welcome** montre une page conservée sur disque puis régénérée après dix secondes. Le [guide ISR](docs/isr.md) décrit les fallbacks et la régénération à la demande.

Pour une compilation de production :

```sh
npm run build:native
npm run build -- examples/app
npm run start -- examples/app --port 3000 --workers 1
```

`examples/app` présente l'App Router ; `examples/basic` présente le Pages Router. Pour un autre projet compatible, remplacer ce chemin. `rustyx` est pour l'instant un package de ce workspace, pas un package publié sur npm. L'outil de build dépend encore de ce checkout. L'App Router requiert les versions exactement identiques de `react`, `react-dom` et `react-server-dom-webpack` indiquées dans `packages/rustyx/package.json` ; le build vérifie ce contrat de protocole.

Le CLI accepte aussi le nom court **`rx`**. Depuis ce dépôt après `npm install`, migrer les scripts et dépendances d'une application Next.js avec :

```sh
npx --no-install rx migrate /chemin/vers/mon-projet-next --dry-run
npx --no-install rx migrate /chemin/vers/mon-projet-next
```

La commande sauvegarde les fichiers modifiés, garde les scripts Next sous `*:next` et installe une dépendance locale vers ce checkout. Dans l'application migrée, `npm run dev`, `npm run build` et `npm start` utilisent Rustyx. Voir le [guide de migration](docs/import-next.md) pour `--no-install`, les workspaces, les scripts personnalisés et le retour arrière. `rx` est un alias fourni par **rustyx**, pas un autre paquet à installer.

Pour déployer un build, transférer le binaire natif adapté à la machine, `.rustyx/`, `public/`, `package.json`, les dépendances de production et les fichiers dont l'application a besoin. Avec Node installé sur la destination, `./rustyx start /chemin/application` utilise le runtime embarqué dans `.rustyx/` ; le code source du framework n'est pas nécessaire pour servir le build.

Avec `output: 'standalone'`, le build prépare plutôt un dossier autonome `.rustyx/standalone/`, comprenant le binaire, le runtime et les dépendances détectées. Copier ce dossier sur une machine compatible puis lancer `./start` évite un processus Node de supervision et une installation npm sur la cible. Les fichiers applicatifs chargés dynamiquement peuvent être ajoutés avec `outputFileTracingIncludes` ; voir le [déploiement autonome](docs/standalone.md).

## Ce qui fonctionne

- Pages React `.tsx`, `.jsx`, `.ts`, `.js`, dans `pages/` ou `src/pages/`.
- App Router dans `app/` ou `src/app/` : composants serveur asynchrones, frontières `'use client'`, layouts imbriqués, templates et groupes de routes.
- Protocole Flight React officiel, hydratation et navigation SPA avec état des layouts conservé, historique, rafraîchissement et annulation des navigations obsolètes.
- Streaming HTML/Flight App Router : fallbacks Suspense immédiats et hydratation du layout pendant le chargement des composants serveur.
- Route handlers `app/**/route.ts`, `NextRequest`, `NextResponse`, `headers()`, `cookies()`, redirections et `not-found`.
- [Route Handlers statiques](docs/route-handlers-static.md) : réponses JSON ou binaires servies par Rust, `generateStaticParams`, ISR et invalidation par tags ou chemins.
- [Métadonnées](docs/metadata.md) statiques ou asynchrones, balises sociales et PWA, `robots`, `sitemap` et `manifest` compilés, titres mis à jour pendant la navigation.
- [Frontières `error.js` et `global-error`](docs/app-errors.md) pour les erreurs serveur et client, avec récupération locale ou nouveau Flight ; délais de rendu bornés et remplacement d'un thread bloqué.
- Server Actions `'use server'` : appels client, formulaires avec ou sans JavaScript, `useActionState`, cookies et redirections. Les captures des actions inline sont chiffrées.
- Cache partagé entre workers pour `unstable_cache` et les appels `fetch` explicitement cachés ; expiration, renouvellement en arrière-plan et invalidation avec `revalidateTag`, `updateTag` et `revalidatePath`.
- [Gestionnaire incrémental `cacheHandler`](docs/incremental-cache.md) pour les données et les pages complètes, partage entre serveurs et `cacheMaxMemorySize`. Rust coordonne les productions locales et conserve les fichiers déjà reçus lorsque leur version ne change pas.
- [Génération statique App Router](docs/app-static.md), `generateStaticParams` imbriqués, cache HTML/Flight natif, ISR et invalidation par tags ou chemins.
- Routes `[id]`, `[...slug]`, `[[...slug]]`, avec priorité des chemins fixes.
- [Routes parallèles et interceptées](docs/app-routing.md), layouts racine distincts, métadonnées des slots et interceptions imbriquées.
- [Cache Components et pré-rendu partiel](docs/cache-components.md), enveloppes génériques réutilisées entre chemins inconnus, préchargement des parties statiques, réécritures et gestionnaires de cache personnalisés partagés entre instances.
- SSR avec `getServerSideProps`, génération statique et ISR avec `getStaticProps`/`getStaticPaths`, les trois modes de fallback et `res.revalidate`.
- [Navigation SPA Pages Router](docs/pages-navigation.md) : état de `_app` conservé, données SSR/ISR, liens, historique, événements, shallow routing et préchargement borné.
- [Pages d'erreur](docs/pages-errors.md) : `404` et `500`, optimisation statique selon les hooks App, `_error.getInitialProps`, erreurs de rendu React et priorité du `not-found` global dans les projets App/Pages.
- [Document personnalisé](docs/document.md) : `_document`, `Html`, `Head`, `Main`, `NextScript` et collecte des styles avec `Document.getInitialProps`, uniquement côté serveur.
- [Chargement avec getInitialProps](docs/initial-props.md) : hooks de page et `_app`, `next/app`, composition des props, navigation et coexistence avec GSP/GSSP.
- Hydratation React, hooks, `_app`, CSS global, CSS Modules et paquets npm.
- [PostCSS, Tailwind et Sass](docs/styles.md), avec transformations communes au serveur et au navigateur.
- [Polices locales et Google](docs/fonts.md) avec `next/font/*`, fichiers partagés et préchargement, sans accès à Google à l'exécution.
- [Draft Mode](docs/draft-mode.md) App/Pages pour la prévisualisation CMS et `connection()` pour demander un rendu dynamique.
- [Compilation npm](docs/npm.md) des imports Next directs/transitifs, `transpilePackages` et `serverExternalPackages`.
- [Imports dynamiques](docs/dynamic-imports.md) avec `rustyx/dynamic` ou `next/dynamic` : chunks JavaScript conditionnels, SSR et hydratation, exports nommés, fallbacks et composants `ssr: false` côté client.
- [Scripts tiers](docs/scripts.md) avec `rustyx/script` ou `next/script` : ordre avant hydratation, chargement après montage ou au repos, callbacks et déduplication ; worker expérimental Pages avec Partytown.
- API `pages/api/*` : requêtes JSON, cookies, statuts, redirections et réponses binaires.
- [Configuration](docs/configuration.md) `rustyx.config.*` ou `next.config.*`, fichiers `.env*`, en-têtes, redirections et réécritures internes ou proxy HTTP/HTTPS en Rust.
- [Déploiement sous un chemin et CDN](docs/configuration.md#sous-chemin-et-cdn) avec `basePath` et `assetPrefix`, pour les deux routeurs, les assets et les imports dynamiques.
- [Middleware et `proxy.ts`](docs/middleware.md), matchers natifs, `NextResponse.next/rewrite`, en-têtes de requête, cookies, réponses progressives et `waitUntil` borné.
- [Runtime Edge](docs/edge-runtime.md) explicite pour middleware, Route Handlers et pages App dynamiques, avec APIs Web et graphe applicatif compilé dans une VM V8. Les modules Node utilisent leur runtime distinct.
- Réponses API progressives : Web `ReadableStream`, `res.write`/`flushHeaders`, compression gzip progressive et débit limité par la consommation du client.
- Adaptateurs `rustyx/link`, `head`, `router`, `image`, `dynamic`, `script`, `navigation`, `headers`, `server`, `cache`, également accessibles via les imports `next/*` correspondants.
- Serveur Rust asynchrone, assets à empreinte de contenu et workers persistants démarrés à la demande. Le build prépare les variantes gzip utiles du HTML statique et des assets pour éviter de les recompresser à chaque requête.

Les démos utilisent réellement `clsx` dans le navigateur et `node:crypto` côté serveur. Les tests ouvrent Chromium pour vérifier l'hydratation et les parcours entre pages. Ils vérifient aussi les requêtes concurrentes, l'absence de code serveur dans le navigateur et le déplacement d'un build sans ses sources.

## Architecture et mémoire

Pour utiliser ton propre projet Next.js, suivre le [guide d’import](docs/import-next.md) : `rustyx check`, puis `build` et `start` sur son dossier. L’[export statique](docs/static-export.md) permet aussi de publier une application compatible sur un simple serveur de fichiers.

Rust prend en charge HTTP, le routage, les fichiers, les redirections, le proxy externe et la distribution du travail. Les pages statiques sont servies sans worker JavaScript. Pour le SSR et les API npm, des processus Node exécutent le code applicatif ; ils sont réutilisés entre les requêtes. L'App Router ajoute un thread Node persistant avec la condition `react-server`, isolé du React utilisé pour produire le HTML. Le compilateur sépare les graphes serveur, SSR des composants client et navigateur. Ce runtime JavaScript reste nécessaire à la compatibilité npm.

Le middleware et les API chargent seulement leur runtime HTTP. React et ReactDOM sont chargés lorsque le worker doit rendre une page, ou si l'application les importe elle-même. Un même worker peut passer d'une API au rendu Pages ou App sans perdre les modules et leur état déjà chargés.

La précompression du build lit les fichiers en flux, avec deux compressions simultanées au maximum, et conserve seulement les variantes plus petites. Les fichiers modifiables de `public/` gardent leur compression à la demande.

Un middleware correspondant à la requête utilise un worker Node séparé, avec cinq places de travail et arrêt après 30 secondes d'inactivité. Jusqu'à 64 requêtes peuvent attendre leur admission avant lecture du corps, pendant au plus 30 secondes, pour absorber les rafales de modules sans contourner le proxy. Ses matchers sont évalués en Rust ; un chemin exclu ne démarre pas ce worker. Le corps transmis à cette étape reste limité à 8 Mio.

Le cache de données utilise SQLite dans `.rustyx-cache/data.sqlite3`, à l'extérieur du build : il survit aux redémarrages et aux reconstructions. Ses valeurs restent sur disque, avec des budgets de stockage, de lecture et de concurrence. Le dossier du projet doit permettre l'écriture dans `.rustyx-cache` pour utiliser cette persistance.

Les rendus SSR et les API admettent au plus `4 × workers` requêtes avec corps chargé. Jusqu'à `min(64 × workers, 1024)` requêtes supplémentaires attendent avant lecture du corps, pendant au plus 30 secondes. Une pointe de huit requêtes ne provoque donc plus un refus immédiat avec un seul worker. Une file d'attente pleine reçoit `503` avec `Retry-After: 1` ; une attente expirée reçoit `504`. L'ISR Pages et App conserve un worker de maintenance séparé et cinq places de génération. Les requêtes transmises à Node sont limitées à 8 Mio ; les Server Actions utilisent 1 Mio par défaut, configurable jusqu'à 8 Mio. Le HTML/Flight et les réponses tamponnées restent limités à 16 Mio ; une API peut transmettre davantage en streaming. Le transport Rust–Node utilise des blocs binaires de 64 Kio, avec au plus quatre blocs en attente côté Rust. Un flux occupe son worker jusqu'à sa consommation, son annulation ou son délai d'inactivité. Le proxy externe utilise ses propres 16 places et transmet les corps en flux. Ces limites ne constituent pas un plafond sur les allocations internes des paquets npm. Augmenter `--workers` augmente aussi la mémoire utilisée.

Les détails et les limites du transport figurent dans [l'architecture](docs/architecture.md).

Les extensions restent chargées à la demande : aucun gestionnaire de cache applicatif ni runtime Edge n'est chargé pour une application qui ne les configure pas. `cacheMaxMemorySize` règle le budget des caches internes SQLite ; ce n'est pas une limite sur la mémoire totale de Node ou des modules npm.

## Vérifier et mesurer

```sh
npm run build:native
npm test
npm run typecheck --workspace examples/basic
npm run typecheck --workspace examples/app
npx playwright install chromium
npm run test:browser
npm run bench
npm run bench:stream
npm run bench:cache
npm run bench:isr
npm run bench:app-static
npm run bench:config
npm run bench:script
npm run bench:route-static
npm run bench:middleware
npm run bench:worker-memory
npm run bench:node-heap
```

Le benchmark mesure le débit, les latences et la RAM RSS du serveur **avec ses workers Node et leurs threads RSC**. Les résultats locaux [Pages Router](docs/benchmark-local.json) et [App Router](docs/benchmark-app-local.json) précisent la machine et les conditions. Le [suivi des performances](docs/performance.md) conserve les snapshots avant et après le streaming et mesure séparément l'arrivée des premiers octets. Un [comparatif avec Next.js](docs/next-comparison.md) utilise désormais le même projet sous les deux frameworks. Ces microbenchmarks locaux ne démontrent aucune accélération universelle.

`BENCH_CONCURRENCY=4 BENCH_SECONDS=3 npm run bench` permet de reproduire la charge par défaut. Tester une concurrence supérieure sert aussi à observer les réponses `503` lorsque la file est saturée.

`RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next npm run bench:next` compare Next.js et Rustyx sur la même fixture. `BENCH_GZIP=1` ajoute les parcours compressés ; `BENCH_BASELINE_BINARY=/chemin/vers/rustyx-avant` ajoute un ancien binaire Rustyx avec le même runtime JavaScript pour isoler les changements natifs.

`BENCH_PROJECT=examples/app npm run bench` mesure le HTML App, une API et une réponse Flight. Les parcours s'exécutent dans l'ordre sur la même instance : la mémoire des modules chargés reste comptée dans les mesures suivantes. `BENCH_ENDPOINTS='[{"path":"/","label":"Mon parcours"}]'` permet de choisir les routes.

`npm run bench:cache` compare une origine locale retardée volontairement de 10 ms à des lectures déjà cachées, en comptant les appels réellement évités. Ce scénario mesure le travail économisé ; il ne constitue pas une comparaison avec Next.js.

`npm run bench:isr` mesure les pages HTML/JSON servies par Rust, le coût du premier calcul et la mémoire libérée quand le worker de régénération s'arrête après 30 secondes d'inactivité.

`npm run bench:app-static` effectue les mêmes mesures pour les paires HTML/Flight App Router, avec les processus Node et threads RSC réellement démarrés.

`npm run bench:config` mesure les redirections, pages App réécrites déjà cachées et proxy externe, avec comptage des appels à l'origine et des processus réellement démarrés.

`npm run bench:script` mesure les pages HTML et Flight cachées contenant `Script`, en vérifiant qu'elles restent servies par Rust sans worker Node ni appel aux sources tierces. L'exécution des scripts dans le navigateur est vérifiée séparément par les tests Chromium.

`npm run bench:route-static` mesure les réponses de handlers cachées, leur premier calcul et l'arrêt du worker de maintenance, sans rendu React.

`npm run bench:middleware` mesure le coût du middleware sur les redirections, les réponses directes, les pages cachées et les API, ainsi que les chemins exclus qui ne démarrent pas son worker.

`npm run bench:worker-memory` mesure trois workers distincts — middleware, API App et API Pages — après leur première requête puis 20 000 appels, sur trois répétitions. Il vérifie aussi le chargement différé de React et le passage au rendu de pages sans redémarrer le worker.

`npm run bench:node-heap` compare les réglages Node sur de grosses allocations JSON et React. Rustyx garde les réglages adaptatifs par défaut ; les [mesures de mémoire](docs/performance.md) détaillent les gains et les compromis observés.

## Suite du projet

L'objectif reste la compatibilité complète avec Next.js, avec des performances mesurées. Les prochaines étapes comprennent les configurations non encore prises en charge, le SSR progressif Pages Router, l'incrémentalité des étapes restant recalculées et les combinaisons de routage encore non couvertes. Chaque fonctionnalité doit être validée par des applications et des tests de compatibilité avant d'être annoncée comme prise en charge.

Les derniers ajouts couvrent l’[i18n Pages](docs/i18n.md), les [loaders et contextes de compilation persistants](docs/compiler.md), les Server Actions Edge et les échantillons de validation PPR. La compatibilité universelle avec Next n’est pas certifiée ; les limites sont détaillées dans ces guides.
