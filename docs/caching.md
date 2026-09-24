# Cache de données

Rustyx conserve les résultats de `unstable_cache` et des appels `fetch` explicitement cachés dans un cache SQLite géré par Rust. Les workers Node et leurs threads RSC partagent ces entrées. Les pages App partageables disposent aussi d'un [cache HTML/Flight avec génération statique et ISR](app-static.md). Les [Cache Components](cache-components.md) (`use cache`, `cacheLife`, `cacheTag`) utilisent leurs adaptateurs React et les mêmes mécanismes d'invalidation.

Les pages du Pages Router disposent aussi d’un [cache HTML/JSON avec ISR](isr.md), distinct du cache de données décrit ici.

La démo `/cache` de `examples/app` lit un message avec `unstable_cache`. Son formulaire enregistre la valeur puis appelle `updateTag`, ce qui permet au rendu suivant de lire immédiatement le changement.

## Cacher une fonction

```ts
import { unstable_cache } from 'next/cache'; // ou 'rustyx/cache'

export const getProduct = unstable_cache(
  async (id: string) => database.product.findUnique({ where: { id } }),
  ['product-v1'],
  { tags: ['products'], revalidate: 60 },
);
```

La clé dépend du texte de la fonction, de `keyParts` et des arguments sérialisés en JSON. Les tags servent à invalider les données et ne changent pas leur identité. Les variables capturées qui influencent le résultat doivent figurer dans les arguments ou `keyParts`. Une valeur conservée est sérialisée en JSON : une date devient une chaîne lors d'une lecture ultérieure, les cycles et BigInt ne sont pas sérialisables. Le premier calcul conserve la valeur retournée par le producteur. Ces règles suivent le contrat de [`unstable_cache`](https://nextjs.org/docs/app/api-reference/functions/unstable_cache).

`revalidate` accepte une durée positive en secondes, `false` ou `Infinity` ; son omission ne fixe pas d'expiration temporelle. Une valeur peut néanmoins être évincée pour respecter le budget du cache. Les options acceptent au plus 128 tags de 256 caractères chacun. `headers()` et `cookies()` sont interdits dans la fonction cachée : lire les informations nécessaires avant l'appel et les passer explicitement en arguments.

