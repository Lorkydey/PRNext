# Imports dynamiques de composants

`rustyx/dynamic` et `next/dynamic` proposent le même adaptateur dans Rustyx. Le compilateur conserve des chunks JavaScript séparés et choisit le runtime adapté au Pages Router ou à l'App Router. Les modules locaux, les exports nommés et les packages npm compatibles avec leur environnement peuvent être chargés ainsi.

## Pages Router

Déclarer le composant à la portée du module, puis lui transmettre ses props normalement :

```tsx
import dynamic from 'rustyx/dynamic';

const Profile = dynamic<{ name: string }>(
  () => import('../components/Profile').then(module => module.Profile),
  { loading: () => <p>Chargement du profil…</p> },
);

export default function Page() {
  return <Profile name="Ada" />;
}
```

Le Pages Router accepte aussi `dynamic({ loader: () => import('./Widget'), loading: Loading })` et la forme historique `dynamic(import('./Widget'))`. Pour cette dernière, le compilateur diffère l'appel `import()` ; la forme avec fonction reste préférable pour rendre ce comportement visible dans le code.

Avant le rendu HTML, le serveur initialise les déclarations dynamiques avec SSR des modules déjà importés, y compris celles dont le composant ne sera finalement pas affiché. Les imports imbriqués sont également préparés. Le HTML ne transmet ensuite que les identifiants des composants effectivement rendus. Le navigateur attend ces composants avant l'hydratation ; une branche conditionnelle non rendue conserve son chargement différé. Ce contrat suit le [runtime Pages de Next.js 16.3.5](https://github.com/vercel/next.js/blob/v16.3.5/packages/next/src/shared/lib/dynamic.tsx) et son [registre de chargement](https://github.com/vercel/next.js/blob/v16.3.5/packages/next/src/shared/lib/loadable.shared-runtime.tsx).

`ssr: false` empêche l'exécution du loader et du module chargé sur le serveur. Si le composant est rendu dans le HTML initial, son composant `loading` fournit le contenu de remplacement ; sans JavaScript, ce contenu reste affiché.

Les options Pages `delay` et `timeout`, exprimées en millisecondes, alimentent les props de `loading`. Le délai par défaut est 200 ms. `delay` contrôle `pastDelay` ; `timeout` contrôle `timedOut` et n'annule pas l'import. Le composant de chargement décide de ce qu'il affiche :

```tsx
const Editor = dynamic(() => import('../components/Editor'), {
  ssr: false,
  delay: 200,
  timeout: 10_000,
  loading({ error, retry, pastDelay, timedOut }) {
    if (error) return <button onClick={() => retry?.()}>Réessayer</button>;
    if (!pastDelay) return null;
    return <p>{timedOut ? 'Chargement toujours en cours…' : 'Chargement…'}</p>;
  },
});
```

`loading` reçoit aussi `isLoading`. `retry` relance le loader côté navigateur ; aucune relance automatique n'est ajoutée. Une erreur pendant le préchargement SSR Pages fait échouer le rendu ou le build statique.

## App Router

