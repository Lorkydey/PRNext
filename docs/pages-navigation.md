# Navigation du Pages Router

Les liens `rustyx/link` et `next/link` changent de page sans recharger le document entre routes du Pages Router. Le navigateur charge les fichiers JavaScript et CSS ainsi que les données nécessaires à la destination. Le composant `_app` reste monté. Un passage entre Pages Router et App Router recharge le document.

```tsx
import Link from 'rustyx/link';
import { useRouter } from 'rustyx/router';

export default function Products() {
  const router = useRouter();
  return <>
    <Link href={{ pathname: '/products/[id]', query: { id: 'book' } }}>
      Voir le livre
    </Link>
    <button onClick={() => router.push('/products?sort=price', undefined, { shallow: true })}>
      Trier
    </button>
  </>;
}
```

Les imports `next/router` et `next/link` utilisent les mêmes adaptateurs. Les clics modifiés, liens externes, téléchargements et autres cibles de fenêtre conservent le comportement du navigateur. `onClick` et `onNavigate` peuvent empêcher la navigation.

## État, historique et événements

`useRouter`, `withRouter` et l'export par défaut du module router donnent accès aux méthodes `push`, `replace`, `back`, `forward`, `reload`, `prefetch` et `beforePopState`. `push` et `replace` acceptent une chaîne ou un objet URL, un alias `as` et les options `shallow` et `scroll`.

`pathname` désigne le motif de la page, par exemple `/products/[id]`. `asPath` conserve le chemin visible, sa recherche et son fragment. `query` contient les paramètres de `href` et les paramètres dynamiques ; les valeurs répétées restent des tableaux. Avec un alias `as`, sa recherche ne remplace pas celle de `href`. Par exemple, `push('/products/[id]', '/products/book?visible=1')` extrait `id: 'book'`, garde `?visible=1` dans `asPath`, mais ne l'ajoute pas à `query` ni aux données demandées.

