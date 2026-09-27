# Configuration, environnement et réécritures

PRNext accepte un fichier `prnext.config.js`, `.mjs`, `.cjs` ou `.ts` à la racine du projet. Les mêmes extensions de `next.config.*` sont acceptées pour migrer une application. Garder un seul fichier : les configurations concurrentes et les options non implémentées provoquent une erreur explicite.

```ts
// prnext.config.ts
import type { PRNextConfig } from 'prnext';

export default {
  poweredByHeader: false,
  async redirects() {
    return [{ source: '/ancien/:slug', destination: '/articles/:slug', permanent: true }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] }];
  },
  async rewrites() {
    return {
      beforeFiles: [{ source: '/catalogue/:slug', destination: '/produits/:slug?canal=catalogue' }],
      afterFiles: [],
      fallback: [{ source: '/legacy/:path*', destination: 'https://legacy.example.com/:path*' }],
    };
  },
} satisfies PRNextConfig;
```

Le fichier peut exporter un objet ou une fonction asynchrone `(phase, { defaultConfig })`. Les constantes `PHASE_DEVELOPMENT_SERVER` et `PHASE_PRODUCTION_BUILD` sont disponibles dans `prnext/constants` et son alias `next/constants`. La configuration et ses imports locaux sont réévalués à chaque build. En production, le serveur utilise les règles enregistrées dans le build : il ne réexécute pas la configuration avec `PHASE_PRODUCTION_SERVER`.

## Options disponibles

