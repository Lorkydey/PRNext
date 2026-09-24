# Validation du blog Next.js avec Contentlayer

Vérification locale du 24 septembre 2026, sous macOS ARM64 et Node 22.17.1, sur [tailwind-nextjs-starter-blog](https://github.com/timlrx/tailwind-nextjs-starter-blog/tree/b45bef66b40c63b6f57c15ee8cd090682238df4c). Le projet utilise Next 15.5.12, React 19.3.0, Contentlayer 0.5.8, Headless UI 2.2.9 et Yarn 3.6.1. Cette validation concerne ce projet et ces versions ; elle ne démontre pas une compatibilité universelle avec Next.

## Lancer le projet local

Le lien local et les scripts `rx`/`rustyx` du projet de test sont déjà installés. Depuis `/Users/thomas/Desktop/nextjs-test-blog` :

```sh
corepack yarn rx check
corepack yarn rx dev --port 3001
```

Pour la production, arrêter le serveur de développement avant de reconstruire :

```sh
corepack yarn rx build
corepack yarn rx start --port 3001
```

Les scripts Next originaux restent disponibles. La procédure de liaison locale est décrite dans [Importer un projet Next](import-next.md).

## Corrections apportées

- Chargement des options de configuration injectées par Contentlayer : `onDemandEntries`, règles webpack JS/ESM et exclusions de surveillance. Les champs optionnels valant `undefined` conservent leurs valeurs par défaut.
- Résolution des alias et conditions Turbopack depuis `turbopack.root` lorsque cette option est présente.
- Répertoire de travail correct pour les plugins lors de `rx build /chemin/du/projet` et `rx dev /chemin/du/projet`.
- Surveillance des modules `.contentlayer/generated/` et filtrage borné des réécritures identiques, pour éviter la boucle de compilation observée sur ce blog.
- Traitement des URL CSS, polices et images par le pont webpack : ces ressources ne sont plus importées comme des modules JavaScript.
- Même structure de contenu React en SSR, PPR et hydratation pour préserver les identifiants `useId`.

## Résultats

`rx check` accepte les 12 motifs de routes. Le build de production génère 13 documents Contentlayer. Les temps de compilation de ce diagnostic ne constituent pas un benchmark comparatif.

Les pages `/`, `/blog/`, `/tags/`, `/projects/`, `/about/`, `/blog/guide-to-using-images-in-nextjs/` et `/blog/new-features-in-v1/` répondent en HTTP 200 dans Chromium en production. Le dernier scénario complet rapporte **zéro exception navigateur et zéro message de console de niveau erreur**, en développement et en production, y compris après les mises à jour TSX, CommonJS et MDX. Le thème, la navigation client et le menu mobile fonctionnent. Une erreur de configuration Contentlayer injectée volontairement est signalée sans arrêter le dernier serveur valide ; sa correction suffit à reprendre les builds.

Dernière vérification du framework : **584 tests unitaires**, vérifications TypeScript, **4 tests d'intégration ciblés** et **10 tests navigateur** CommonJS, webpack et Fast Refresh réussis. Les régressions couvrent notamment les imports Flight par URL, le regroupement des requêtes de chargement, les nouvelles tentatives après échec, les générateurs et les modifications concurrentes à la compilation.

La vérification TypeScript du blog lui-même passe également (`corepack yarn tsc --noEmit --tsBuildInfoFile /tmp/rustyx-blog-diagnostic.tsbuildinfo`). Les imports de citation ont été vérifiés en interdisant explicitement la résolution du `punycode` intégré à Node ; les conversions d'URL Unicode par les dépendances corrigées restent fonctionnelles.

### Correction CommonJS après essai dans le dossier utilisateur

Le lancement réel a révélé l'avertissement `export 'default' ... siteMetadata ... module has no exports`. Fast Refresh introduisait un import ESM dans `data/siteMetadata.js`, qui utilise `module.exports`. L'instrumentation préserve maintenant son format CommonJS. Le premier essai dans un dossier temporaire avait masqué ce problème : les chemins résolus via `/private/var` étaient exclus à tort du transform de développement. Cette reconnaissance des chemins a également été corrigée.

Deux tests navigateur vérifient les métadonnées CommonJS dans Pages et App, avec esbuild et webpack, puis leur mise à jour après modification. Le blog réel a été retesté dans une copie temporaire en vérifiant explicitement que `data/siteMetadata.js` est enregistré par Fast Refresh : l'avertissement d'export a disparu, le titre change après modification CommonJS et les modifications TSX/MDX restent visibles.

### Diagnostic des avertissements au lancement

Les messages `Critical dependency` provenaient de deux causes différentes :

- **Rustyx / Flight** : esbuild transformait `import(/* webpackIgnore: true */ condition ? a : b)` en deux imports, en déplaçant le commentaire hors des appels. Webpack les traitait ensuite comme des contextes dynamiques. L'URL est maintenant calculée avant un unique import : le navigateur charge réellement le module attendu, y compris après un rafraîchissement.
- **Formidable 1.x** : quatre modules réaffectent `require` via un ancien hook de tests `GENTLY`. Le blog configure `serverExternalPackages: ['formidable']` pour conserver la résolution native Node de cette dépendance serveur.

Les avertissements webpack qui subsistent sur d'autres projets sont toujours affichés, avec la cible, le fichier et l'emplacement. Aucun filtre global des avertissements n'a été ajouté.

Le blog local contient aussi des correctifs **propres à ses dépendances**, conservés dans `.yarn/patches/` et référencés par son `package.json` / `yarn.lock` :

| Dépendance | Correction locale |
| --- | --- |
| `rehype-citation@2.3.2`, `whatwg-url@5.0.0`, `tr46@0.0.3` | Import de `punycode/punycode.js` depuis le paquet npm, au lieu du module Node déprécié. Les dépendances explicites sont déclarées via `packageExtensions`. |
| `next-contentlayer2@0.5.8` | Le hook webpack attend la première génération ; les erreurs remontent et l'attente initiale est bornée à 120 secondes. Le flux de surveillance reste actif. |
| `next-themes@0.4.6` | Avec React 19 dans ce blog, `useSyncExternalStore` distingue l'hydratation initiale d'un remontage client. Le script de thème reste présent en SSR, sans recréation inerte lors de Fast Refresh. [Signalement amont](https://github.com/pacocoursey/next-themes/issues/385). |

Ces patches ne sont pas une modification globale des paquets npm et ne sont pas distribués automatiquement par Rustyx. Il faut conserver les patches, `.yarnrc.yml`, `package.json` et `yarn.lock` ensemble dans le projet de test. `corepack yarn install --immutable` a été vérifié ; une mise à jour des versions concernées demande de revalider les patches. Les anciennes déclarations de peer dependencies de Pliny/Algolia produisent encore des avertissements à **l'installation** ; elles n'ont pas été artificiellement élargies.

Dans le code du blog, `onSuccess` attend maintenant l'écriture du compteur de tags et les JSON générés ne sont réécrits que si leur contenu change. Le portail du menu mobile est monté après hydratation, avec nettoyage du verrouillage du scroll au démontage. Umami n'est chargé que si son identifiant est configuré, et le domaine autorisé par la CSP correspond à son script par défaut.

Les démarrages à froid et à chaud du blog corrigé effectuent **une seule compilation**, sans `Critical dependency`, `DEP0040` ni erreur de module Contentlayer manquant. Le filtre conserve les changements survenus pendant la compilation, sans relever la limite de recyclage mémoire du worker.

Pour répéter le diagnostic sur une copie temporaire, depuis le dépôt Rustyx :

```sh
node scripts/check-contentlayer-blog.mjs ../nextjs-test-blog
```

Le script utilise les dépendances déjà installées du blog, exclut ses fichiers `.env*`, crée ses propres serveurs, puis supprime la copie et ses processus. Il vérifie les démarrages à froid/à chaud, l'hydratation, le thème avant chargement de React, le menu mobile, la navigation client, les modifications TSX/CommonJS/MDX, une erreur Contentlayer volontaire et sa correction, puis sept pages en production. Les logs détaillés restent dans le dossier temporaire indiqué au lancement. Ce scénario est spécifique à ce starter blog et ne remplace pas une suite de compatibilité Next complète.

## Limites observées

- Les corrections du menu, d'Umami et des dépendances ci-dessus sont locales au blog téléchargé. Un autre projet utilisant les mêmes versions non corrigées peut présenter ces problèmes.
- `onDemandEntries` est accepté et validé, mais Rustyx ne reproduit pas la file d'éviction des pages de développement de Next. `turbopack.root` ne change pas la portée du watcher Rustyx et ne reproduit pas l'isolation du système de fichiers de Turbopack. Voir [Configuration](configuration.md) et [Compilateur](compiler.md).

Les tests du blog ne couvrent pas les services externes configurables : newsletter, commentaires, recherche Algolia et statistiques demandent leurs propres identifiants et essais.
