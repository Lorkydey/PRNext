# Export statique

`output: 'export'` dans `next.config.*` ou `rustyx.config.*` produit `out/`. Ce dossier contient le HTML, le JavaScript navigateur, les styles, les fichiers publics, les données JSON Pages et les réponses Flight App. Aucun runtime serveur ni secret du manifeste privé n'y est copié.

```js
export default {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};
```

Un serveur de fichiers ordinaire peut publier `out/`. Avec `trailingSlash: true`, `/article/` correspond à `article/index.html`. Sinon, configurer le serveur pour chercher `/article.html`. Les pages d'erreur sont `404.html` et `500.html` lorsqu'elles existent. Avec `basePath`, le sous-dossier correspondant est présent dans `out/`. Avec un `assetPrefix` CDN, publier aussi `out/_rustyx/assets` à l'adresse CDN configurée.

L'App Router conserve l'hydratation, les navigations et l'état des layouts en chargeant les fichiers Flight statiques. Pages conserve ses données JSON de navigation. Les routes dynamiques doivent être entièrement générées ; Pages exige `fallback: false`. Les Route Handlers déjà pré-rendus exportent leur corps.

Les API Pages, Server Actions, middleware/proxy, règles serveur, ISR, rendu Edge ou à la requête, enveloppes PPR incomplètes et images utilisant l'optimiseur HTTP sont refusés. Utiliser des images non optimisées ou un loader externe. Les pages non pré-rendues, notamment les cas `getInitialProps` encore dynamiques, sont également refusées. Cet export ne reproduit pas toutes les options historiques d'export de Next.

La publication remplace atomiquement un ancien export Rustyx après la réussite du build. Une erreur conserve l'export précédent. Un dossier `out/` existant sans marqueur Rustyx n'est pas écrasé.

Les tests HTTP et Chromium suppriment les sources, le runtime et `node_modules` avant de vérifier le résultat sur un serveur de fichiers.

Référence : [export statique Next](https://nextjs.org/docs/pages/guides/static-exports).
