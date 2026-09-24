# Comparaison de migration Next.js → Rustyx

Date : 2026-09-23T12:24:09.757Z. Next 16.3.5, React 19.3.0, Rustyx 0.1.0-alpha.1.

30 scénarios identiques, 0 bloqués, 0 écarts fonctionnels exécutés. Un scénario peut contenir plusieurs assertions.

La boutique Edge compile désormais. Voir les vérifications de rendu, actions et cookies ci-dessous.

| Projet | Build Next / Rustyx (s) | p50 Next / Rustyx (ms) | RSS accueil Next / Rustyx (Mio) | RSS après parcours Next / Rustyx (Mio) |
|---|---:|---:|---:|---:|
| boutique | 5.42 / 0.66 | 0.56 / 0.33 | 108.74 / 8.84 | 156.42 / 222.33 |
| boutique-node | 3.35 / 0.55 | 0.68 / 0.31 | 104.47 / 8.76 | 141.47 / 207.52 |
| journal | 2.58 / 0.38 | 0.50 / 0.27 | 97.31 / 7.30 | 108.97 / 148.33 |
| dashboard | 3.42 / 0.52 | 3.66 / 2.55 | 135.97 / 148.01 | 142.67 / 152.52 |

Mesures indicatives : un build à froid par moteur, trois séries de 50 GET après 10 requêtes d’échauffement (médiane des trois p50), deux relevés RSS après démarrage neuf. Le RSS additionne le serveur et ses descendants, peut compter des pages partagées plusieurs fois, et exclut le navigateur. Rustyx utilise un worker ; Next sa configuration par défaut. Un accueil statique Rustyx peut être servi sans démarrer de worker JavaScript ; le relevé après parcours inclut le coût des API et actions exercées. Ce tableau ne mesure ni le CPU ni la saturation et ne démontre pas de gain universel. La campagne CPU et charge répétée est disponible dans [performance.md](performance.md).

Les captures d’accueil et de modal comparent le rendu stabilisé à 1280×900. Les différences d’encodage PNG/WebP sont conservées dans results.json ; elles ne sont pas automatiquement des erreurs fonctionnelles. Les 404 provoqués par les tests de pages absentes et les requêtes annulées lors de navigations sont conservés dans les diagnostics.

Voir [le rapport visuel](index.html), [les données brutes](results.json) et [les projets reproductibles](../../examples/next-migration/README.md).