Avec [`basePath`](configuration.md#sous-chemin-et-cdn), ces propriétés restent sans préfixe ; `router.basePath` indique celui du déploiement. Les liens et méthodes de navigation ajoutent le préfixe aux chemins internes. Une URL absolue garde son origine et son chemin ; une URL de même origine située hors de `basePath` utilise une navigation de document.

L'état du même composant Page est conservé lorsque seuls ses paramètres changent. Un autre composant Page repart avec son propre état initial, tandis que `_app` reste monté. Une application peut demander une remise à zéro en donnant une clé au composant, par exemple `<Component key={router.asPath} {...pageProps} />` dans `_app`.

Les événements disponibles sur `router.events` sont `routeChangeStart`, `beforeHistoryChange`, `routeChangeComplete`, `routeChangeError`, `hashChangeStart` et `hashChangeComplete`, avec `on` et `off`. Une navigation réussie résout sa promesse à `true`. Une navigation remplacée par une plus récente résout à `false` et émet `routeChangeError` avec `error.cancelled === true` ; sa réponse tardive ne peut pas remplacer la nouvelle page.

`shallow: true` sur la même page met à jour le routeur sans relancer ses données. Il ne permet pas de traverser une autre page en réutilisant les anciennes props : la destination reçoit alors ses propres données. Les événements conservent l'option `shallow` demandée.

Un changement de fragment seul utilise les événements de fragment, sans redemander les données de la page. `scroll: false` conserve la position. L'historique permet de revenir et d'avancer entre pages ; `replace` remplace son entrée courante. Si `beforePopState` renvoie `false`, Rustyx laisse l'application gérer la transition : le navigateur a déjà changé son URL, mais le routeur ne remplace pas le composant affiché.

## Données et réécritures

Les données utilisent `/_rustyx/data/{buildId}/chemin.json`, avec l'alias `/_next/data`. La racine devient `index.json` ; un chemin commençant réellement par `/index` reçoit un préfixe d'échappement supplémentaire. Les builds inconnus et les destinations App/API ne sont pas des endpoints de données Pages valides.

Ces endpoints reçoivent `basePath` et restent sur l'origine de l'application. `assetPrefix` déplace seulement les assets, y compris le manifeste de navigation. Les ressources d'un CDN doivent appartenir à l'origine et au répertoire configurés ; leur chargement utilise CORS sans credentials.

Pour `getServerSideProps`, chaque navigation demande un JSON privé, avec les cookies et en-têtes de la requête. Le serveur exécute la fonction de données sans rendre le composant React ni précharger ses composants dynamiques. Le framework diffère aussi l'import de `react-dom/server` jusqu'à une requête nécessitant réellement du HTML ; une application reste libre de l'importer elle-même. Les pages sans fonction de données utilisent des props vides. Lorsqu'aucun middleware, redirect ou rewrite ne peut changer la destination, une route connue charge seulement ses modules et CSS, sans requête JSON ni démarrage de worker pour cette navigation. Pour `getStaticProps`, Rust réutilise les données du [cache ISR](isr.md) ou attend leur génération.

Une visite initiale avec `fallback: true` peut hydrater le shell puis remplacer ses props. Une transition SPA vers ce même chemin attend les données complètes en conservant la page précédente interactive ; elle n'affiche pas le shell de fallback.

Les réécritures natives et le middleware peuvent sélectionner une autre page en conservant l'URL visible. Dans `getServerSideProps`, `req.url` conserve l'URL originale de la requête JSON, y compris son préfixe de données. `resolvedUrl` contient le chemin de destination et la recherche visible originale. `query` inclut les paramètres et les valeurs ajoutées par la réécriture ; ces dernières prennent priorité lors d'un conflit.

Une redirection issue des données peut poursuivre la navigation vers une page interne. Une destination externe utilise une navigation de document. `notFound` affiche la [page 404 personnalisée](pages-errors.md), `_error` ou la page intégrée, en conservant `_app`. Un échec de données ou de chargement ne doit pas laisser une ancienne requête écraser la page courante ; il peut entraîner une navigation de document pour récupérer la réponse serveur.

## Préchargement et ressources

En production, les liens Pages préchargent à proximité du viewport, au survol et au toucher. `prefetch={false}` désactive le déclenchement par le viewport ; le survol reste actif. `router.prefetch` permet un appel explicite. Les requêtes préparent le cache HTTP des modules et feuilles CSS sans exécuter les modules ni appliquer les styles. Elles demandent aussi le JSON des pages `getStaticProps`, mais n'exécutent pas `getServerSideProps` à l'avance. Ce préchargement est désactivé en développement.

Le manifeste public contient uniquement les motifs, URL des bundles et feuilles CSS, identifiants de route et indicateurs SSG/SSR nécessaires au navigateur. Son URL dépend d'un identifiant renouvelé à chaque build, même si `generateBuildId` renvoie toujours la même valeur. Les implémentations des fonctions de données restent absentes des bundles navigateur.

Le préchargement accepte au plus deux tâches actives et conserve huit entrées pendant 30 secondes, avec 2 Mio de JSON par réponse et 8 Mio au total. Ces budgets portent sur les octets encodés : les objets JavaScript ajoutent une consommation variable. Les réponses réécrites, privées ou `no-store` ne sont pas retenues. Une navigation ordinaire accepte un JSON jusqu'à 16 Mio.

Les modules JavaScript importés restent gérés par le cache de modules du navigateur. L'éviction d'une réponse JSON ne décharge pas le code déjà importé. L'attente d'une donnée ou d'un module est bornée à 30 secondes ; abandonner l'attente d'un import natif ne permet pas d'annuler son exécution par le navigateur. Ces limites ne constituent pas un plafond sur les allocations internes de l'application.

## Limites et vérification

Cette navigation ne rend pas Rustyx intégralement compatible avec Next.js. Les [hooks getInitialProps](initial-props.md) des pages et de `_app` sont pris en charge ; l'[i18n Pages](i18n.md) est pris en charge. Le [document personnalisé](document.md) est conservé pendant les navigations Pages. Le SSR Pages reste tamponné. Le développement applique Fast Refresh en conservant l'état lorsque les signatures des composants le permettent ; voir le [compilateur](compiler.md).

Les contrats ont été confrontés à un build de production Next **16.3.5**, avec requêtes HTTP et Chromium : identité de `_app` et de la page, événements, annulation, shallow routing, historique, préchargement, données GSSP et réécritures. Les tests Rustyx couvrent le [manifeste compilé](../packages/rustyx/build/pages-navigation.test.mjs), les [réponses HTTP](../tests/pages-navigation.test.mjs) et les [parcours navigateur](../tests/browser/pages-navigation.spec.mjs). Cela ne garantit pas la parité pour tous les plugins et usages des internes Next.

Références : [`useRouter`](https://nextjs.org/docs/pages/api-reference/functions/use-router), [liens et navigation](https://nextjs.org/docs/pages/building-your-application/routing/linking-and-navigating), [routeur Next 16.3.5](https://github.com/vercel/next.js/blob/v16.3.5/packages/next/src/shared/lib/router/router.ts).
