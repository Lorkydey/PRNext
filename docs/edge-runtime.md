# Runtime Edge

Les pages, layouts et Route Handlers App peuvent exporter `runtime = 'edge'`. Un fichier `middleware` peut déclarer `runtime: 'edge'` ou `'experimental-edge'` dans sa configuration statique, ou exporter cette valeur directement. Ces entrées exécutent leur code applicatif dans un contexte V8 Web fourni par `@edge-runtime/vm` 5.0.0, au sein d'un worker Node. `proxy` reste sur Node et refuse un runtime explicite. Un middleware sans runtime explicite conserve le défaut Node de Rustyx.

```tsx
import { cookies } from 'next/headers';

export const runtime = 'edge';

export default async function Page() {
  const visitor = (await cookies()).get('visitor')?.value ?? 'anonymous';
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(visitor)
  );
  return <main>{visitor}: {digest.byteLength} bytes</main>;
}
```

Le runtime fournit Request/Response, fetch, les flux Web, les formulaires multipart et fichiers, les encodages, les URL, les timers et WebCrypto. `EdgeRuntime` identifie le contexte ; `process.env.NEXT_RUNTIME` vaut `'edge'`. Les variables d'environnement restent accessibles dans une copie de `process.env`. Les globals Node `Buffer`, `require` et `process.versions` sont absents. `AsyncLocalStorage` est fourni comme polyfill du framework.

## Compilation et rendu React

Le build regroupe les dépendances npm ESM et le CommonJS statiquement analysable avec les conditions `edge-light`, `worker` et `browser`. Les appels `require('chemin-littéral')`, `module.exports` et `exports` sont précompilés dans le bundle ; aucun `require` Node n'est exposé dans la VM. Les imports dynamiques littéraux et le top-level await fonctionnent. Le graphe transitif refuse les modules internes Node, les addons natifs, les `require` dynamiques ou utilisés comme valeurs, `module.require`, les chemins d'import dynamiques, `eval`, `new Function` et la compilation dynamique de WebAssembly. V8 désactive également la génération de code dans le contexte. Ces restrictions définissent un contrat d'API : cette VM ne constitue pas une frontière de sécurité pour du code non fiable.

Le runtime Edge d'un layout se transmet à ses pages. Les fonctions applicatives des Server Components et générateurs de métadonnées s'exécutent dans la VM RSC. Le code applicatif des Client Components s'exécute lui aussi en VM pour son rendu HTML serveur, puis dans le navigateur pour l'hydratation. React, JSX et les références de composants passent par des adaptateurs contrôlés du framework ; l'orchestration du rendu et l'encodage Flight restent dans le worker Node.

Un composant client partagé avec une route Node conserve deux entrées SSR distinctes. Choisir Edge pour une route ne modifie donc pas le contexte SSR des routes Node. Date, Map, Set, FormData, tableaux typés et erreurs utilisent les identités nécessaires au sérialiseur Flight hôte. La navigation App, les paramètres, les métadonnées, `notFound`, les hooks client et la conservation d'état des layouts suivent le chemin habituel du routeur.

Les styles globaux et CSS/Sass Modules importés par les pages et layouts Edge sont collectés pour le navigateur. La VM reçoit uniquement les identifiants de classes des modules ; les feuilles de style ne s'y exécutent pas. Les styles d'un Server Component Edge sans composant client correspondant sont aussi publiés. Les tests navigateur contrôlent leurs couleurs avec les backends esbuild et webpack, avant et après navigation. Les imports CSS d'un Route Handler Edge restent refusés.

Pour limiter la RAM, les bundles React réutilisent au plus deux contextes par worker et build : un pour RSC et un pour SSR, créés à la demande. Chaque bundle garde ses propres variables dans une factory lexicale ; les contextes de requête restent séparés. Les entrées middleware et handlers disposent de leur contexte réutilisé après le premier import. La sortie serveur contient le fournisseur VM compilé, ses licences et les fichiers `.edge.js` ; une installation npm supplémentaire de ce fournisseur n'est pas nécessaire au déploiement, y compris avec `output:'standalone'`.

## Adaptateurs et transport

