# Erreurs de l'App Router

`error.js` fournit une frontière React pour un segment et ses enfants. Elle ne protège pas le layout ou le template placé au-dessus d'elle dans le même segment. `app/global-error.js` protège l'arbre complet, y compris le layout racine ; son interface remplace le document et doit définir ses propres éléments `<html>` et `<body>`.

Les variantes `.jsx`, `.ts` et `.tsx` sont reconnues, ainsi que `src/app/global-error.*`. Seul le fichier à la racine du dossier App est sélectionné ; un `global-error` imbriqué dans une route ou un groupe ne crée pas une frontière locale. Les composants d'erreur doivent déclarer `'use client'`.

```tsx
// app/global-error.tsx
'use client';

import './global-error.css';

export default function GlobalError({ error, retry }: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <html lang="fr">
    <head><title>Page indisponible</title></head>
    <body>
      <h1>La page n'a pas pu être affichée</h1>
      {error.digest && <p>Référence : {error.digest}</p>}
      <button onClick={retry}>Réessayer</button>
    </body>
  </html>;
}
```

## Rendu et confidentialité

Si une erreur empêche le rendu du document initial, le serveur répond 500 avec un document vide et le Flight original. Les métadonnées déjà disponibles sont conservées, avec `robots:noindex`. Le serveur ne rend pas le composant `error` ou `global-error` dans ce document. Le navigateur lit le Flight et affiche la frontière correspondant réellement au composant en échec.

Lorsqu'une frontière Suspense permet de rendre un document valide, la réponse HTML GET conserve le statut 200, même si l'erreur est déjà connue avant son envoi. Après l'envoi, le statut initial reste également inchangé. Le HTML conserve le shell et son chargement ; l'erreur transmise par Flight déclenche ensuite l'interface cliente. Sans JavaScript, le document de secours reste vide et le shell Suspense reste affiché.

Ce chemin ne réexécute pas les layouts, pages ou mutations pour fabriquer un fallback serveur. Les tests comptent leurs appels, en plus de vérifier les réponses et l'interface navigateur.

Une erreur Server Component reçoit un message public en production et un `digest` permettant de retrouver les journaux serveur. Les détails restent disponibles en développement. Une erreur lancée dans le navigateur conserve son objet et son message. Les props que le code applicatif sérialise volontairement restent publiques.

## Réessayer et naviguer

Les frontières locales et globales reçoivent deux callbacks distincts :

- `reset()` efface l'état d'erreur et retente le même arbre, sans requête serveur. Il peut récupérer une erreur cliente temporaire. Un Flight déjà rejeté échoue de nouveau.
- `retry()` demande un nouveau Flight et retente le rendu. Il permet de récupérer après correction d'une cause serveur.

Le composant global conserve l'accès à `useRouter` et aux liens. Une nouvelle navigation peut remplacer son modèle en échec. Le layout normal est alors remonté : son ancien état React a été retiré avec l'interface défaillante. Les frontières locales conservent les layouts qui les entourent.

Si `global-error` plante lui aussi, ou si aucun fichier personnalisé n'existe, une dernière frontière affiche l'interface intégrée. Elle ne réessaie pas le fallback personnalisé indéfiniment et n'affiche pas le message privé de l'exception.

## Styles et métadonnées

Le CSS importé par `global-error` possède sa propre feuille, chargée pour ce fallback. Cette séparation comprend ses imports dynamiques côté navigateur. Le document vide envoyé après un échec précoce n'inclut pas les styles du layout. Flight transmet aussi les feuilles normales pour les charger lorsque le navigateur peut afficher le layout, avec une frontière locale ou après récupération. Les feuilles déjà chargées avant une erreur cliente restent présentes, comme dans le comportement de référence.

Le composant peut rendre `<title>` et ses autres balises. Les exports `metadata` et `generateMetadata` de `global-error` sont acceptés mais ignorés ; les métadonnées de route continuent à provenir des layouts et pages. Les URL des styles et modules respectent `basePath` et `assetPrefix`.

## Bornes et vérification

Le Flight d'origine est transmis sans rejouer le rendu. Le chemin de récupération progressive conserve le contrôle de consommation et les limites existantes du transport. Le document et les flux restent bornés à 16 Mio ; les délais de rendu et l'annulation s'appliquent aussi aux métadonnées de récupération. Une erreur de génération statique ou ISR reste un échec et ne remplace pas une page valide par un fallback.

Les contrats ont été confrontés à Next.js 16.3.5 en production et en développement. Rustyx ne possède pas encore son overlay de développement ni Fast Refresh. Voir les tests [HTTP](../tests/global-error.test.mjs), [Chromium](../tests/browser/global-error.spec.mjs), [de récupération HTML](../packages/rustyx/runtime/app-recovery.test.mjs) et la [référence Next](https://nextjs.org/docs/app/api-reference/file-conventions/error).
