# Middleware et proxy

Rustyx accepte un fichier `proxy.ts` ou l'ancienne convention `middleware.ts`, à la racine ou dans `src`. Les extensions `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs` et `.cjs` sont reconnues. Un seul fichier peut être présent. La fonction doit être un export `proxy`, `middleware` selon la convention, ou l'export par défaut.

```ts
import { NextResponse, type NextRequest } from 'next/server';

export const config = { matcher: ['/catalog/:path*'] };

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-catalog-version', 'one');
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-catalog', 'yes');
  return response;
}
```

Les imports `rustyx/server` offrent les mêmes adaptateurs. Le code s'exécute dans un worker dédié et ne partage pas ses variables de module avec les pages ou les handlers. Le runtime Node reste celui par défaut. Un middleware déclarant `runtime: 'edge'` utilise désormais un contexte V8 Web fourni par `@edge-runtime/vm`, avec compilation ESM et refus des imports Node ; voir [le contrat Edge](edge-runtime.md). La convention `proxy` refuse un runtime explicite, conformément à son contrat Next.

## Sélection et ordre

Les matchers sont compilés dans le manifeste et évalués par Rust. Ils acceptent une chaîne, une liste de chaînes ou une liste d'objets `{ source, has, missing, locale: false }`. Les paramètres nommés, répétitions et expressions régulières prises en charge suivent les [limites des règles natives](configuration.md). Les conditions peuvent examiner un en-tête, un cookie, une query ou l'hôte. Les entrées d'une liste sont alternatives ; les conditions d'une entrée se combinent. Sans matcher, tous les chemins sont candidats.

La configuration doit être statiquement analysable. Rustyx refuse les expressions calculées, les options inconnues et les fichiers concurrents au lieu d'importer l'application pendant le build. Les variables d'environnement publiques sont injectées à la compilation ; les privées sont disponibles au démarrage du worker, comme dans les autres modules serveur.

L'ordre est : en-têtes configurés, redirections configurées, middleware, réécritures `beforeFiles`, fichiers et routes fixes, `afterFiles`, routes dynamiques, puis `fallback`. Une redirection configurée peut donc terminer la requête avant le middleware. Une réécriture interne du middleware poursuit les étapes suivantes sur sa destination. Les assets, fichiers publics et requêtes de Server Actions passent aussi par les matchers.

Les URL de données Pages sont normalisées vers leur chemin de page pour cette sélection et pour le `NextRequest` du middleware. Par défaut, ce Request masque les cinq en-têtes Flight internes et le paramètre `_rsc`. Rust conserve les informations nécessaires à la navigation en aval. Les options `skipProxyUrlNormalize`, `skipMiddlewareUrlNormalize` et `skipTrailingSlashRedirect` sont prises en charge, ainsi que les [matchers localisés](i18n.md).

