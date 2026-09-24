# Comparaison de migration Next.js → Rustyx

Date : 2026-09-23T18:35:31.445Z. Next 16.3.5, React 19.3.0, Rustyx 0.1.0-alpha.1.

30 scénarios identiques, 0 bloqués, 0 écarts fonctionnels exécutés. Un scénario peut contenir plusieurs assertions.

La boutique Edge compile désormais. Voir les vérifications de rendu, actions et cookies ci-dessous.

| Projet | Build Next / Rustyx (s) | p50 Next / Rustyx (ms) | RSS accueil Next / Rustyx (Mio) | RSS après parcours Next / Rustyx (Mio) |
|---|---:|---:|---:|---:|
| boutique | 5.17 / 0.67 | 0.60 / 0.34 | 110.03 / 8.70 | 151.17 / 222.17 |
| boutique-node | 3.34 / 0.54 | 0.61 / 0.29 | 103.64 / 8.74 | 141.53 / 212.39 |
| journal | 2.48 / 0.38 | 0.51 / 0.26 | 96.70 / 7.28 | 102.39 / 149.44 |
| dashboard | 3.44 / 0.52 | 3.64 / 1.83 | 135.54 / 123.24 | 140.55 / 124.33 |

Mesures indicatives : un build à froid par moteur, trois séries de 50 GET après 10 requêtes d’échauffement (médiane des trois p50), deux relevés RSS après démarrage neuf. Le RSS additionne le serveur et ses descendants, peut compter des pages partagées plusieurs fois, et exclut le navigateur. Rustyx utilise un worker ; Next sa configuration par défaut. Un accueil statique Rustyx peut être servi sans démarrer de worker JavaScript ; le relevé après parcours inclut le coût des API et actions exercées. Ce tableau ne mesure ni le CPU ni la saturation et ne démontre pas de gain universel. 

Les captures d’accueil et de modal comparent le rendu stabilisé à 1280×900. Les différences d’encodage PNG/WebP sont conservées dans results.json ; elles ne sont pas automatiquement des erreurs fonctionnelles. Les 404 provoqués par les tests de pages absentes et les requêtes annulées lors de navigations sont conservés dans les diagnostics.

Voir [le rapport visuel](index.html), [les données brutes](results.json) et [les projets reproductibles](../../examples/next-migration/README.md).
