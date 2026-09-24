# Bugs corrigés : styles dans les pages Edge

**Avant correction :** le projet `examples/next-migration/boutique` compilait et fonctionnait avec Next 16.3.5. Rustyx refusait sa compilation :

```text
Rustyx: app/layout.jsx:1: ../styles/site.css cannot run in the Edge Runtime.
```

Le layout racine importe un CSS global et une page enfant `/edge` déclare `export const runtime = 'edge'`. L'action de cette page et celle d'une page Node sont partagées. Le CSS est destiné au navigateur ; Next accepte cette combinaison.

Le projet `boutique-node` reproduit exactement la boutique en remplaçant seulement la déclaration de runtime par `nodejs` (et le nom du package). Avant correction, il compilait et exécutait les scénarios avec les deux moteurs : cela a permis d'isoler le déclencheur Edge. Après correction, la boutique d'origine est également testée sans ce contournement.

## Cause identifiée dans le code

Dans `packages/rustyx/build/app.mjs`, `edgeGraphPlugin` intercepte les imports CSS globaux et appelle `esbuild.resolve` avec `pluginData.rustyxResolvingCss=true`. Lors de cette résolution récursive, son propre hook CSS se désactive pour éviter une boucle. Le résolveur générique de `packages/rustyx/build/edge.mjs` reçoit alors le même import et rejette les extensions `.css`, `.scss` et `.sass` sans distinguer cette résolution interne de CSS d'un import réellement exécuté dans la VM.

La collecte du CSS et son remplacement par un module vide n'aboutissaient donc jamais. Le résolveur autorise maintenant uniquement la résolution interne de styles dans un graphe React Edge. Les imports CSS dans les Route Handlers Edge restent refusés, ainsi que les modules Node et les autres imports interdits.

Un second défaut a été reproduit par un test navigateur : un Sass Module importé uniquement par un Server Component Edge produisait ses classes sans publier la feuille de style correspondante. Le graphe Edge enregistre maintenant aussi ces modules dans les styles destinés au navigateur, tout en laissant le plugin CSS Modules fournir leurs identifiants.

Les tests vérifient le CSS global sur Edge et Node, les couleurs Sass Modules après navigation, l'hydratation et la conservation de l'état, avec les deux backends esbuild et webpack. Les restrictions des handlers sont vérifiées séparément.

## Reproduction

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next node scripts/compare-migration-sites.mjs
```

Le runner compile les mêmes sources dans deux copies séparées et enregistre leurs empreintes dans `results.json`. Les mesures de la campagne précédente, qui contiennent le blocage, sont conservées dans `before-fix-results.json`. Ajouter `MIGRATION_BENCH=1` pour mesurer aussi le CPU, la RAM sous charge et le débit.

Les corrections portent sur `packages/rustyx/build/edge.mjs` et `packages/rustyx/build/app.mjs`. Aucun cache mémoire permanent supplémentaire n'est ajouté au serveur de production.

Les parcours PPR, cookies et routes interceptées du tableau de bord passent dans leur périmètre testé. Cela ne valide pas tous les cas PPR. Les conventions utilisées suivent les documents officiels [Cache Components](https://nextjs.org/docs/app/getting-started/partial-prerendering) et [routes parallèles](https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes).