Un `unstable_cache` imbriqué exécute directement sa fonction dans la portée cachée existante, ce qui évite notamment d'attendre son propre bail. Les routes configurées en `force-no-store` contournent aussi la lecture et l'écriture de ce cache. Différence restante : [Next 16.3.5 peut écrire un résultat après avoir contourné sa lecture](https://github.com/vercel/next.js/blob/v16.3.5/packages/next/src/server/web/spec-extension/unstable-cache.ts) ; Rustyx ne remplit pas d'entrée indépendante dans ces cas.

Dans le Pages Router et pour un appel autonome disposant du service natif, une entrée périmée est renouvelée avant de renvoyer la valeur. L'App Router peut servir l'ancienne valeur pendant son renouvellement. Les tags invalides passés à `unstable_cache` sont actuellement refusés ; Next peut plutôt les ignorer avec un avertissement.

## Cacher un fetch

```ts
const response = await fetch('https://example.test/products', {
  next: { revalidate: 60, tags: ['products'] },
});
const products = await response.json();
```

L'adaptateur fetch s'applique à l'App Router ; les pages et API Pages Router conservent le fetch natif. En mode de route `auto`, la persistance est explicite : `cache: 'force-cache'`, `next.revalidate: false` ou une durée positive. `cache: 'no-store'`, `cache: 'no-cache'` et `next.revalidate: 0` la désactivent. Les appels ordinaires ne remplissent pas le cache persistant ; leur résultat peut néanmoins participer à une page statique produite au build. Les tags seuls ne changent pas cette décision. Le mode de route `dynamic: 'error'` rend en revanche persistant un fetch sans option, sauf si `fetchCache: 'default-no-store'` impose le contraire ; cette dernière combinaison provoque alors une erreur de rendu statique. Une route `force-dynamic` ou `fetchCache: 'force-no-store'` contourne la persistance même si l'appel la demande. Ces options sont décrites par la [référence fetch de Next.js](https://nextjs.org/docs/app/api-reference/functions/fetch).

La clé inclut notamment URL, méthode, en-têtes, options de requête et corps connu. Les requêtes POST explicitement cachées sont prises en charge ; un échec de commit ne relance jamais l'appel d'origine. Les réponses cachées conservent statut, en-têtes, URL, redirection et octets du corps. Les réponses HTTP autres que 200 ou contenant `Set-Cookie` restent hors de la persistance.

Le premier appel reçoit sa Response dès les en-têtes d'origine, avant la fin de son corps. Rustyx capture au plus 2 Mio, métadonnées comprises, sans dupliquer le flux avec un tee non borné. Si la réponse est trop grande, reste inactive pendant une seconde ou dépasse 20 secondes, la capture est abandonnée et le flux applicatif continue normalement. Les appels suivants peuvent alors refaire la requête d'origine. Un corps d'upload `ReadableStream`, ou un `Request` possédant déjà un corps, contourne aussi le cache ; les options de transport Node personnalisées restent confiées au fetch natif.

Pendant un rendu App, les GET identiques peuvent être mémoïsés, y compris avec `cache: 'no-store'`. Cette réutilisation se limite à la requête en cours, partage metadata/layouts/fallbacks, et ne concerne pas les Route Handlers ni les Server Actions. Elle dispose de 8 Mio et 128 entrées, réserve 2 Mio avant chaque capture et renonce à la réutilisation lorsque ces bornes sont atteintes. Fournir explicitement un signal ou un objet `Request` désactive cette mémoïsation. Les protections sur la taille, les délais et `Set-Cookie` s'appliquent également.

## Invalider et actualiser

| Appel | Comportement |
| --- | --- |
| `revalidateTag('products', 'max')` | Marque les entrées périmées ; la prochaine lecture peut renvoyer leur ancienne valeur et lancer un renouvellement. La fenêtre maximale de données périmées est d'un an |
| `revalidateTag('products', { expire: 0 })` | Expire immédiatement les entrées ; la prochaine lecture attend une valeur fraîche |
| `revalidateTag('products')` | Même expiration immédiate, forme historique dépréciée par Next |
| `updateTag('products')` | Expiration immédiate réservée aux Server Actions, pour lire son propre changement |
| `revalidatePath('/products/123')` | Invalide les données attachées à cette URL |
| `revalidatePath('/products/[id]', 'page')` | Invalide les données attachées à ce motif ; `type` est obligatoire pour les segments dynamiques |
| `revalidatePath('/products', 'layout')` | Invalide les données de ce layout et de ses descendants ; `('/', 'layout')` couvre toutes les routes attachées |
| `refresh()` | Actualise le routeur après une Server Action sans invalider le cache de données |
| `unstable_noStore()` | Signale qu'une portée ne doit pas être implicitement cachée ; ne désactive pas un `unstable_cache` explicite |

Ces invalidations touchent également le cache HTML/Flight des pages App concernées. Une régénération de page attend des données fraîches au lieu de publier une nouvelle page à partir d'une donnée encore périmée. Le cache HTML/JSON Pages Router conserve son API `res.revalidate`.

Les fonctions d'invalidation sont synchrones et ne renvoient rien. Rustyx envoie leurs opérations dans l'ordre et les termine avant une lecture suivante du même contexte ou le rendu actualisé d'une action. Elles sont autorisées dans les Server Actions et Route Handlers, hors rendu, hors portée cachée et avant l'envoi des en-têtes. `updateTag` et `refresh` exigent une Server Action. Les API correspondantes sont documentées dans [`revalidateTag`](https://nextjs.org/docs/app/api-reference/functions/revalidateTag), [`updateTag`](https://nextjs.org/docs/app/api-reference/functions/updateTag), [`revalidatePath`](https://nextjs.org/docs/app/api-reference/functions/revalidatePath), [`refresh`](https://nextjs.org/docs/app/api-reference/functions/refresh) et [`unstable_noStore`](https://nextjs.org/docs/app/api-reference/functions/unstable_noStore).

Les profils `default`, `seconds`, `minutes`, `hours`, `days`, `weeks` et `max` utilisent les expirations prédéfinies de [`cacheLife`](https://nextjs.org/docs/app/api-reference/functions/cacheLife). Les profils personnalisés dans `next.config` ne sont pas disponibles. `revalidateTag(..., 'max')` garde sa lecture périmée également dans une action ; utiliser `updateTag` lorsqu'une lecture immédiatement fraîche est nécessaire.

## Persistance et bornes

La base `.rustyx-cache/data.sqlite3` se trouve à côté de `.rustyx/` et survit à son remplacement ainsi qu'au redémarrage du serveur. Le projet doit autoriser l'écriture de ce dossier pour que la persistance fonctionne ; il n'existe pas encore d'option pour déplacer la base. Les builds Pages et App statiques et les appels autonomes sans serveur de cache exécutent la fonction sans persistance. Un défaut de lecture du cache laisse le producteur fonctionner ; une invalidation échouée remonte comme erreur, car sa réussite ne peut pas être présumée.

Le stockage logique est limité à 64 Mio et 8 192 entrées, associations comprises, avec éviction des moins récemment utilisées. Une clé retient au plus 128 tags et 128 associations de chemins ; un partage dépassant ces bornes entraîne son remplacement. La base SQLite est limitée à 128 Mio, son cache de pages configuré à 2 Mio et le WAL conservé après checkpoint ciblé à 4 Mio. Le WAL actif peut temporairement dépasser cette cible. Ces réglages ne constituent pas une limite de RAM RSS : les requêtes, octets encodés, résultats temporaires et allocations applicatives s'y ajoutent.

Au plus 256 producteurs disposent d'un bail natif simultané. Une entrée manquante est calculée par un seul propriétaire ; les autres requêtes attendent. Les baux expirent après 30 secondes, et le travail JavaScript de cache a une échéance de 25 secondes. Une invalidation retire les baux en cours et change leur génération, empêchant un calcul ancien de réintroduire des données invalidées. Un renouvellement échoué conserve la dernière valeur disponible et pourra être réessayé. Les réponses progressives peuvent déjà être transmises pendant ce travail ; les réponses Flight encore tamponnées attendent sa finalisation.

`npm run bench:cache` mesure les latences, le débit et les appels d'origine évités avec une origine locale volontairement retardée de 10 ms. Les résultats sont propres à ce scénario ; ils ne mesurent pas une supériorité générale sur Next.js.