Avec [`basePath`](configuration.md#sous-chemin-et-cdn), les matchers reçoivent automatiquement le préfixe public. `request.url` et `request.nextUrl.href` le conservent, tandis que `nextUrl.pathname` présente le chemin interne et `nextUrl.basePath` le préfixe. Pour changer de route en le conservant, cloner `request.nextUrl`, modifier son `pathname`, puis passer ce clone à `NextResponse.rewrite` ou `redirect`. Un `new URL('/destination', request.url)` ordinaire désigne directement la racine publique et n'ajoute pas automatiquement `basePath`.

## Continuation, réécriture et réponse

`NextResponse.next()` poursuit le routage. Retourner `undefined` ou `null` fait de même. `NextResponse.rewrite(new URL('/destination', request.url))` sélectionne une autre destination en conservant l'URL visible. Une destination HTTP/HTTPS externe utilise le proxy natif progressif. `NextResponse.redirect` conserve les statuts de redirection usuels ; les redirections locales de données Pages utilisent `x-nextjs-redirect` pour le client.

Une `Response` Web ordinaire termine la requête, y compris un corps binaire ou un `ReadableStream`. HEAD conserve les en-têtes et le statut sans envoyer le corps. Un Location sur une réponse 201 ne transforme pas cette réponse en redirection. Les contrôles `NextResponse.next` et `rewrite` sont réservés au middleware et sont refusés dans un Route Handler.

Les pages App réécrites conservent leur URL visible et l'état des layouts pendant les navigations. La destination fournit les props serveur. Les pages cachées reçoivent des métadonnées de navigation propres à la requête, sans les enregistrer dans leur version partagée. Les formulaires Server Actions passent par le middleware avec et sans JavaScript.

## En-têtes et cookies

`NextResponse.next({ request: { headers } })` remplace les en-têtes transmis à la destination. Les champs absents du nouvel objet sont supprimés, à l'exception des en-têtes Flight que le serveur conserve. Un objet Headers vide laisse les champs originaux en place, comportement vérifié dans Next.js 16.3.5. L'URL originale reste disponible même lorsque Host est retiré.

Les en-têtes ordinaires de la réponse du middleware sont visibles à la fois par la destination et par le client, et prennent priorité sur les valeurs de la réponse finale. Les en-têtes de connexion, de longueur et de contrôle interne sont filtrés. Les métadonnées privées de navigation ne peuvent pas retrouver une politique de cache publique ou un validateur par ce biais. `request: { headers }` permet de transmettre un champ uniquement en amont ; `headers` à la racine de l'option le rend public.

`response.cookies.set/delete` ajoute les cookies à la réponse HTTP. Ceux de la destination viennent ensuite ; seuls les doublons strictement identiques sont retirés. Les cookies ajoutés par cette API sont immédiatement visibles dans `cookies()` pendant le rendu App et les actions. Les `Request.cookies` des API, leurs `cookies()` ambiants et les `req.cookies` du Pages Router gardent les cookies entrants, comme observé dans la version de référence. Pour les modifier en amont, remplacer explicitement l'en-tête Cookie de requête.

Les en-têtes `x-middleware-*` reçus d'un client ne permettent pas de simuler ces contrôles, d'injecter des cookies de rendu ou d'éviter l'exécution du middleware. Le `x-middleware-rewrite` envoyé par le serveur expose uniquement la destination effectivement choisie par le code applicatif.

La vérification d'origine des Server Actions utilise les en-têtes reçus avant les remplacements du middleware. Retirer Origin ou Sec-Fetch-Site ne désactive pas cette vérification.

## Travail différé et ressources

```ts
export function proxy(request, event) {
  event.waitUntil(sendMetric(request.nextUrl.pathname));
  return NextResponse.next();
}
```

`waitUntil` observe le travail différé sans retarder la réponse ou la prochaine invocation. Les erreurs sont journalisées ; elles ne remplacent pas une réponse déjà envoyée. Chaque worker suit au plus 32 invocations ayant du travail différé et 128 promesses au total, pendant 25 secondes au maximum. Le framework ne peut pas arrêter de force une promesse arbitraire ; utiliser le signal de requête pour les opérations qui permettent l'annulation.

Un worker dédié démarre à la première correspondance et s'arrête après 30 secondes sans invocation. Il ne crée aucun thread RSC. Quatre travaux maximum sont admis au transport du worker. Cinq corps entrants au maximum peuvent être conservés pendant la préparation et la transmission en aval ; chacun est limité à 8 Mio. Avant la lecture d'un corps, 64 requêtes supplémentaires peuvent attendre une place, pendant 30 secondes au maximum. Cela absorbe les chargements simultanés d'un graphe de modules derrière un proxy global sans contourner son contrôle. Une surcharge au-delà de cette admission reçoit 503 avec `Retry-After: 1` ; une attente expirée reçoit 504. Les réponses finales peuvent dépasser 16 Mio en streaming, avec les délais d'inactivité et le contrôle du débit existants. Les Server Actions gardent aussi leur limite propre de 1 Mio au moment de leur traitement.

Une exception avant la réponse produit une erreur HTTP sans détail applicatif en production. Après le début d'un flux, une erreur termine ce flux. Le middleware et la mutation de destination ne sont pas rejoués automatiquement. Les limites ne constituent pas un plafond sur la mémoire allouée par les modules npm.

Le matcher natif évite Node sur les chemins exclus. Sur un chemin inclus, le JavaScript du middleware s'exécute à chaque requête, même si Rust sert ensuite une page ou une API déjà cachée. `npm run bench:middleware` mesure ces parcours séparément ; les [résultats locaux](performance.md#middleware-et-chemins-exclus) incluent le coût mémoire des workers actifs.

Les contrats généraux sont décrits par les documentations officielles [proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy) et [NextResponse](https://nextjs.org/docs/app/api-reference/functions/next-response). La priorité des en-têtes, les remplacements, les cookies et les réécritures ont également été vérifiés sur un serveur de production Next.js 16.3.5 indépendant du projet.
