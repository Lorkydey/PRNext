# Document HTML personnalisé

Le Pages Router accepte `pages/_document` ou `src/pages/_document`, en JavaScript ou TypeScript. Ce fichier personnalise le document HTML autour de l'application. Il ne devient pas une route et n'est pas compilé pour le navigateur.

```tsx
import { Html, Head, Main, NextScript } from 'next/document';

export default function MyDocument() {
  return (
    <Html lang="fr">
      <Head>
        <meta name="theme-color" content="#173b31" />
      </Head>
      <body className="application">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
```

Les mêmes exports sont accessibles par `prnext/document`. `Main` insère l'application et `NextScript` les données d'hydratation et le module client. Les attributs `nonce` et `crossOrigin` des composants de document sont transmis aux ressources correspondantes. Les URL des ressources respectent `basePath` et `assetPrefix`.

`Head` de `next/document` contient les éléments communs au document, les éléments collectés par `next/head`, les feuilles de style compilées et les styles retournés par le hook de document. Les métadonnées propres à une page continuent à utiliser `next/head`, qui les met à jour pendant la navigation.

## Collecte des styles pendant le rendu

La classe exportée par défaut possède `Document.getInitialProps`. Un document personnalisé peut surcharger ce hook, enrichir ses résultats et utiliser `ctx.renderPage` pour envelopper l'application ou la page :

```tsx
import Document, {
  Html, Head, Main, NextScript,
  type DocumentContext, type DocumentInitialProps,
} from 'next/document';

export default class MyDocument extends Document {
  static async getInitialProps(
    ctx: DocumentContext,
  ): Promise<DocumentInitialProps> {
    const renderPage = ctx.renderPage;
    ctx.renderPage = () => renderPage({
      enhanceApp: App => App,
      enhanceComponent: Page => Page,
    });
    const initial = await Document.getInitialProps(ctx);
    return {
      ...initial,
      styles: <>{initial.styles}<style>{'body { margin: 0 }'}</style></>,
    };
  }

  render() {
    return <Html lang="fr"><Head /><body><Main /><NextScript /></body></Html>;
  }
}
```

`renderPage` utilise les props déjà chargées : il ne relance pas `getStaticProps` ou `getServerSideProps`. Il retourne le HTML de l'application et les éléments de son head. `ctx.defaultGetInitialProps(ctx)` fournit également les styles initiaux. Les résultats `html`, `head` et `styles` peuvent être adaptés ; les autres props du document restent côté serveur, sauf si le code de l'application les écrit explicitement dans le HTML.

## Exécution et cache

Les pages statiques incluent leur document dès le build. Rust sert ensuite ce HTML sans lancer un worker Node. L'ISR régénère ensemble la page et son document ; les pages d'erreur utilisent aussi le document personnalisé.

Pour le SSR, le contexte expose le chemin de route, la query, `asPath`, la requête, la réponse, l'erreur éventuelle et `AppTree`. Le hook peut modifier les en-têtes de réponse. Chaque rendu dispose de son propre contexte et de ses propres collecteurs.

Une page automatiquement statique n'expose pas `req` et `res` au document. Avec `getStaticProps`, le build utilise une requête canonique ; une génération ISR à froid ou périmée fournit au document la requête qui l'a déclenchée. Le chemin et la query de routage restent canoniques, tandis que `req.url` et les en-têtes reflètent ce demandeur. Les générations simultanées partagent un seul calcul. La régénération explicite par `res.revalidate` ne transmet pas les cookies de l'appelant. Le HTML SSG produit reste partagé entre les visiteurs : lire une requête dans ce hook ne transforme pas une page statique en rendu personnalisé.

Le contexte de requête utilisé par l'ISR est copié uniquement au lancement d'une génération, puis libéré. Il n'est pas enregistré dans le cache. Sa taille est limitée à 64 Kio : le dépassement renvoie une réponse 431 si la réponse attend cette génération ; une version périmée encore utilisable continue à être servie. Une lecture du cache n'effectue pas cette copie.

Une navigation Pages conserve le document existant et ne réexécute pas son hook. Une requête JSON SSR ne rend pas le document. Une requête JSON qui déclenche une génération SSG à froid construit toutefois le HTML et les données destinés au cache.

Seule l'application insérée par `Main` est hydratée. Les événements et l'état React placés ailleurs dans `_document` ne deviennent pas interactifs. Les layouts racines de l'App Router restent responsables de leurs propres balises `html` et `body`.

## Compatibilité

Les tests couvrent les documents fonctionnels et les classes, les extensions de rendu, les styles, les requêtes SSR, le cache et les navigations Chromium. Les contrats sont comparés à Next.js 16.3.5. Les [conventions officielles de Document](https://nextjs.org/docs/pages/building-your-application/routing/custom-document) servent de référence.

Les fonctions `getStaticProps`, `getStaticPaths` et `getServerSideProps` sont réservées aux pages et refusées dans `_document`. Les imports de CSS directement dans `_document` et les imports de `next/document` dans le code client sont également refusés. Le protocole des scripts et l'identifiant racine restent ceux de PRNext ; les bibliothèques qui dépendent des internes de Next plutôt que de ces composants publics ne sont pas automatiquement compatibles.
