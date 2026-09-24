# Comparaison de migration Next.js → Rustyx

Date : 2026-09-23T17:14:40.041Z. Next 16.3.5, React 19.3.0, Rustyx 0.1.0-alpha.1.

30 scénarios identiques, 0 bloqués, 0 écarts fonctionnels exécutés. Un scénario peut contenir plusieurs assertions.

La boutique Edge compile désormais. Voir les vérifications de rendu, actions et cookies ci-dessous.

| Projet | Build Next / Rustyx (s) | p50 Next / Rustyx (ms) | RSS accueil Next / Rustyx (Mio) | RSS après parcours Next / Rustyx (Mio) |
|---|---:|---:|---:|---:|
| boutique | 5.43 / 0.79 | 0.58 / 0.33 | 108.24 / 8.81 | 156.02 / 227.70 |
| boutique-node | 3.36 / 0.54 | 0.60 / 0.31 | 103.98 / 8.87 | 141.16 / 212.94 |
| journal | 2.50 / 0.38 | 0.50 / 0.26 | 97.32 / 7.33 | 106.41 / 149.80 |
| dashboard | 3.43 / 0.53 | 3.51 / 2.14 | 134.08 / 124.66 | 136.73 / 124.56 |

Mesures indicatives : un build à froid par moteur, trois séries de 50 GET après 10 requêtes d’échauffement (médiane des trois p50), deux relevés RSS après démarrage neuf. Le RSS additionne le serveur et ses descendants, peut compter des pages partagées plusieurs fois, et exclut le navigateur. Rustyx utilise un worker ; Next sa configuration par défaut. Un accueil statique Rustyx peut être servi sans démarrer de worker JavaScript ; le relevé après parcours inclut le coût des API et actions exercées. Ce tableau ne mesure ni le CPU ni la saturation et ne démontre pas de gain universel. La campagne CPU et charge répétée est disponible dans [performance.md](performance.md).

Les captures d’accueil et de modal comparent le rendu stabilisé à 1280×900. Les différences d’encodage PNG/WebP sont conservées dans results.json ; elles ne sont pas automatiquement des erreurs fonctionnelles. Les 404 provoqués par les tests de pages absentes et les requêtes annulées lors de navigations sont conservés dans les diagnostics.

Voir [le rapport visuel](index.html), [les données brutes](results.json) et [les projets reproductibles](../../examples/next-migration/README.md).
