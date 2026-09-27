# Pages d'erreur

Le Pages Router reconnaît `pages/404`, `pages/500` et `pages/_error`, également dans `src/pages`. Les fichiers utilisent les mêmes extensions que les autres pages. Leurs composants passent par `_app`, avec ses styles et ses providers.

## Pages statiques 404 et 500

```tsx
// pages/404.tsx
import Link from 'prnext/link';

export default function Missing() {
  return <main>
    <h1>Page introuvable</h1>
    <Link href="/">Retour à l'accueil</Link>
  </main>;
}
```

`404` s'applique aux chemins introuvables et aux résultats `notFound:true` des fonctions de données. `500` s'applique aux exceptions serveur des pages. Une fonction de données peut définir elle-même un statut, par exemple 418, et continuer à rendre sa page : ce statut ne déclenche pas automatiquement la page d'erreur. Les réponses explicitement terminées par l'application et les réponses API restent inchangées.

Ces pages sont produites au build, sauf lorsqu'un `_app.getInitialProps` personnalisé les rend dynamiques en l'absence de `getStaticProps`. Elles peuvent exporter `getStaticProps`, avec ISR et `res.revalidate`, mais pas `getServerSideProps` ni `getInitialProps`. Les résultats `notFound` ou `redirect` ne sont pas acceptés pour ces pages d'erreur. Les fichiers statiques sont servis par Rust ; un chemin inconnu n'a pas besoin de démarrer Node lorsque sa page 404 est déjà disponible. L'invalidation de `/404` modifie aussi la page utilisée pour les autres chemins manquants.

Le HTML de `/404` et `/500` porte respectivement les statuts 404 et 500. Une réponse de données `notFound` conserve le JSON `{ "notFound": true }`. Le routeur peut charger séparément les props de `/404`. Une exception serveur pendant une requête de données revient au document d'erreur, comme une visite HTTP directe.

Sans fichiers personnalisés ni `_error`, PRNext prépare des pages d'erreur intégrées. Ces ressources internes ne deviennent pas des routes applicatives supplémentaires.

## Composant `_error`

```tsx
// pages/_error.tsx
import Error from 'prnext/error';
import type { NextPageContext } from 'prnext';

function CustomError({ statusCode }: { statusCode?: number }) {
  return <p>{statusCode ? `Erreur ${statusCode}` : 'Erreur dans le navigateur'}</p>;
}

CustomError.getInitialProps = async (context: NextPageContext) => {
  return Error.getInitialProps(context);
};

export default CustomError;
```

`_error` est le composant de repli lorsqu'aucune page statique correspondante n'existe, ainsi que pour les erreurs de rendu React dans le navigateur. Il peut définir `getInitialProps`, également pris en charge sur [les pages ordinaires et `_app`](initial-props.md). Les fonctions `getStaticProps`, `getStaticPaths` et `getServerSideProps` ne sont pas acceptées dans `_error`. Son chemin `/_error` est réservé et reçoit une réponse 404 lorsqu'il est visité directement.

Sur le serveur, `getInitialProps` reçoit l'erreur réelle dans `err`, la requête et la réponse, le chemin logique `/_error`, la query visible et l'URL visible dans `asPath`. Le résultat est propre à la requête. Le framework ne sérialise pas automatiquement le message privé ou la pile de l'exception serveur. Les données que l'application retourne elle-même dans les props restent publiques.

Une exception pendant la génération ISR traverse un processus de maintenance distinct. Dans ce cas, `_error` reçoit une instance `Error` reconstruite avec son nom, son message, sa pile, son code primitif et son statut lorsqu'ils existent. Le transport limite ces chaînes à 128, 2 048, 4 096 et 256 octets respectivement ; il ne transfère pas les prototypes ni les propriétés applicatives arbitraires. Ce résumé reste côté serveur et n'est pas enregistré dans le cache.

Dans le navigateur, le composant d'erreur utilise les props déjà rendues par le serveur pendant l'hydratation. Pour une 404 reçue pendant une navigation, il peut exécuter son hook côté client sans `req` ni `res`. Une erreur React lui fournit l'exception du navigateur ; son `statusCode` peut être absent. Le composant `prnext/error`, également accessible par `next/error`, fournit une interface intégrée, les props `statusCode` et `title`, et le hook `getInitialProps` correspondant.

Si le composant d'erreur plante lui aussi, PRNext affiche une réponse de repli bornée. Il ne recommence pas indéfiniment le rendu de `_error`.

## Navigation et routeurs mélangés

Une navigation Pages qui reçoit `notFound` conserve l'état de `_app`, l'URL visible et le snapshot de la route demandée. Elle charge le composant 404 et ses données statiques. Un plantage React remonte `_app` avec `_error`, sans changer de document. Les liens de la page d'erreur permettent de repartir vers une page valide. Les scripts, styles et données respectent [`basePath` et `assetPrefix`](configuration.md#sous-chemin-et-cdn).

Dans un projet qui possède un layout App à la racine, son `not-found` global prend la priorité sur le HTML 404 du Pages Router, y compris lorsque `getServerSideProps` retourne `notFound:true`. Les exceptions serveur des Pages continuent d'utiliser leur page 500 ou `_error`. La réponse App manquante conserve le layout et peut s'hydrater puis naviguer normalement.

## Vérification et limites

Les contrats de référence ont été vérifiés contre Next.js 16.3.5 en production, avec des variantes statiques, `_error` seul, erreurs intégrées et coexistence App/Pages. Les tests couvrent le build, les statuts HTTP, les fonctions de données, les clés de cache, la navigation et les erreurs React. Les détails de protocole internes à Next ne sont pas reproduits à l'octet près.

Un `_app.getInitialProps` personnalisé rend les pages 404/500 sans GSP dynamiques ; celles qui exportent GSP restent dans le cache statique. Le développement PRNext ne possède pas encore l'overlay d'erreur et Fast Refresh de Next.js. L'App Router possède ses propres [frontières `error` et `global-error`](app-errors.md). Les pages d'erreur Pages utilisent aussi le [document personnalisé](document.md). La référence officielle décrit les [pages d'erreur Next.js](https://nextjs.org/docs/pages/building-your-application/routing/custom-error).
