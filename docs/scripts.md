# Chargement des scripts

`prnext/script` et `next/script` exposent le même composant et les mêmes types. Les scripts s'exécutent dans le navigateur ; le build et le serveur ne téléchargent pas leur `src` et n'évaluent pas leur contenu.

```tsx
'use client';
import Script from 'prnext/script';

export default function MapWidget() {
  return <>
    <div id="map" />
    <Script
      id="map-sdk"
      src="https://example.com/map-sdk.js"
      strategy="afterInteractive"
      onReady={() => window.dispatchEvent(new Event('map-sdk-ready'))}
    />
  </>;
}
```

Les callbacks de l'App Router demandent un Client Component. Un Server Component peut rendre `Script` avec des props sérialisables, par exemple un `src` ou du JavaScript inline.

## Stratégies

| Stratégie | Pages Router | App Router |
| --- | --- | --- |
| `beforeInteractive` | Déclarer dans `_document`. Le HTML contient les scripts inline dans le head, puis les sources externes différées avant le module d'hydratation | Déclarer dans le layout racine. Le HTML contient une file ; le navigateur exécute chaque entrée dans l'ordre avant de démarrer l'hydratation |
| `afterInteractive` | Valeur par défaut ; chargement après montage client | Chargement après montage ; le HTML peut précharger la source |
| `lazyOnload` | Attend l'événement `load`, puis un créneau d'inactivité | Même comportement ; pas de préchargement serveur de la source |
| `worker` | Expérimental, avec Partytown et le drapeau ci-dessous | Non pris en charge, comme dans la référence Next utilisée |

L'ordre mixte inline/externe de `beforeInteractive` diffère entre les deux routeurs. Pour `inline A`, `externe B`, `inline C`, `externe D`, Pages exécute A, C, B, D ; App exécute A, B, C, D. Un échec réseau de la séquence App arrête les entrées suivantes, mais l'application tente quand même de s'hydrater. Aucun délai artificiel n'est ajouté aux scripts tiers.

Les scripts inline acceptent `children`, y compris un tableau de chaînes, ou `dangerouslySetInnerHTML`. Leur fournir un `id` stable pour éviter une nouvelle exécution lors des remontages. Les scripts contenus dans `_document` sont collectés pendant son rendu, y compris ceux placés après `NextScript`, sans refaire ce rendu.

## Callbacks, cache et attributs

Une source externe n'est insérée qu'une fois par document. Le couple de mécanismes de cache reproduit Next : `id || src` identifie un script chargé, tandis que les composants partageant un `src` réutilisent sa promesse. La navigation SPA conserve ce cache ; un nouveau document repart de zéro. Les éléments script et leurs feuilles de style restent en place après démontage.

`onLoad` reçoit l'événement initial de chargement externe et `this` vaut son élément script. `onReady` sert aussi aux remontages après un chargement réussi. Pour plusieurs composants partageant la même source, le premier obtient `onReady` au chargement ; les autres obtiennent leur `onLoad`, puis `onReady` s'ils sont remontés. Un script inline appelle `onReady` avant son insertion, sans événement `onLoad` initial.

Les erreurs réseau appellent `onError`. Le chargement n'est pas automatiquement réessayé : Next 16.3.5 conserve sa promesse après cet échec et un remontage peut appeler `onLoad` sans refaire la requête. Cette particularité est couverte par les tests de référence. Les callbacks `beforeInteractive` ne constituent pas une API de chargement fiable ; utiliser les stratégies après montage lorsqu'ils sont nécessaires.

Les attributs HTML, `data-*`, `integrity`, `crossOrigin`, `nonce`, `async` et `defer` sont transmis. La source fournie reste inchangée : construire explicitement l'URL publique d'un fichier local lorsque le projet utilise `basePath`. `assetPrefix` déplace les assets du framework, pas les URL tierces.

`stylesheets` accepte des URL de feuilles CSS. L'App Router les préinitialise pendant le SSR ; Pages les charge avec les scripts après montage. React assure leur réutilisation. Cela ne transforme pas une page statique en rendu dynamique.

## CSP

Pour Pages, les scripts rendus dans le document respectent le `nonce` et le `crossOrigin` de `Head`. Le nonce explicite d'un script externe `beforeInteractive` reste prioritaire. Les scripts créés après montage peuvent recevoir leur propre prop `nonce`.

Pour App, le rendu dynamique extrait le premier nonce valide de `script-src`, ou de `default-src` à défaut, dans l'en-tête de requête `Content-Security-Policy` puis son équivalent report-only. Il l'applique aux scripts de démarrage, aux blocs Flight et aux files `beforeInteractive`. Une politique placée uniquement sur la réponse ne fournit pas de nonce au moteur de rendu : le middleware doit aussi la transmettre dans les en-têtes de requête. Une page précompilée ne peut pas recevoir un nonce différent à chaque visite ; utiliser un rendu dynamique pour ce cas.

## Scripts dans un worker

Installer `@builder.io/partytown` dans le projet et activer :

```js
// prnext.config.mjs
export default { experimental: { nextScriptWorkers: true } };
```

```tsx
import Script from 'prnext/script';
export default function Analytics() {
  return <Script id="analytics" strategy="worker" src="/analytics.js" />;
}
```

Le build copie la bibliothèque fournie par le projet vers les assets et embarque son bootstrap dans le manifeste. Le serveur de production n'a pas besoin d'importer Partytown. Les chemins suivent le préfixe d'assets ; une configuration personnalisée `data-partytown-config` reste prioritaire et s'exécute avant le bootstrap. La compatibilité du script avec les API émulées par Partytown reste nécessaire. Le test navigateur utilise Partytown 0.10.3 et vérifie une exécution dans un véritable Web Worker, une mise à jour du DOM et l'absence de sa variable privée dans le thread principal.

Les contrats sont confrontés à Next.js 16.3.5, avec tests [HTTP](../tests/script.test.mjs), [Chromium](../tests/browser/script.spec.mjs), [du chargeur](../packages/prnext/runtime/script.test.mjs) et [du compilateur](../packages/prnext/build/script.test.mjs). Voir également la [référence Script officielle](https://nextjs.org/docs/app/api-reference/components/script).
