# Draft Mode et rendu à la requête

Dans l'App Router, `await draftMode()` depuis `next/headers` ou `prnext/headers` expose `isEnabled`, `enable()` et `disable()`. Les mutations sont autorisées dans les Route Handlers et les Server Actions, avant l'envoi des en-têtes. Lire `isEnabled` dans une page statique renvoie `false` au build sans désactiver sa génération statique.

```ts
import { draftMode } from 'next/headers';

export async function GET() {
  // Vérifier ici l'autorisation CMS propre à l'application.
  (await draftMode()).enable();
  return new Response(null, { status: 307, headers: { location: '/articles' } });
}
```

Dans Pages, `res.setDraftMode({ enable: true })`, `res.setDraftMode({ enable: false })` et `res.clearPreviewData()` pilotent les cookies. `req.draftMode`, `req.preview`, `context.draftMode`, `context.preview` dans GSP/GSSP et `router.isPreview` exposent la prévisualisation. `res.setPreviewData(data, { maxAge, path })` transmet aussi un payload JSON par cookie chiffré et authentifié AES-GCM, limité à 2 Kio après encodage. `req.previewData` et `context.previewData` restituent ce payload, ou `false` si absent/invalide ; le Draft Mode seul expose un objet vide. Les valeurs altérées, expirées ou provenant d'un ancien build sont rejetées. `clearPreviewData` efface les deux cookies ; fournir le même `path` que lors de leur création.

Le cookie `__prerender_bypass` contient un identifiant privé renouvelé à chaque build, même si l'identifiant public du build reste fixe. Rust valide sa valeur avant de contourner les caches HTML, JSON, Flight et Route Handlers. Les cookies invalides utilisent le parcours public normal. Le navigateur reçoit `HttpOnly`, `Path=/`, et en production `Secure; SameSite=None` ; en développement, `SameSite=Lax` sans `Secure` permet les essais locaux.

Une visite de prévisualisation exécute le producteur et évite également les caches persistants `fetch` et `unstable_cache`. Elle ne remplace pas les données publiques en cache. Les réponses et les modifications du cookie restent privées, même si des règles applicatives demandent un cache public. Les formulaires Server Actions actualisent le rendu avec le nouvel état du cookie.

`await connection()` depuis `next/server` ou `prnext/server` force le rendu dynamique App sous le mode automatique. Il n'annule pas les caches de données explicitement demandés. Il est interdit dans `unstable_cache` et `generateStaticParams`, et reste sans effet sous `dynamic='force-static'`.

Les tests couvrent les deux routeurs, HTML/JSON/Flight/HEAD, un handler auparavant statique, les caches de données, l'hydratation, les actions et la rotation de l'identifiant après reconstruction.

Références : [Draft Mode App](https://nextjs.org/docs/app/api-reference/functions/draft-mode), [Draft Mode Pages](https://nextjs.org/docs/pages/guides/draft-mode), [connection](https://nextjs.org/docs/app/api-reference/functions/connection).
