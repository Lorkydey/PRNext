# Pages statiques App Router

Rustyx produit au build le HTML et le payload Flight des pages App qui peuvent être partagées entre visiteurs. Rust sert ensuite ces deux représentations depuis le disque, sans exécuter React à chaque lecture. Les pages qui dépendent de la requête restent rendues à la demande. Le cache de pages et le [cache de données](caching.md) sont distincts.

```tsx
// app/products/[id]/page.tsx
export const revalidate = 60;

export async function generateStaticParams() {
  return [{ id: 'first' }];
}

export default async function Page({ params }: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const response = await fetch(`https://example.test/products/${id}`, {
    cache: 'force-cache',
    next: { tags: [`product:${id}`] },
  });
  const product = await response.json();
  return <h1>{product.name}</h1>;
}
```

`/products/first` est produit au build. Avec `dynamicParams: true`, valeur ordinaire par défaut, le premier visiteur d'un autre identifiant attend sa génération ; les suivants réutilisent la paire HTML/Flight. Après 60 secondes, une lecture peut servir la version périmée pendant qu'une seule régénération prépare la suivante. Une erreur conserve la dernière version valide. Les en-têtes `x-nextjs-cache: HIT`, `MISS` et `STALE` permettent d'observer ce comportement.

## Choisir les chemins

`generateStaticParams` est exécuté dans les layouts puis dans la page, du parent vers l'enfant. Le générateur enfant reçoit `{ params }` pour chaque résultat parent. Les paramètres ordinaires sont des chaînes ; les catch-all sont des tableaux de chaînes. Les groupes de routes ne figurent pas dans l'URL. Rustyx accepte au plus 10 000 chemins par route et valide les valeurs avant de les encoder.

Les pages à chemin fixe sont candidates au rendu statique automatique. Une page à paramètres devient candidate lorsqu'elle possède un générateur, y compris un générateur retournant `[]`, ou utilise `dynamic: 'force-static'` ou `'error'`. Les combinaisons incomplètes ne créent pas de page au build. `dynamicParams: false` ferme la route aux chemins complets absents des résultats du build, même si la restriction provient d'un layout parent. Les générateurs ne sont pas réexécutés pendant l'ISR.

Ces conventions suivent les contrats de [`generateStaticParams`](https://nextjs.org/docs/app/api-reference/functions/generate-static-params) et de la [configuration des segments](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config). Les [Route Handlers statiques](route-handlers-static.md) utilisent le même stockage, avec leurs propres règles d'activation et un corps unique.

## Données dépendant du visiteur

En mode `dynamic: 'auto'`, l'utilisation de `headers()`, `cookies()`, des valeurs `searchParams` d'une page serveur, de `unstable_noStore()` ou d'un fetch explicitement non caché fait sortir la page du rendu statique. Attraper l'erreur interne de détection dans le code applicatif ne suffit pas à rendre la page partageable. Les paramètres de recherche et en-têtes du premier visiteur ne sont jamais utilisés pour remplir une page commune.

Si une page déjà publiée utilise ensuite une API dynamique pendant sa régénération, le calcul échoue et la dernière version valide reste disponible.

En mode `auto`, un fetch sans option peut participer au rendu statique du build ; cela ne crée pas à lui seul une entrée persistante dans le cache de données. À l'exécution d'une page dynamique, ce même fetch reste non persistant. Le mode `dynamic: 'error'` peut imposer une persistance, comme décrit dans le [guide du cache](caching.md). `cache: 'no-store'` ou `next.revalidate: 0` demande explicitement une donnée dynamique.

`dynamic: 'force-dynamic'` et, en mode ordinaire, `revalidate: 0` demandent un rendu par requête. `dynamic: 'error'` refuse l'usage de données dynamiques au lieu de transformer silencieusement la page en SSR. `dynamic: 'force-static'` rend `headers()`, `cookies()` et les paramètres de recherche vides. Les hooks client et les props `searchParams` des pages Client retrouvent les paramètres réels après hydratation et pendant la navigation, sauf en mode `force-static`.

Les configurations acceptées comprennent les quatre valeurs de `dynamic`, `dynamicParams`, `revalidate: false` ou un entier positif ou nul, et les sept politiques `fetchCache` : `auto`, `default-cache`, `only-cache`, `force-cache`, `default-no-store`, `only-no-store`, `force-no-store`. Les garanties incompatibles entre layouts/pages sont refusées ; une politique `force-*` s'applique à toute la route. Le minimum des durées des segments et de leurs données cachées détermine la durée de la page. Le [runtime Edge](edge-runtime.md) reste dynamique ; le [pré-rendu Cache Components](cache-components.md) utilise son propre parcours.

## Invalidation et actions

`revalidateTag`, `updateTag` et `revalidatePath` invalident aussi les pages App concernées. Les tags et associations de chemins sont collectés pendant le rendu, y compris pour les versions produites au build. Une page sans fetch reste invalidable par son chemin. Une donnée partagée peut entraîner l'invalidation des autres pages qui la consomment.

`revalidateTag(tag, 'max')` permet de servir l'ancienne page pendant son renouvellement. `updateTag`, réservé aux Server Actions, et `revalidateTag(tag, { expire: 0 })` imposent une prochaine génération fraîche. `revalidatePath` applique cette expiration au chemin ou au motif demandé. Une génération commencée avant l'invalidation ne peut pas publier ensuite son ancien résultat ; une requête GET peut refaire ce calcul une fois. Une mutation Server Action n'est jamais rejouée par ce mécanisme.

Les POST d'actions contournent le cache de pages. Même sur une route `force-static`, l'action reçoit les vrais cookies et en-têtes de la requête ; le rendu statique conserve ses valeurs vides. Leur arbre actualisé attend les invalidations ; les formulaires sans JavaScript restent utilisables. Les redirections conservent leur statut HTTP pour le HTML ; la représentation Flight transporte le contrôle de navigation React avec un statut 200.

## Persistance et limites

Le stockage `.rustyx-cache/pages/` est commun aux caches [Pages Router](isr.md) et App Router, avec un espace par build. Les versions calculées, ainsi que les invalidations des versions initiales, survivent à un redémarrage. Un nouveau build fournit ses propres versions initiales. Les données cachées séparément peuvent survivre au changement de build.

HTML et Flight sont limités à 16 Mio chacun, précompressés lorsque cela réduit leur taille, puis publiés ensemble. Le budget commun est de 256 Mio et 4 096 entrées, variantes gzip comprises ; les fichiers encore consommés et les calculs en cours s'y ajoutent temporairement. Une route retient au plus 128 tags et 128 associations de chemins dans des métadonnées bornées. Dépasser ces limites échoue sans remplacer la dernière version valide.

Un worker de maintenance Node et son thread RSC démarrent à la demande et s'arrêtent après 30 secondes d'inactivité. Cinq générations au maximum sont admises, avec regroupement des demandes du même chemin. La coordination reste locale au processus : plusieurs instances partageant un dossier ne disposent pas encore de baux de pages communs. Ces budgets ne plafonnent pas les allocations internes de React ou des modules npm.

En développement, les pages sont recalculées et les générateurs réévalués ; le cache de production n'est pas réutilisé. La démo `/static/welcome` de `examples/app` expire après dix secondes et `/static/another-page` montre la génération d'un nouveau chemin. Utiliser un build de production pour observer ce cache.

Les tests HTTP et Chromium couvrent les chemins imbriqués, les invalidations, les redémarrages, les actions et les transitions entre pages cachées. `npm run bench:app-static` mesure séparément HTML, Flight, premier calcul et arrêt du worker ; il ne compare pas Rustyx à Next.js. Les [résultats locaux](performance.md#app-html-et-flight-servis-par-rust) précisent les conditions.
