# Validation de la compatibilité et des optimisations

Vérification locale du 23 septembre 2026 sur macOS arm64, Apple M4 et Node 22.17.1. Les contrats et différences avec Next.js figurent dans la [matrice de compatibilité](compatibility.md).

| Vérification | Résultat |
| --- | --- |
| Unités JavaScript, `npm run test:unit` | 485 tests réussis au passage complet |
| Intégration HTTP, `npm run test:e2e` | 261 tests réussis au passage complet |
| Tests Rust en release | 110 tests réussis |
| Types, `npm run test:types` | Réussi |
| Rust fmt et Clippy, toutes les cibles, avertissements interdits | Réussis |
| Compilation native release | Réussie |
| Chromium, `npm run test:browser` | 202 scénarios réussis au passage complet |
| Comparaison directe à Next 16.3.5, `npm run test:next-compat` | Contrat HTTP et Chromium et contrat i18n Pages/domaines réussis ; [portée et reproduction](import-next.md) |
| Contrôles ciblés après les derniers ajustements | 8 tests loaders/PPR, 25 unités navigation/cache loaders et 1 scénario Chromium i18n réussis |
| Benchmark des pages en cache | 115 142 requêtes vérifiées, aucune erreur, aucun worker Node ; [snapshot](benchmark-cached-pages-local.json), [mesures et limites](performance.md) |

Les ajouts de cette passe couvrent l’[i18n Pages](i18n.md), les [hooks/loaders et contextes de compilation persistants](compiler.md), les Server Actions Edge (RPC, formulaires et captures chiffrées) et les échantillons `instant.unstable_samples`. Les tests vérifient l’invalidation des loaders, la reprise après une erreur de compilation, la conservation des composants client et l’absence des données d’échantillons dans les artefacts PPR. Les mesures du benchmark ci-dessus proviennent d’une passe précédente ; aucun nouveau gain chiffré n’est revendiqué.

Les [routages avancés](app-routing.md) couvrent les interceptions imbriquées, les paramètres propres à chaque branche, les métadonnées des slots et les changements de layout racine. La restauration d'une branche repasse par le pipeline natif de réécritures et de middleware avec les identifiants de la requête entrante, puis utilise son propre contexte d'en-têtes et de cookies. Les alias conservent leur URL et leur query ; les redirections, destinations externes et changements de cible déclenchent une navigation canonique. Les tests vérifient aussi la séparation des caches privés et du Draft Mode, les mutations précédant une restauration et l'annulation commune lorsque les flux des branches dépassent leur budget cumulé de 16 Mio.

Le [pré-rendu partiel](cache-components.md) couvre les chemins dynamiques inconnus ou partiellement générés, les réécritures, la navigation et le rafraîchissement, la persistance après redémarrage et les diagnostics Suspense. La continuation générique du build est réutilisée entre plusieurs URL, sans mélanger leurs paramètres. Le préchargement ne lance pas les composants privés ; la navigation revérifie les autorisations et emploie les cookies courants avant d'afficher l'enveloppe. Les diagnostics `instant` disposent aussi de tests de build et d'un oracle Next 16.3.5, avec les différences expérimentales documentées.

Les gestionnaires `cacheHandlers` et le [gestionnaire incrémental `cacheHandler`](incremental-cache.md) sont vérifiés avec un stockage partagé entre deux serveurs : compilation TypeScript, invalidation par tag et chemin, redémarrage, concurrence et séparation des données privées. Le second couvre aussi Pages HTML/JSON, App HTML/Flight et les corps des Route Handlers ; un cache distant invalidé ne ressuscite pas depuis un prérendu local. Les tests vérifient la durée conservée, les baux Rust entre workers et les courses entre invalidation et publication. Le stockage de test est un backend fichier ; ce résultat ne certifie pas une implémentation Redis applicative.

Le [build standalone](standalone.md) démarre après retrait des sources et de leurs dépendances originales, y compris avec un addon natif Sharp/libvips et des fichiers inclus depuis une racine monorepo. Les tests vérifient également les dépendances hoistées, le maintien du build précédent en cas d'échec et l'hydratation dans Chromium. Les réexports `export *` des Server Actions sont vérifiés dans les graphes serveur et navigateur, avec cycles, alias, ambiguïtés ESM et exclusion des implémentations privées. La résolution partage son ensemble de visites : un graphe de 66 modules représentant plus de quatre milliards de chemins possibles termine dans le délai de sécurité, et ses bindings sont comparés à ceux du moteur ESM natif.

Le [runtime Edge](edge-runtime.md) est vérifié par de vraies requêtes et des navigations Chromium : middleware, handlers, pages et layouts App, composants client rendus côté serveur dans la VM, cookies et en-têtes concurrents, WebCrypto, valeurs Flight et conservation de l'état hydraté. Les graphes Node et Edge coexistent. Les imports Node et les configurations Edge non couvertes échouent explicitement au build. Les contextes React sont réutilisés par mode pour éviter une VM par composant.

Un proxy global est testé avec une rafale de modules supérieure à l'ancienne file de cinq requêtes : tous les assets passent par le proxy et l'hydratation réussit. Le test de surcharge bloque 96 requêtes, vérifie les refus `503` avec `Retry-After` au-delà de l'admission bornée, puis sa récupération après libération.

Les [options de configuration](configuration.md) ajoutées incluent `distDir`, `trailingSlash`, les options de normalisation du middleware/proxy et les origines et tailles des Server Actions. Les tests couvrent les redirections 308, l'hydratation et les navigations Pages/App, la publication atomique du build, le rechargement des variables d'environnement en développement et les corps JSON/multipart dépassant la limite par défaut.

Ces résultats ne constituent pas une preuve de compatibilité universelle avec tout projet Next.js ou toute dépendance npm. Certains parcours conservent un rendu serveur complet pour vérifier les autorisations ou tenir compte de données privées. Les zones dynamiques PPR nécessitent encore un parcours de l'arbre serveur ; le protocole privé de préchargement Next n'est pas interchangeable. Les caches externes restent responsables de leur coordination distribuée. Les contrats précis et les options non implémentées figurent dans la [matrice de compatibilité](compatibility.md).