`next/server` et `rustyx/server` fournissent NextRequest, NextResponse, NextURL et `connection`. `headers`, `cookies` et `draftMode` conservent le contexte de requête, même pendant des appels concurrents. Les contrôles de navigation (`redirect`, `permanentRedirect`, `notFound`, `unstable_rethrow`) et `revalidateTag`, `revalidatePath`, `unstable_noStore` réutilisent les adaptateurs hôtes. Les imports du framework non pris en charge échouent au build.

Les cookies, remplacements d'en-têtes, réécritures, réponses progressives et `waitUntil` borné d'un middleware passent par le transport natif existant. `fetch(Request)` conserve les options Web et les métadonnées `url`, `redirected`, `type` de la réponse, y compris après `clone()`.

Le routage HTTP, les fichiers et les caches natifs restent en Rust. L'exécution JavaScript et les API Web restent V8 dans Node : ce support ne remplace pas le moteur JavaScript par un moteur Rust et ne fournit pas un déploiement géographique Edge.

## Limites actuelles

- Les pages et handlers Edge utilisent le rendu dynamique. La configuration explicite de génération statique/ISR est refusée, notamment `revalidate`, `dynamic:'force-static'` et `dynamic:'error'`. Leurs fetch explicitement mis en cache peuvent utiliser le cache persistant Rust, avec tags et invalidation. Un `dynamic:'force-dynamic'` explicite conserve sa politique sans cache.
- Les Cache Components Edge sont refusés au build, conformément à la [restriction Node de Next](https://nextjs.org/docs/app/getting-started/partial-prerendering). Le pré-rendu partiel n'est pas disponible pour ces routes. Les pages du Pages Router n'ont pas de runtime Edge.
- Les packages CommonJS exigeant des API Node ou un chargement dynamique, modules internes Node et addons natifs exigent le runtime Node. Le CommonJS précompilable utilisant seulement des API Web est accepté.
- Les API Web sortantes n'ajoutent pas de serveur HTTP upgrade/WebSocket ni de sandbox de sécurité. Les limites de concurrence, corps et délais des workers restent applicables.

## Validation

`tests/edge-runtime.test.mjs` couvre le HTTP réel, les identités concurrentes, les conditions npm ESM, le top-level await, la crypto, les uploads multipart, cookies, réécritures, flux progressifs, travaux de fond et métadonnées fetch clonées. `tests/edge-standalone.test.mjs` lance le paquet après suppression du projet et de son installation npm.

`tests/edge-pages.test.mjs` vérifie les pages et layouts VM, les métadonnées, les valeurs Flight, `notFound`, les composants partagés avec Node et la réutilisation des contextes RSC/SSR entre plusieurs bundles sans mélanger leurs variables lexicales. `tests/browser/edge-pages.spec.mjs` valide l'hydratation, les compteurs, la navigation et le refresh sans rechargement. `packages/rustyx/build/edge.test.mjs` couvre les refus de dépendances transitives, d'Actions hors graphes React, de Cache Components et d'options ISR.

Références : [runtime Edge de Next](https://nextjs.org/docs/app/api-reference/edge), [VM Edge de Vercel](https://edge-runtime.vercel.app/packages/vm).

Les pages App Edge peuvent désormais utiliser des Server Actions : références React officielles, RPC, formulaires natifs, cookies et captures chiffrées. Les fonctions compilées sont invoquées dans leur VM Web ; le protocole Flight et le chiffrement passent par les services du runtime. Un même module d’action peut être partagé entre des pages Node et Edge : le build produit une entrée par runtime tout en conservant une référence publique commune. Le décodeur sélectionne l’entrée Edge d’après la configuration serveur de la page appelée, jamais d’après un paramètre client. Les imports effectués par des composants client sont également découverts pendant le SSR. Les variantes ont des namespaces et des variables globales distincts ; `process.env.NEXT_RUNTIME` est compilé avec la valeur propre à chaque cible. Les Cache Components Edge, Pages Edge et ISR Edge restent hors du contrat.

En développement, les bundles Edge conservent les sourcemaps JS/TSX après validation et encapsulation dans leur factory asynchrone. Les sources relatives sont ancrées sur le projet ; la suppression des exports conserve les coordonnées et l’ajout du wrapper décale la carte d’une ligne.
