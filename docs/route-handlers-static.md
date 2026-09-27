# Route Handlers statiques

PRNext peut précompiler une réponse `app/**/route.ts`, puis servir son corps directement depuis Rust. JSON, texte, HTML et octets arbitraires utilisent le même cache persistant ; aucun rendu React ni payload Flight n'est ajouté. Le JavaScript et les modules npm s'exécutent au build ou pendant une génération, dans Node.

```ts
// app/api/catalog/route.ts
export const revalidate = 30;

export function GET() {
  return Response.json({ generatedAt: new Date().toISOString() });
}
```

Le build prépare la première réponse. Après 30 secondes, une lecture peut servir cette version pendant qu'un worker calcule la suivante. `x-nextjs-cache: HIT`, `MISS` et `STALE` indique le parcours suivi. La démo `examples/app` expose `/api/catalog`. En développement, les handlers restent exécutés à chaque requête.

## Activation et paramètres

Un GET est dynamique par défaut. Le fichier `route` doit exporter `revalidate = false`, une durée positive, `dynamic = 'force-static'` ou `'error'`, ou `generateStaticParams`. Un export POST, PUT, PATCH, DELETE ou OPTIONS désactive le cache de réponse de ce handler. HEAD peut coexister avec GET. `dynamic = 'force-dynamic'` et, hors `force-static`, `revalidate = 0` demandent une exécution par requête.

Pour une route à paramètres, `revalidate` seul ne suffit pas : ajouter `generateStaticParams`, éventuellement retournant `[]`, ou utiliser `dynamic = 'force-static'` ou `'error'`. Le générateur et la configuration appartiennent au fichier `route` ; les layouts parents n'interviennent pas. Les résultats suivent la même validation et la même limite de 10 000 chemins que les [pages App](app-static.md).

```ts
// app/api/products/[id]/route.ts
export const revalidate = 60;
export const generateStaticParams = () => [{ id: 'first' }];

export async function GET(_: Request, { params }: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return Response.json({ id });
}
```

Le chemin `first` est produit au build ; les autres sont calculés à leur première visite. Avec `dynamicParams = false`, un chemin absent des résultats complets du générateur reçoit 404, quelle que soit sa méthode HTTP. Les générateurs ne sont pas rejoués pendant l'ISR.

## Données de requête et cache

En mode ordinaire, lire `headers()`, `cookies()`, les en-têtes ou cookies du Request, son URL complète, ses paramètres de recherche ou son corps provoque le retour au mode dynamique. Lire `request.nextUrl.pathname` et les `params` de route reste permis. Les clones de Request, les lectures différées d'un `ReadableStream` et les erreurs de détection interceptées par l'application suivent la même règle. Le premier visiteur ne fournit jamais ses données privées à une génération partagée.

`dynamic = 'error'` fait échouer ces usages au lieu de revenir au mode dynamique. `dynamic = 'force-static'` expose des en-têtes, cookies et paramètres de recherche vides ; l'URL canonique emploie `http://localhost:3000` avec le chemin de la route. Ces valeurs suivent le comportement observé de Next.js et ne représentent pas l'hôte du visiteur.

Les dépendances `fetch` et `unstable_cache` contribuent leurs tags, chemins et durées au résultat. La durée positive la plus courte l'emporte. `revalidateTag`, `updateTag` depuis une Server Action, et `revalidatePath` invalident les réponses concernées, y compris les versions initiales. Le [guide du cache](caching.md) décrit ces API. Une réponse comportant `Set-Cookie` ou `Cache-Control: private, no-store` peut néanmoins être conservée dans ce cache interne si son handler est explicitement statique ; ces en-têtes applicatifs sont transmis au client.

## Statuts et méthodes HTTP

Au build, les réponses de statut inférieur à 400 ainsi que 404 peuvent être conservées. Un autre statut fait revenir le chemin au mode dynamique. Dans une route à paramètres, ce cas ou une détection de données dynamiques désactive aussi la génération à la première visite pour les chemins non précompilés ; les réponses produites avec succès au build restent disponibles.

Pendant l'ISR d'une route déjà éligible, une réponse HTTP d'erreur est une réponse publiable, y compris 500. Une exception, un dépassement de limite ou une erreur de protocole conserve la dernière version valide. Un statut 204, 205 ou 304 exige un corps vide.

GET et HEAD partagent le cache du chemin, comme observé avec Next.js 16.3.5. Sur une entrée existante, HEAD reprend le statut et les en-têtes cachés de GET et supprime le corps envoyé. Sur un chemin encore absent, HEAD exécute l'export HEAD s'il existe ; sa réponse peut donc devenir celle des GET suivants. Sans export HEAD, le GET est appelé avec `request.method === 'HEAD'` et son corps est conservé pour les GET suivants.

Deux différences restent explicites : PRNext garde les autres méthodes hors du cache GET, alors que la version de Next.js vérifiée peut y conserver le 405 d'un POST arrivé en premier ; PRNext conserve aussi sa réponse OPTIONS automatique 204 sur un chemin connu, alors que cette version de Next.js renvoie 405 pour les handlers statiques testés.

Les contrats généraux sont décrits dans la documentation officielle des [Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route) et de la [configuration des segments](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config). Les cas de statuts, méthodes et paramètres ci-dessus ont aussi été vérifiés sur un build de production Next.js 16.3.5 distinct du projet PRNext.

## Stockage et limites

Chaque réponse utilise un fichier `.body` et, si utile, une variante gzip. Une réponse déjà encodée conserve son `Content-Encoding` sans double compression. Les en-têtes multiples, le statut et l'absence éventuelle de Content-Type sont préservés ; la compression peut rendre un ETag fort faible pour couvrir les représentations disponibles. Une réécriture ne modifie pas le corps HTML d'un handler ; `RSC: 1` ne change pas sa représentation et les URL de données Pages Router ne l'exposent pas.

Le cache `.prnext-cache/pages/` partage ses budgets avec les pages : 256 Mio et 4 096 entrées, variantes gzip comprises. Le corps d'un handler statique est limité à 16 Mio ; les handlers dynamiques peuvent transmettre davantage en flux. Les tags, chemins, délais et générations simultanées suivent les [limites du cache App](app-static.md#persistance-et-limites). Le worker de maintenance s'arrête après 30 secondes sans génération ; un handler ne nécessite pas de thread RSC. Les réponses et invalidations persistent après redémarrage, dans l'espace du même build.

`npm run bench:route-static` mesure séparément les lectures du build, celles d'une génération ultérieure, le premier calcul et la mémoire après arrêt du worker. Les [résultats locaux](performance.md#route-handlers-servis-par-rust) restent des microbenchmarks, sans comparaison de performances avec Next.js.
