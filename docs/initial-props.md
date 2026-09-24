# getInitialProps et App personnalisé

Le Pages Router accepte `getInitialProps` sur le composant exporté par une page et sur `pages/_app`. `next/app` et `rustyx/app` exportent la classe App et les types `AppContext`, `AppInitialProps` et `AppProps`.

```tsx
import type { NextPage, NextPageContext } from 'rustyx';

const Page: NextPage<{ name: string }> = ({ name }) => <h1>{name}</h1>;

Page.getInitialProps = async (ctx: NextPageContext) => ({
  name: String(ctx.query.name || 'Rustyx'),
});

export default Page;
```

Le premier chargement exécute le hook sur le serveur et hydrate ses résultats dans le navigateur. Une navigation vers cette page exécute ensuite le hook dans le navigateur. `pathname`, `query`, `asPath` et `AppTree` sont disponibles dans les deux cas ; `req` et `res` sont propres au serveur. `err` contient l'erreur pendant le traitement d'une page d'erreur. Les props retournées sont publiques, puisqu'elles doivent parvenir au navigateur.

## Composer les hooks dans _app

```tsx
import App, { type AppContext, type AppProps } from 'next/app';

export default function MyApp({
  Component, pageProps, language,
}: AppProps & { language: string }) {
  return <main lang={language}><Component {...pageProps} /></main>;
}

MyApp.getInitialProps = async (context: AppContext) => {
  const initial = await App.getInitialProps(context);
  return { ...initial, language: 'fr' };
};
```

Le contexte App contient `Component`, `router`, `AppTree` et `ctx`, ce dernier étant le contexte de la page. L'implémentation par défaut de `App.getInitialProps` appelle le hook de la page. Un App personnalisé choisit s'il délègue cet appel. Un App sans hook utilise la délégation par défaut.

Les champs retournés à côté de `pageProps` deviennent des props de l'App. Lorsque la page utilise `getStaticProps` ou `getServerSideProps`, ces fonctions s'exécutent après le hook App : leurs props complètent `pageProps` et remplacent les valeurs des clés communes. Les champs propres à l'App sont conservés.

## Exécution et optimisation statique

| Situation | Exécution des hooks |
| --- | --- |
| Chargement HTML d'une page GIP | Serveur ; l'hydratation réutilise les résultats |
| Navigation vers une page sans GSP/GSSP | Navigateur |
| Navigation vers une page GSSP | Hook App puis GSSP sur le serveur |
| Page GSP | Hook App puis GSP au build ou pendant l'ISR ; navigation avec les données en cache |
| Préchargement d'une page GIP | Aucun hook GIP |
| Navigation shallow ou changement d'ancre | Aucun hook GIP |
| Middleware correspondant à une navigation GIP | Rendu serveur avec ses hooks, puis hooks navigateur |

Le hook d'une page désactive son optimisation statique automatique. Un hook App personnalisé la désactive pour les pages sans `getStaticProps`, y compris les pages d'erreur sans GSP. Une classe qui hérite du hook App par défaut conserve cette optimisation. Rustyx compare les propriétés `getInitialProps` et `origGetInitialProps`, comme Next ; copier uniquement le hook sur une autre fonction compte donc comme une personnalisation.

Les pages GSP restent servies et régénérées par le cache Rust. À froid, le contexte App reçoit la requête ayant déclenché la génération, tandis que `query` et `asPath` restent canoniques. Les résultats sont partagés par le cache, comme ceux de GSP. La revalidation explicite n'hérite pas des cookies de son appelant.

Une page ne peut pas associer son propre `getInitialProps` à GSP ou GSSP. Le hook App est autorisé avec ces fonctions. Les hooks doivent retourner des props ; un résultat absent est accepté lorsque la réponse a déjà été terminée explicitement avec `res.end`.

## Navigation, erreurs et limites

L'état React de `_app` est conservé pendant les navigations. Les résultats d'une navigation annulée ne peuvent pas remplacer la page courante. Le framework borne à huit le nombre d'exécutions GIP non terminées dans son contrôleur ; il peut ignorer un résultat tardif, mais ne peut pas arrêter une promesse arbitraire créée par l'application.

Une erreur de chargement GIP passe par `_error` et conserve l'App monté ; la promesse de navigation rejette. Une erreur de rendu React utilise la frontière d'erreur et remonte l'App. Les appels de récupération et leurs contextes suivent le comportement de production vérifié avec Next.js 16.3.5, y compris les deux passages dans le hook d'erreur après un échec GIP.

Avec `basePath`, le `asPath` des hooks de navigation client inclut le préfixe public ; le contexte serveur et `router.asPath` utilisent le chemin logique. Pendant le chargement client, le routeur fourni au hook App représente encore la page précédente. `AppTree` conserve le composant initial du document et reçoit le routeur courant.

Les requêtes directes vers une URL de données GIP produisent du HTML, contrairement aux pages GSP/GSSP. Pour sa navigation, Rustyx dispose aussi d'une réponse interne de résolution de route : les réécritures de configuration évitent l'exécution serveur des hooks, tandis qu'un middleware correspondant conserve les effets du rendu serveur de Next. Les détails du protocole interne restent propres à Rustyx.

Si le hook serveur termine une réponse 2xx derrière un middleware, la navigation ignore son corps et appelle le hook client ; les cookies de la réponse sont appliqués. Le navigateur lit ce corps par blocs, sans assembler de chaîne HTML/JSON, avec les limites de taille et d'annulation habituelles. Une redirection HTTP du hook est suivie par la requête réseau. Lorsque la route originale est connue, le navigateur conserve cette route et son App monté, comme Next. Lorsque seule une réécriture intermédiaire permettait de résoudre un alias, sa perte lors de la redirection peut imposer une navigation de document. Les visites HTTP directes conservent leurs statuts et redirections habituels.

Cette prise en charge concerne le Pages Router. Elle n'ajoute pas GIP aux composants de l'App Router ni aux composants imbriqués. Les références officielles décrivent [`getInitialProps`](https://nextjs.org/docs/pages/api-reference/functions/get-initial-props) et [l'App personnalisé](https://nextjs.org/docs/pages/building-your-application/routing/custom-app).
