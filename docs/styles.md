# CSS, PostCSS, Tailwind et Sass

Les transformations de styles s'exécutent au build. Les réponses SSR et les pages cachées ne chargent aucun compilateur CSS, PostCSS ou Sass. Un résultat commun fournit les mêmes classes CSS Modules aux graphes serveur et navigateur.

## PostCSS

Sans configuration, PRNext applique `postcss-flexbugs-fixes` et `postcss-preset-env` au stade 3, avec `custom-properties: false` et Autoprefixer `flexbox: 'no-2009'`. Les cibles Browserslist du projet sont utilisées.

Une configuration personnalisée **remplace** ces plugins par défaut. PRNext lit un fichier `postcss.config.js`, `.mjs`, `.cjs` ou `.json`, `.postcssrc` et ses variantes correspondantes, ou la clé `postcss` de `package.json`. Garder une seule configuration. Son export doit être un objet, pas une fonction.

Les plugins sont installés dans le projet et déclarés par leur nom :

```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
}
```

Les tableaux `['nom-du-plugin', ['autre-plugin', options]]` sont aussi acceptés. La valeur `false` désactive un plugin. Les configurations, leurs imports locaux et les feuilles sont relus lors d'une reconstruction. Le mode développement surveille aussi `.postcssrc*` et `.browserslistrc`.

## Tailwind

Tailwind 4 fonctionne avec ses vrais packages, installés dans l'application :

```sh
npm install --save-dev tailwindcss @tailwindcss/postcss
```

Déclarer `@tailwindcss/postcss` dans la configuration PostCSS et importer Tailwind dans la feuille globale :

```css
@import "tailwindcss";
```

L'analyse automatique part du dossier du projet, même si la commande PRNext est exécutée depuis un autre dossier. Les options du plugin et les directives Tailwind comme `@source` permettent de préciser les sources. La configuration de Tailwind 3 suit son plugin `tailwindcss` habituel ; cette version n'a pas encore été vérifiée par les tests de cette livraison.

## Sass

Installer `sass` dans le projet, puis importer des fichiers `.scss`, `.sass`, `.module.scss` ou `.module.sass`. Les imports npm Sass, les chemins de recherche, les fichiers partiels et les exports `:export` des CSS Modules sont pris en charge.

```js
export default {
  sassOptions: {
    additionalData: '$brand: #123456;',
    includePaths: ['./styles'],
  },
}
```

`additionalData` accepte aussi une fonction, éventuellement asynchrone, recevant la source et `{ resourcePath, rootContext }`. `loadPaths` et les options modernes de Dart Sass sont transmis au compilateur. `implementation: 'sass-embedded'` sélectionne ce package s'il est installé ; les tests présents utilisent Dart Sass `sass`.

Les URL relatives aux fichiers partiels sont recalées à partir des sources Sass, puis les images et fontes sont émises dans les assets avec leur empreinte et le préfixe configuré. Les URL publiques absolues restent inchangées. Les source maps finales de développement identifient les feuilles transformées ; elles ne garantissent pas encore le suivi précis de chaque ligne jusqu'aux sources Sass d'origine.

## Vérification et limites

Les tests compilent réellement PostCSS, Autoprefixer, Tailwind 4 et les deux syntaxes Sass. Chromium vérifie les styles calculés, les images issues des fichiers partiels, l'hydratation et la navigation des deux routeurs. Un test lance la CLI de développement et modifie une configuration PostCSS cachée puis un fichier Sass partiel.

MDX et les autres extensions générant du JavaScript peuvent passer par les [loaders configurés](compiler.md). `styled-jsx` et les plugins webpack arbitraires restent à implémenter. Les fichiers surveillés automatiquement restent ceux du projet ; une dépendance de styles modifiée hors de ce dossier nécessite une reconstruction explicite.

Contrats de référence : [PostCSS dans Next](https://nextjs.org/docs/pages/guides/post-css), [Sass dans Next](https://nextjs.org/docs/app/guides/sass), [installation Tailwind avec PostCSS](https://tailwindcss.com/docs/installation/using-postcss), [API Dart Sass](https://sass-lang.com/documentation/js-api/).
