# Gestionnaire de cache incrémental

`cacheHandler` configure le stockage historique des entrées `FETCH` utilisées par `fetch` persistant et `unstable_cache`, ainsi que le Full Route Cache (`PAGES`, `APP_PAGE`, `APP_ROUTE`). Cette option est distincte de `cacheHandlers`, qui configure les directives `'use cache'`. Sans gestionnaire applicatif, PRNext conserve son cache SQLite natif partagé entre workers.

```js
export default {
  cacheHandler: './cache-handler.ts',
  cacheMaxMemorySize: 0,
}
```

Le fichier JavaScript ou TypeScript exporte une classe possédant `get(key, ctx)`, `set(key, value, ctx)` et `revalidateTag(tags, durations)`. La méthode facultative `resetRequestCache()` est appelée au début de chaque contexte de requête. Le constructeur reçoit notamment `dev`, `fs`, `serverDistDir`, `maxMemoryCacheSize` et `_requestHeaders`. Chaque requête reçoit sa propre instance ; le module peut partager son stockage ou son pool de connexions. Aucun code du gestionnaire n'entre dans le navigateur, et son fichier source n'est plus nécessaire après compilation.

`get` renvoie `null` ou `{ value, lastModified }`, avec un horodatage en millisecondes. Les valeurs `FETCH` contiennent `kind`, `data` et `revalidate`. Pour `fetch`, `data.body` contient les octets en base64 ; pour `unstable_cache`, il contient le JSON du résultat. PRNext conserve aussi les métadonnées nécessaires à la reconstruction des réponses. Les clés de données ne sont pas interchangeables avec celles de Next.

Les tags explicites et les tags implicites de chemins sont transmis au backend. Les invalidations sont terminées avant la réponse de la mutation. Un échec de lecture ou d'écriture laisse répondre le producteur ; un échec d'invalidation est propagé. Les valeurs périmées peuvent être renouvelées en arrière-plan, tandis qu'un rendu statique exige des données fraîches. Draft Mode contourne la persistance. Les enveloppes PPR dépendant de ce stockage sont revérifiées par requête pour ne pas masquer une invalidation distante.

Les données sont limitées à 2 Mio par entrée, les opérations de stockage à cinq secondes et les productions à vingt-cinq secondes. La déduplication JavaScript retient au plus 64 productions en cours ; l'annulation libère leur admission. Les baux Rust coordonnent aussi les productions entre les workers d'un même serveur, sans stocker une deuxième copie des données. Leur révision empêche une invalidation locale concurrente de republier une ancienne valeur. Les réponses `fetch` restent progressives pendant la capture bornée des octets. Le gestionnaire applicatif conserve la responsabilité de sa capacité, de ses connexions et des courses de publication/invalidation entre instances.

`cacheMaxMemorySize` accepte un nombre entier d'octets entre zéro et 1 Gio. PRNext transmet cette valeur au gestionnaire et la partage entre les caches internes des deux bases SQLite, pour les données et les pages rendues. Zéro désactive leur rétention de pages propres ; cela conserve le stockage sur disque et ne supprime pas la mémoire de travail des opérations en cours. Ce réglage ne plafonne ni la RAM totale du processus, ni la mémoire conservée par les dépendances applicatives. En l'absence de réglage, les petits budgets natifs existants sont conservés.

Les tests utilisent deux serveurs avec un backend fichier partagé, des corps binaires, les invalidations de tags et chemins et un redémarrage. Ils vérifient aussi les appels du constructeur, les caches temporaires par requête, les erreurs, la taille maximale, la concurrence et l'annulation. Ils ne certifient pas un gestionnaire Redis ou un autre service tiers.

Référence officielle : [cacheHandler](https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath).

## Pages et réponses prérendues

Le serveur Rust conserve le routage, l'admission, la déduplication locale des générations et les fichiers HTML/données publiés atomiquement. Avec `cacheHandler`, chaque sélection d'une page statique consulte cependant le backend applicatif : la copie SQLite locale ne peut pas masquer une invalidation faite par une autre instance. Une version inchangée réutilise les mêmes fichiers sans les réécrire. Un miss distant déclenche une génération, y compris lorsqu'un prérendu du build existe ; celui-ci n'est pas réinjecté automatiquement dans un cache invalidé.

Les valeurs `PAGES` contiennent `html` et `pageData`, les valeurs `APP_PAGE` contiennent `html` et `rscData` binaire, et les valeurs `APP_ROUTE` contiennent `body` binaire. Leur statut, leurs en-têtes et leurs valeurs multiples sont conservés selon les règles de cache de la route. Le gestionnaire doit stocker et restituer toute l'enveloppe, notamment `_prnext`, qui contient la durée et les associations nécessaires à la validation. Les clés des réponses sont séparées par l'identifiant interne du build, même si `generateBuildId` est fixe. `res.revalidate`, les tags et les chemins sont propagés au stockage partagé.

Ces opérations utilisent le worker de maintenance paresseux, avec cinq admissions maximum. Le contexte de ce worker est canonique : les en-têtes visiteurs ne sont pas fournis au constructeur du gestionnaire pour le Full Route Cache. Les cookies et les paramètres de requête ne deviennent pas une dimension implicite de ses clés. La somme HTML/données ou le corps du handler est limitée à 16 Mio. Rust transmet les chemins privés de ses fichiers complets au worker de publication, sans ajouter une copie base64 de leurs contenus dans la requête IPC.

Une invalidation locale survenant pendant la publication empêche la publication native obsolète, invalide la valeur externe potentiellement écrite, puis autorise une nouvelle tentative. La coordination transactionnelle entre machines reste du ressort du gestionnaire. Contrairement à la tolérance des données `FETCH`, un backend Full Route Cache indisponible fait échouer la sélection plutôt que servir arbitrairement une ancienne copie locale devenue invérifiable. Sans `cacheHandler`, le chemin des hits statiques reste entièrement natif, sans worker Node.

Les régressions couvrent les trois formes, le partage HTML/Flight, les invalidations distantes, les redémarrages, l'absence de résurrection des seeds, le renouvellement à la demande et la course entre publication et invalidation.