Utiliser la forme `dynamic(() => import('./Component'), options)`. L'adaptateur emploie `React.lazy` et Suspense : une option `loading` crée un fallback local ; sinon, le composant utilise la frontière Suspense qui l'entoure. Les imports de Server Components asynchrones et les références aux Client Components traversent le protocole Flight habituel. Ces comportements suivent le [runtime App de Next.js 16.3.5](https://github.com/vercel/next.js/blob/v16.3.5/packages/next/src/shared/lib/lazy-dynamic/loadable.tsx).

Un Server Component peut charger un autre composant serveur et afficher son fallback pendant l'import :

```tsx
import load from 'rustyx/dynamic';
import { Suspense } from 'react';

const Metrics = load(() => import('./Metrics'));

export default function Page() {
  return <Suspense fallback={<p>Lecture des mesures…</p>}><Metrics /></Suspense>;
}
```

`ssr: false` appartient à un Client Component. Une déclaration explicite dans un Server Component est refusée au build avec un diagnostic demandant de déplacer le composant derrière une frontière `'use client'`. Par exemple, un panneau qui utilise `window` peut être ouvert après un clic :

```tsx
'use client';

import dynamic from 'rustyx/dynamic';
import { useState } from 'react';

const Chart = dynamic(() => import('./Chart'), {
  ssr: false,
  loading: () => <p>Chargement du graphique…</p>,
});

export default function ChartPanel() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Afficher</button>{open && <Chart />}</>;
}
```

L'App Router ne reprend pas les options Pages `delay`, `timeout` ou le callback `retry` de `dynamic`. Une erreur d'import dans le navigateur atteint la frontière React, `error.js` ou `global-error` correspondante. Pendant le SSR d'un Client Component, une erreur récupérable couverte par Suspense conserve le fallback et le statut 200 ; le réessai navigateur peut ensuite atteindre sa frontière d'erreur. Sans cette frontière Suspense, une erreur précoce produit un document vide 500 avec le Flight original, puis le navigateur retente l'arbre et choisit sa frontière. Les [règles de récupération App](app-errors.md) décrivent aussi les callbacks `reset` et `retry` des composants d'erreur. La génération statique et l'ISR refusent ces erreurs au lieu de conserver le fallback comme page réussie.

## Chunks, CSS et limites

Un module atteint uniquement par un import dynamique conditionnel reste dans un chunk JavaScript distinct, demandé lors de son utilisation. Les dépendances partagées peuvent déjà être chargées par d'autres composants. Les tests navigateur contrôlent les requêtes de chunks avant et après interaction, ainsi que leur exécution et l'état des layouts.

Le CSS global et les CSS Modules de ces composants restent inclus dans les feuilles existantes des routes. Le chargement du JavaScript est différé ; celui des styles n'est pas isolé au premier affichage du composant. Les chunks conservent les URL d'assets, la compression et la politique de cache ordinaires du build.

Les chemins `import()` reconnus dans un loader doivent être littéraux : `import(variable)` est refusé. Les exports nommés via `.then(module => module.Named)` et les loaders contenant une logique de chargement ou de réessai sont acceptés. Pour conserver l'analyse et le préchargement, utiliser un import direct de `dynamic`, déclarer le composant au niveau du module et garder ses options lisibles statiquement. Les wrappers arbitraires et réexportations masquant cet appel ne font pas partie du contrat validé. Les formes objet et Promise décrites plus haut sont propres au Pages Router ; dans l'App Router, employer la fonction loader. Les [guides Next Pages](https://nextjs.org/docs/pages/guides/lazy-loading) et [App](https://nextjs.org/docs/app/guides/lazy-loading) décrivent ces usages.

L'ancienne option `suspense: true` n'active pas un mode supplémentaire et n'est pas exposée dans les types publics, conformément au comportement vérifié sur Next.js 16.3.5. Pour l'App Router, utiliser une frontière `<Suspense>` ou l'option `loading`.

Les modules chargés sont conservés par le runtime JavaScript et peuvent contenir un état persistant par worker. Cette fonctionnalité ne constitue ni un plafond de mémoire ni une garantie générale de performance. La compatibilité intégrale Next.js reste incomplète ; consulter la [matrice](compatibility.md).

## Vérification

Les deux applications de démonstration proposent une page `/dynamic` : une checklist interactive se charge après un clic sur « Open checklist ». Voir les exemples [App Router](../examples/app/app/dynamic/launcher.tsx) et [Pages Router](../examples/basic/pages/dynamic.tsx). `npm run test:types` vérifie les types publics et les deux démos.

Les [tests du compilateur](../packages/rustyx/build/dynamic.test.mjs) couvrent l'identité des modules, les formes de loader, l'exclusion du code navigateur du serveur, les styles, le déplacement des builds et les erreurs de compilation. Les [tests du runtime](../packages/rustyx/runtime/dynamic.test.mjs), [HTTP](../tests/dynamic.test.mjs) et [Chromium](../tests/browser/dynamic.spec.mjs) couvrent le SSR, le streaming, l'hydratation, les chunks conditionnels, les erreurs et les réessais. Les différences Pages/App ont été confrontées aux sources et à des exécutions directes de Next.js 16.3.5.
