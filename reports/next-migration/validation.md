# Validation des corrections Edge

Exécutée le 23 septembre 2026, avant les mesures de charge :

| Commande | Résultat |
|---|---:|
| `npm run test:unit` | 517 tests réussis |
| `npm run test:types` | Réussi : types de compatibilité et deux exemples |
| `npm run test:e2e` | 265 tests HTTP réussis |
| `npm run test:browser` | 209 tests Chromium réussis |
| `node --test scripts/migration-load.test.mjs` | 1 test du générateur de charge réussi |

Les tests Edge renforcés vérifient le CSS global d'un layout, un Sass Module d'un Server Component, l'hydratation, la conservation d'état et les couleurs après navigation vers Edge puis Node. Ils passent avec esbuild et webpack. Les tests de compilation vérifient aussi que les Route Handlers Edge continuent à refuser les imports CSS et les API Node interdites.

Le test du générateur de charge contrôle les POST, les statuts HTTP, les paramètres/cookies propres à chaque requête et le comptage des réponses invalides : des 503 et des réponses contenant une ancienne identité ne sont pas comptés comme des requêtes valides.

Les [comparaisons de sites](index.html) et [mesures RAM/CPU](performance.html) utilisent ensuite des builds de production distincts des tests. Aucun benchmark n'a tourné en même temps que ces suites. Le serveur Rust natif n'a pas été modifié pendant cette correction.
