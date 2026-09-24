# Pages Router : pages statiques et régénération

Dans le Pages Router, Rustyx conserve le HTML et les données JSON de `getStaticProps`. Rust sert une version déjà générée depuis le disque. Node n'intervient que pour calculer une version manquante ou renouveler une page. Le HTML et les données d'une génération sont publiés ensemble.

```tsx
import type { GetStaticProps } from 'rustyx';

export const getStaticProps: GetStaticProps = async () => ({
  props: { generatedAt: new Date().toISOString() },
  revalidate: 60,
});

export default function Page({ generatedAt }: { generatedAt: string }) {
  return <p>Generated at {generatedAt}</p>;
}
```

La version produite au build reste fraîche pendant 60 secondes. Après ce délai, une visite reçoit cette version pendant qu'une seule régénération prépare la suivante. Les visites ultérieures reçoivent la nouvelle version une fois son enregistrement terminé. Si le calcul échoue, la dernière version valide reste disponible ; une visite ultérieure peut relancer le calcul. Ce comportement suit le contrat [ISR du Pages Router](https://nextjs.org/docs/pages/guides/incremental-static-regeneration).

L'en-tête `x-nextjs-cache` distingue `HIT`, `MISS` et `STALE`. `revalidate: false`, ou son omission, désactive l'expiration temporelle. `revalidate: 0` demande un calcul à chaque requête. Les durées doivent être des entiers positifs ou nuls. `getStaticProps` reçoit `revalidateReason: 'build'`, `'stale'` ou `'on-demand'` selon le déclencheur. Les réponses `notFound` et `redirect` peuvent aussi être conservées puis renouvelées.

## Chemins dynamiques

`getStaticPaths` accepte les trois formes de `fallback` décrites par [Next.js](https://nextjs.org/docs/pages/api-reference/functions/get-static-paths) :

| Valeur | Chemin absent du build |
| --- | --- |
| `false` | Réponse 404 |
| `'blocking'` | Le premier visiteur attend le calcul ; les suivants réutilisent la page |
| `true` | Une page de chargement avec `router.isFallback` est envoyée ; le navigateur récupère les props et met à jour le composant |

Avec `fallback: true`, le composant doit accepter des props vides lorsque `useRouter().isFallback` vaut `true`. La mise à jour conserve l'état du `_app`. Les robots reconnus et les requêtes de données attendent le rendu complet. La [navigation SPA Pages](pages-navigation.md) avec `next/link` attend les données complètes sans afficher ce shell ; la page précédente reste interactive pendant l'attente.

Les données sont exposées sous `/_rustyx/data/{buildId}/chemin.json`, avec `/index.json` pour la racine et `/index/index.json` pour le chemin littéral `/index` ; `/_next/data` est également accepté. Les props sont publiques, comme celles intégrées au HTML. Une URL correspondant à un autre build renvoie 404. Les paramètres de recherche du visiteur ne sont pas conservés dans le HTML partagé ; le routeur les rétablit après hydratation.

Quand `basePath` est configuré, ces URL publiques reçoivent son préfixe. Les entrées du cache conservent leurs chemins internes. `assetPrefix` ne déplace pas ces données vers le CDN ; `res.revalidate` accepte un chemin avec ou sans `basePath`.

## Régénération à la demande

Une API Pages peut attendre `res.revalidate('/chemin-exact')`. La promesse est résolue après publication de la nouvelle génération et rejette si celle-ci échoue. L'option `{ unstable_onlyGenerated: true }` évite de calculer un chemin encore absent du cache.

```ts
// À appeler dans un handler API après les vérifications propres à l'application.
await res.revalidate('/products/123');
res.json({ revalidated: true });
```

Une régénération déjà en cours est terminée avant le nouveau calcul à la demande. Cela évite de confirmer une modification en publiant seulement une génération démarrée avant elle. Un worker de maintenance séparé permet à l'API d'attendre cette opération même avec `--workers 1`. Il démarre à la demande et s'arrête après 30 secondes d'inactivité. Pendant son utilisation, sa mémoire s'ajoute à celle des workers de requêtes.

Cette API concerne les pages possédant `getStaticProps`. Un chemin exclu par `fallback: false` ne peut pas être créé par cet appel. Elle s'appelle avant l'envoi des en-têtes et attend au plus 25 secondes, avec annulation liée à la requête API. Une attente annulée ou expirée ne garantit pas l'arrêt d'un calcul déjà commencé côté Rust : celui-ci peut encore publier son résultat.

Pour le Pages Router, `revalidatePath` et les tags du [cache de données](caching.md) ne remplacent pas encore l'invalidation de la page complète : utiliser `res.revalidate` pour actualiser son HTML.

## Persistance et mesure

Les versions calculées à l'exécution se trouvent dans `.rustyx-cache/pages/` et survivent au redémarrage du serveur. Elles sont associées au build qui les a produites : reconstruire l'application crée un nouvel espace de cache. Le build initial fournit les premières versions, sans nécessiter de calcul au démarrage du serveur. Un calcul échoué ou interrompu ne remplace pas les fichiers publiés.

Les corps HTML et JSON sont limités à 16 Mio chacun et écrits en flux. Les variantes gzip utiles sont calculées une fois avant publication. Le cache dispose de 256 Mio pour les fichiers publiés, variantes comprises, et de 4 096 entrées, tous builds confondus. Les versions encore consommées et les calculs en cours peuvent temporairement dépasser ce budget. Les métadonnées SQLite ont leur propre budget de pages ; ces limites ne constituent pas un plafond de RAM du processus.

Une instance regroupe les demandes simultanées pour le même chemin et admet au plus cinq générations, calcul et enregistrement compris. Un seul worker exécute leur JavaScript ; l'enregistrement d'une réponse peut continuer pendant le calcul suivant. La coordination des régénérations est locale au processus : plusieurs serveurs partageant le même dossier ne disposent pas encore de baux communs pour ce cache de pages.

Une éviction ou un fichier manquant ne fait pas réapparaître une ancienne version du build. Un marqueur persistant force alors la régénération des versions initiales plus anciennes qui n'ont plus de remplacement conservé. Ce mécanisme peut aussi recalculer d'autres pages initiales pour éviter de servir un contenu obsolète.

En développement, chaque requête recalcule ses props ; les routes dynamiques réévaluent `getStaticPaths`. Le HTML n'est pas réutilisé comme en production.

La page `/isr/welcome` de `examples/basic` illustre une expiration de dix secondes ; `/isr/another-page` illustre la génération d'un nouveau chemin. Lancer un build de production puis le serveur pour observer le cache.

`npm run bench:isr` mesure séparément le HTML produit au build, les pages calculées à l'exécution, leurs données JSON et un SSR avec origine volontairement retardée de 10 ms. Il compte les appels d'origine et la mémoire des processus Node démarrés. Ce microbenchmark ne compare pas Rustyx à Next.js.

L'App Router possède aussi un [cache HTML/Flight avec ISR](app-static.md), avec invalidation par tags ou chemins. Les deux routeurs partagent le budget de stockage et le worker de maintenance. Le cache partagé entre plusieurs machines, les handlers de cache personnalisés et la parité complète des conventions de données Next.js ne sont pas disponibles.