| Option | Comportement |
| --- | --- |
| `i18n` | Langues, domaines et routage Pages ; [détails](i18n.md) |
| `webpack`, `turbopack.rules` | Hooks traduits et loaders générant du JavaScript ; [contrats](compiler.md) |
| `env` | Valeurs textuelles injectées au build dans les graphes serveur et navigateur ; elles sont publiques |
| `headers` | Fonction retournant les règles d'en-têtes |
| `redirects` | Fonction retournant les redirections 307/308 ou un `statusCode` explicite parmi 301, 302, 303, 307, 308 |
| `rewrites` | Fonction retournant un tableau, traité en `afterFiles`, ou l'objet des trois phases |
| `generateBuildId` | Fonction asynchrone ou synchrone ; `null` choisit un UUID. Sinon, 1 à 128 lettres, chiffres, `_` ou `-`. Ignorée en développement |
| `compress` | `true` par défaut ; `false` désactive les variantes gzip du build et la compression HTTP de PRNext |
| `poweredByHeader` | `true` par défaut ; en-tête `X-Powered-By: PRNext` |
| `productionBrowserSourceMaps` | `false` par défaut ; active les fichiers source maps navigateur du build de production |
| `trailingSlash` | `false` par défaut ; redirections 308 vers les URL sans slash final, ou vers les URL avec slash si `true` ; liens et routeurs suivent la même politique |
| `skipTrailingSlashRedirect` | Désactive ces redirections et la normalisation automatique des liens/URL de navigation |
| `skipMiddlewareUrlNormalize`, `skipProxyUrlNormalize` | Expose au middleware les URL de données originales, `_rsc` et les en-têtes Flight ; le second nom, utilisé par Next 16, est prioritaire |
| `basePath` | Sous-chemin de déploiement, par exemple `/docs` ; figé au build pour les deux routeurs |
| `assetPrefix` | Préfixe des assets compilés, local ou URL HTTP/HTTPS de CDN ; ne déplace pas les données ni les fichiers publics |
| `experimental.nextScriptWorkers` | `false` par défaut ; prépare Partytown fourni par le projet pour la stratégie `worker` de [Script dans Pages](scripts.md) |
| `experimental.serverActions` | Origines supplémentaires autorisées et budget du corps des actions ; [détails](#options-des-server-actions) |
| `sassOptions` | Options du compilateur Sass, chemins et `additionalData` ; voir [styles](styles.md) |
| `transpilePackages` | Paquets npm à compiler, notamment TypeScript/JSX/CSS ; voir [dépendances npm](npm.md) |
| `serverExternalPackages` | Paquets serveur conservant leur résolution Node ; voir [contrats et limites](npm.md) |
| `images` | Tailles, qualités, formats, origines autorisées, loaders et cache de l'optimiseur natif ; [détails](images.md) |
| `pageExtensions` | Suffixes des pages et conventions, y compris `page.tsx` ; [détails](app-routing.md#source-suffix-configuration) |
| `reactStrictMode` | `true` ou `false` ; actif par défaut dans App, inactif par défaut dans Pages ; [développement](dev.md) |
| `onDemandEntries` | Accepte et valide `maxInactiveAge` et `pagesBufferLength` pour les wrappers Next tels que Contentlayer ; PRNext compile toutes les routes et ne reproduit pas la file d'éviction des pages de Next |
| `distDir` | Dossier de build relatif au projet ; `.prnext` par défaut, partagé par `build`, `start`, `routes` et `dev` |
| `output: 'standalone'` | Paquet déployable avec binaire Rust, dépendances tracées, assets et public ; [déploiement autonome](standalone.md) |
| `output: 'export'` | Dossier `out/` publiable sur un serveur de fichiers ; [contrat et restrictions](static-export.md) |
| `turbopack.resolveAlias`, `turbopack.resolveExtensions` | Alias de modules, sous-chemins, condition `browser` et ordre des extensions dans les graphes Pages/App/middleware/Edge ; transformés en résolution du compilateur PRNext |
| `turbopack.root` | Chemin absolu servant de base aux alias relatifs et aux motifs/conditions de loaders Turbopack ; ne change pas le dossier des routes ni la portée du watcher PRNext |
| `outputFileTracingRoot`, `outputFileTracingIncludes`, `outputFileTracingExcludes` | Racine monorepo et ajustements des fichiers du paquet autonome ; [traces](standalone.md#traces-et-monorepos) |
| `cacheHandlers` | Modules personnalisés pour les caches `default`, `remote` et les noms déclarés ; [contrats](cache-components.md) |
| `cacheHandler` | Classe de stockage du cache incrémental historique ; [contrats](incremental-cache.md) |
| `cacheMaxMemorySize` | Budget mémoire en octets des caches SQLite internes, également transmis au gestionnaire ; zéro désactive leur rétention, sans supprimer le stockage persistant |
| `cacheComponents`, `cacheLife` | Directives de cache de composants et profils de durée ; [détails](cache-components.md) |

L'[i18n Pages](i18n.md) et les [hooks/loaders décrits ici](compiler.md) sont pris en charge. Les autres options Next non listées sont refusées. Les alias Turbopack acceptent une chaîne ou `{ browser: 'module' }` ; les jokers, remplacements des modules du framework, les autres options Turbopack restent refusés ; les règles de loaders JavaScript acceptent les conditions de cible, mode, chemin et contenu, les opérateurs booléens et les tableaux de variantes décrits dans le [guide de compilation](compiler.md). Les fichiers [middleware et proxy](middleware.md) permettent une logique applicative avant le routage ; les réécritures externes ci-dessous sont des règles déclaratives exécutées par Rust.

L'identifiant public du build sert notamment aux URL JSON Pages. Le cache interne des pages utilise un identifiant neuf à chaque compilation réussie, même si `generateBuildId` renvoie toujours la même valeur. Le cache de données reste indépendant et survit aux builds.

Les propriétés optionnelles définies à `undefined`, notamment `basePath` et `images.unoptimized`, conservent leurs valeurs par défaut. C'est utile pour les configurations conditionnées par des variables d'environnement. `null` ne remplace pas une valeur par défaut.

`onDemandEntries.maxInactiveAge` (millisecondes) et `pagesBufferLength` doivent être des entiers sûrs positifs ou nuls ; les champs absents utilisent respectivement 60 000 et 5. Ces valeurs sont acceptées pour la compatibilité des configurations, mais ne modifient pas les limites mémoire du compilateur PRNext ni le cache du serveur de production. `prn check` signale cette différence avec la [rétention des pages de développement de Next](https://nextjs.org/docs/app/api-reference/config/next-config-js/onDemandEntries).

## Sous-chemin et CDN

```js
export default {
  basePath: '/docs',
  assetPrefix: 'https://assets.example.com/resources',
};
```

Dans cet exemple, `/articles` est accessible à `/docs/articles`. `Link` et les méthodes des routeurs ajoutent `/docs` aux chemins internes ; leur fournir `/articles`, sans préfixe déjà ajouté. `Link href="/"` pointe sur `/docs`. Les liens HTML ordinaires, les appels applicatifs à `fetch` et les références aux fichiers `public/` doivent utiliser eux-mêmes leur URL publique, par exemple `/docs/logo.svg`.

Les hooks exposent les chemins logiques : `router.pathname`, `router.asPath` et `usePathname()` ne contiennent pas `/docs`. Le Pages Router expose aussi `router.basePath`. Les requêtes Pages (`req.url`, `resolvedUrl`) et les Route Handlers reçoivent des URL sans ce préfixe. Dans le middleware, `request.url` reste public ; `request.nextUrl.pathname` est logique, `nextUrl.basePath` vaut `/docs`, et `nextUrl.href` ou `clone()` conservent le préfixe public.

Les sources des en-têtes, redirections, réécritures et matchers middleware reçoivent automatiquement le préfixe. Les destinations internes des règles le reçoivent aussi. `basePath:false` sur une règle d'en-tête ou de redirection permet une source hors du sous-chemin ; pour une réécriture, cette option exige une destination externe, comme Next.js. Les redirections de page `getServerSideProps` et `redirect()` ajoutent le préfixe aux destinations internes ; `redirect.basePath:false` désactive cet ajout pour GSSP. Les destinations déjà préfixées reçoivent un second préfixe, comme les liens.

Les redirections de Server Actions suivent deux contrats distincts : le routeur client ajoute `basePath`, tandis qu'une soumission sans JavaScript utilise directement la destination dans l'en-tête HTTP `Location`. Une action destinée à un formulaire sans JavaScript doit donc fournir une destination publique. Cette distinction reproduit le comportement vérifié avec Next.js 16.3.5.

Pour l'invalidation, `revalidatePath('/articles')` utilise le chemin interne de l'App Router ; lui passer `/docs/articles` ne cible pas cette route. L'API Pages `res.revalidate` accepte les deux formes, avec ou sans `basePath`.

`assetPrefix` déplace JavaScript, CSS, images et polices importées, chunks dynamiques, références Flight et manifeste de navigation Pages. Copier le contenu de `.prnext/assets/` vers `https://assets.example.com/resources/_prnext/assets/` ; le CDN doit permettre les requêtes CORS de l'application pour les modules et le manifeste. Les requêtes d'assets vers une autre origine omettent les credentials. Les données Pages, Flight et Server Actions restent sur l'origine de l'application sous `/docs`.

Sans `assetPrefix`, les assets sont servis à `/docs/_prnext/assets/`. Un préfixe local tel que `/resources` crée aussi cet alias d'assets sur le serveur Rust ; le chemin correspondant d'un préfixe CDN est également servi à l'origine. L'URL `/docs/_prnext/assets/` reste disponible. La valeur explicite `assetPrefix:'/'` place les assets à la racine ; la valeur vide utilise `basePath`. Ces options sont figées au build et nécessitent une recompilation lorsqu'elles changent. Le cache natif et les modules serveur utilisent leurs chemins internes, sans duplication par préfixe.

`basePath` doit être vide ou un chemin commençant par `/`, sans slash final ni segment vide. Les préfixes ambigus, segments `.`/`..`, antislashs, espaces, query, fragments et credentials sont refusés. Les caractères non ASCII d'un chemin doivent être encodés dans l'URL. Ces contraintes peuvent refuser certaines configurations acceptées par Next.js. Voir les références officielles [basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath) et [assetPrefix](https://nextjs.org/docs/app/api-reference/config/next-config-js/assetPrefix).

## Fichiers d'environnement

Les fichiers se trouvent à la racine du projet, y compris avec `src/app` ou `src/pages`. Pour chaque variable, la première valeur trouvée gagne :

1. Environnement du processus.
2. `.env.{mode}.local`.
3. `.env.local`, sauf en mode test.
4. `.env.{mode}`.
5. `.env`.

Le mode des fichiers est `development` pour `dev`, `production` pour le build et le serveur de production, ou `test` si le processus appelant porte `NODE_ENV=test`. Cette sélection reste distincte du `NODE_ENV` d'exécution : React et les modules npm utilisent `development` ou `production` selon le build, même lorsque les fichiers `.env.test` sont sélectionnés. Un lancement `dev` depuis un environnement de production utilise donc bien les modules en développement. Les références `$VARIABLE` et `${VARIABLE}` sont développées ; `\$` conserve un dollar littéral. Les fichiers sont chargés avant la configuration et avant les imports applicatifs des workers. En développement, leurs changements reconstruisent le projet et redémarrent les workers.

Les accès directs `process.env.NEXT_PUBLIC_NOM` et les variables déclarées dans `config.env` sont remplacés par leurs valeurs au build, côté serveur comme navigateur. Un changement sur la machine de déploiement ne les modifie pas sans recompilation. Les accès calculés et la déstructuration ne constituent pas un mécanisme d'injection navigateur. Les variables `config.env` sont publiques même sans préfixe `NEXT_PUBLIC_` ; les noms réservés sont refusés.

Les autres variables restent accessibles au code serveur à l'exécution. Elles ne sont pas copiées automatiquement dans les assets ni dans le manifeste. Une page statique peut toutefois publier une valeur qu'elle affiche, et les props sérialisées sont publiques. Pour déployer, fournir les variables privées via l'environnement du serveur ou les fichiers `.env*` du projet cible ; ces fichiers ne sont pas embarqués dans `.prnext`.

Les builds programmatiques restaurent l'environnement de leur appelant après réussite ou échec. Ils sont sérialisés dans un même processus afin que deux projets ne mélangent pas leurs variables.

## Routage natif

Les règles sont compilées au build et exécutées par Rust. Elles ne nécessitent pas de worker Node ; un middleware applicatif correspondant au chemin ajoute son propre travail. L'ordre est : en-têtes, redirections, middleware éventuel, toutes les règles `beforeFiles`, fichiers publics/assets et routes fixes, règles `afterFiles` avec vérification de leur destination, routes dynamiques, puis règles `fallback`. Une route reconnue dont le handler renvoie 404 ne relance pas les règles fallback.

Les sources acceptent `:param`, `:param?`, `:param*`, `:param+`, des motifs comme `:id(\\d+)` et des assertions usuelles. `has` et `missing` peuvent tester un en-tête, un cookie, un paramètre de recherche ou l'hôte. Les captures nommées d'une condition `has` peuvent alimenter la destination ou un en-tête. Les valeurs query répétées restent des tableaux ; les valeurs explicites de destination remplacent celles de même nom.

Pour une réécriture, les captures sont ajoutées automatiquement à la query seulement si aucune n'est utilisée dans le chemin, l'hôte ou le fragment de destination. L'utilisation d'une seule capture à ces endroits désactive aussi l'ajout automatique des autres. Une substitution uniquement dans la query ne désactive pas cet ajout. Les redirections conservent la query d'origine mais n'ajoutent pas automatiquement les captures de source.

Pour les en-têtes ordinaires, la dernière règle correspondante gagne ; plusieurs `Set-Cookie` sont conservés. Les en-têtes explicites d'un handler ou d'une origine externe prennent ensuite la priorité. Les en-têtes de transport et les politiques de cache nécessaires au framework restent contrôlés par PRNext.

Une réécriture conserve l'URL visible. Les contrats suivants sont vérifiés séparément à l'exécution et dans Chromium :

| API | Valeur après réécriture |
| --- | --- |
| Pages `req.url`, route handler `request.url`/`nextUrl` | URL de la requête d'origine |
| Pages `query`, `req.query` | Paramètres de recherche fusionnés avec la destination et paramètres de route |
| Pages `resolvedUrl` | Chemin de destination et recherche de l'URL d'origine |
| Pages `router.pathname`, `router.asPath` | Motif de route cible et URL visible, respectivement |
| App `usePathname`, `useSearchParams` | Chemin et recherche visibles dans le navigateur |
| App props `params`, `searchParams` de la page | Paramètres de la route cible et recherche fusionnée de destination, y compris pour une page client |

Le mode App `force-static` conserve son contrat particulier : il vide les informations de recherche propres à la requête, y compris après réécriture.

Une page précompilée reste partagée selon son chemin cible. Rust ajoute les seules métadonnées nécessaires au navigateur, sans réécrire l'entrée du cache. Pour ces réponses réécrites HTML/Flight/JSON, la réponse HTTP est privée sans cache et ses validateurs sont désactivés : les métadonnées peuvent dépendre d'un cookie ou d'un en-tête. Le HTML reçoit un petit bloc JSON non exécutable et échappé ; il contourne les variantes gzip précompilées et les réponses partielles. La compression à la demande reste possible. Les lectures canoniques conservent leurs variantes précompressées et leur cache HTTP habituel.

## Proxy HTTP et HTTPS

Une destination externe transmet méthode, query, en-têtes et corps vers l'origine en streaming. Le `Host` correspond à la destination ; `X-Forwarded-Host` reprend le `Host` entrant. Les en-têtes hop-by-hop et ceux désignés par `Connection` sont retirés dans les deux sens. Les statuts, les cookies multiples et HEAD sont conservés. Les redirections de l'origine sont renvoyées au client, et les requêtes ne sont pas réessayées automatiquement.

Le client HTTP/TLS est créé à la première réécriture externe. Au plus 16 flux sont actifs ; le suivant reçoit 503. La capacité est détenue jusqu'à consommation, annulation ou expiration du corps. Le proxy ne rassemble pas la réponse entière en mémoire : les blocs sortants font au plus 64 Kio. Connexion : 10 secondes ; envoi de la requête et premiers en-têtes : 30 secondes ; corps sans progression : 30 secondes. Les connexions réutilisables sont limitées à 64 origines, deux connexions inactives par origine et 30 secondes d'inactivité ; les autres origines restent accessibles sans connexion persistante.

Le transport vers l'origine utilise HTTP/1.1 et ne prend pas en charge les upgrades WebSocket. Les protocoles autres que HTTP/HTTPS, les credentials intégrés à la destination et les proxies configurés par variables d'environnement ne sont pas utilisés.

## Bornes et différences restantes

Le manifeste des règles est limité à 2 Mio, avec au plus 1 000 règles, 16 conditions par liste et 64 en-têtes par règle. Une source admet 64 captures ; l'ensemble des paramètres nommés de la source et de ses conditions `has` est également limité à 64. Chaque regex de condition admet 64 captures. Les chaînes ordinaires et regex de source sont limitées à 4 096 octets, les valeurs de condition à 1 024 et les noms de conditions/en-têtes à 256. Une destination admet 128 entrées query. Le moteur natif limite le chemin, la recherche, chaque valeur de condition et l'URL résultante à 16 Kio. Chaque regex dispose de 10 000 retours arrière et de limites de compilation de 1 Mio pour son moteur délégué. Ces contraintes peuvent refuser des configurations que Next accepte.

Toute la grammaire RegExp JavaScript n'est pas garantie. Les classes `\d`, `\w`, les frontières de mots et les espaces suivent les règles JavaScript usuelles, mais les échappements non pris en charge, les surrogates UTF-16 et les classes de caractères Unicode insensibles à la casse sont refusés explicitement. Les littéraux Unicode et les conditions Unicode sensibles à la casse restent possibles. Le build détecte ces incompatibilités connues ; une construction restante non prise en charge par le moteur natif échoue au démarrage.

Le moteur Rust travaille sur des caractères Unicode, tandis que les regex JavaScript sans drapeau `u` comptent des unités UTF-16. Une condition qui doit découper ou compter un caractère hors du plan multilingue de base, par exemple un emoji avec `^.$` ou `.{2}`, renvoie donc 400. Les comparaisons littérales, la capture entière simple comme `.+` et les valeurs sans condition regex restent utilisables avec ces caractères.

Les tests comparent notamment l'ordre des règles, les paramètres encodés, les contextes serveur/navigateur, l'hydratation, les fallbacks Pages, les Server Actions avec ou sans JavaScript, les cookies et le streaming. Les contrats de référence viennent des documents officiels [redirects](https://nextjs.org/docs/app/api-reference/config/next-config-js/redirects), [headers](https://nextjs.org/docs/app/api-reference/config/next-config-js/headers), [rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites) et [environnement](https://nextjs.org/docs/app/guides/environment-variables), avec des vérifications locales contre Next.js 16.3.5. Cela ne constitue pas une garantie de compatibilité complète avec cette version.


## Slash final et URL du middleware

`trailingSlash: true` transforme `/page?lang=fr` en `/page/?lang=fr` avec une redirection HTTP 308 qui conserve la méthode et le corps. La politique est appliquée après les en-têtes configurés, avant les redirections utilisateur et le middleware, au chemin public sous `basePath`. Les pages Pages et App, les chemins inconnus et les fichiers publics sans extension suivent cette règle. Les fichiers à extension restent sans slash et les chemins `/.well-known/` sont exemptés de l'ajout. Les transports de données JSON gardent leur suffixe `.json` ; l'optimiseur d'images et le flux de développement restent des endpoints de protocole. Les clés des caches de pages et les motifs de routes restent canoniques sans slash, évitant deux copies du même rendu. Voir la [référence officielle `trailingSlash`](https://nextjs.org/docs/app/api-reference/config/next-config-js/trailingSlash).

`skipTrailingSlashRedirect: true` laisse les deux formes accessibles et conserve la forme explicitement donnée à `Link`, `push`, `replace` et `prefetch`. Le middleware peut alors décider de sa propre politique. Cela ne désactive pas les validations de chemin ou les limites d'URL.

Par défaut, le middleware voit `/article` pour une requête de données `/_prnext/data/<build>/article.json` ou son alias `/_next/data/...`. Avec `skipProxyUrlNormalize: true` (alias historique `skipMiddlewareUrlNormalize`), il voit le chemin de données original, garde `_rsc` et peut inspecter les en-têtes Flight. La sélection des matchers continue à utiliser la route logique, puis le routage natif produit la réponse de données appropriée. `NextURL.clone()` conserve la préférence de slash du chemin entrant lors d'un remplacement de `pathname`. Voir les [options avancées documentées par Next](https://nextjs.org/docs/15/app/api-reference/file-conventions/middleware#advanced-middleware-flags).


## Dossier de build

`distDir: 'build/server'` publie les artefacts dans ce sous-dossier au lieu de `.prnext`. Le pointeur `.prnext-output.json` à la racine est mis à jour atomiquement après la compilation ; `prnext start`, `prnext routes` et le binaire natif direct le lisent sans évaluer la configuration ni démarrer Node pour découvrir le build. Conserver ce petit fichier avec les artefacts lors du déploiement. Sans pointeur, les anciens builds dans `.prnext` restent reconnus.

Le chemin ne peut ni sortir du projet, ni traverser un lien symbolique, ni remplacer `public`, `node_modules` ou les répertoires source réservés. Un dossier existant sans manifeste PRNext n'est jamais remplacé. Un build échoué laisse le pointeur et le build actif intacts. Le mode développement ignore le dossier de sortie configuré pour éviter les boucles de recompilation. Les anciennes sorties ne sont pas supprimées lorsqu'on change `distDir`. Voir la [référence officielle `distDir`](https://nextjs.org/docs/app/api-reference/config/next-config-js/distDir).

## Options des Server Actions

```js
export default {
  experimental: {
    serverActions: {
      allowedOrigins: ['portal.example.com', '*.portal.example.com'],
      bodySizeLimit: '2mb',
    },
  },
}
```

`allowedOrigins` accepte des hôtes supplémentaires, éventuellement avec un port. `*` remplace un label, `**` placé au début en remplace un ou plusieurs. Les domaines nus et les sous-domaines sont distincts ; les protocoles et chemins ne figurent pas dans cette liste. Rust vérifie l'origine avant les transformations d'en-têtes du middleware, puis conserve ce verdict. Les origines non autorisées sont refusées avant l'exécution d'une mutation. [Référence Next](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions).

`bodySizeLimit` accepte un nombre d'octets ou une chaîne telle que `'512kb'` ou `'2mb'`. Le défaut reste 1 Mio ; PRNext accepte de 1 octet à 8 Mio, plafond actuel de son transport de requêtes. La limite porte sur le corps HTTP complet, y compris l'enveloppe multipart, et s'applique dans Rust puis dans le décodeur React. Une requête trop grande reçoit 413 avant l'action. `experimental.serverActions: true` conserve les valeurs par défaut. Les formulaires et les appels client sont couverts par `tests/server-actions-options.test.mjs`.
