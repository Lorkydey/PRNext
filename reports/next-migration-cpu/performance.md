# Rustyx : coût CPU et rapidité

2026-09-23T18:26:10.795Z

Le coût CPU par réponse baisse de 24,6 %, le débit augmente de 29,2 % et le RSS médian augmente de 1,8 % par rapport à Rustyx avant.

Face à Next.js : CPU par réponse comparable sur cette mesure, débit +18,0 %, RSS médian -10,2 %.

| Moteur | CPU / réponse (ms) | Débit (req/s) | RSS médian (Mio) | p95 (ms) |
|---|---:|---:|---:|---:|
| Next.js | 0,595 | 2 074 | 301,0 | 9,21 |
| Rustyx avant | 0,789 | 1 895 | 265,4 | 5,46 |
| Rustyx optimisé | 0,595 | 2 447 | 270,3 | 4,31 |

## Détail des processus Rustyx

| Moteur | CPU processus Rust (ms/rép.) | CPU processus Node/React (ms/rép.) | RSS processus Rust (Mio) | RSS processus Node/React (Mio) |
|---|---:|---:|---:|---:|
| Rustyx avant | 0,195 | 0,594 | 11,3 | 254,1 |
| Rustyx optimisé | 0,136 | 0,458 | 11,2 | 259,2 |

CPU cumulé et RSS médian par processus ; les médianes des composantes ne sont pas nécessairement additives. Ces relevés distinguent les processus, pas le langage de chaque fonction exécutée.

## Contrôle prolongé

| Essai 120 s | CPU / réponse (ms) | Débit (req/s) | RSS dernières 30 s (Mio) | Pic RSS (Mio) | RSS après 15 s de repos (Mio) |
|---|---:|---:|---:|---:|---:|
| Next.js | 0,545 | 2 198 | 305,5 | 305,5 | 155,1 |
| Rustyx optimisé | 0,566 | 2 552 | 282,9 | 283,3 | 154,0 |

Sur les deux minutes : Rustyx présente +3,9 % de CPU par réponse, +16,1 % de débit et -7,4 % de RSS sur les dernières 30 secondes face à Next.

## Changements

- Le cache natif Rust résout la génération et lit l'entrée dans la même transaction. Les réponses PPR déjà mises en cache demandent un échange au lieu de deux. Les invalidations et les contrôles de lease restent actifs ; aucun numéro de génération périmé n'est mémorisé côté JavaScript.
- SQLite réutilise ses requêtes préparées, dans un cache de 32 statements au maximum. Les paramètres sont libérés après utilisation. Les plafonds du cache de données et des pages restent inchangés.
- Le décodeur SSR réutilise les correspondances de modules, avec des références faibles et une vérification des chemins. Il ne retient pas les modèles React décodés, les cookies ou les contextes de visiteurs.

## Validation

523 tests unitaires JavaScript, 118 tests Rust, 265 tests HTTP, 209 tests navigateur ; TypeScript, formatage et Clippy passent. 30 scénarios de migration passent également.

578 102 réponses valides dans les passages répétés, 569 965 dans le contrôle prolongé, aucune erreur. Chaque réponse personnalisée est contrôlée avec un cookie distinct.

## Méthode et limites

Tableau de bord PPR : page personnalisée par cookie, API de session, fiche projet statique. Sources identiques, 3 passages de 30 s par moteur, 8 connexions, 400 requêtes d'échauffement et serveur neuf à chaque passage. Ordre des moteurs tournant. Médiane des passages, sauf mention contraire. Le CPU est le temps cumulé du serveur et de tous ses descendants par réponse valide ; la RAM est le RSS de ces mêmes processus. Le générateur de charge est exclu. Versions : Node 22.17.1, Next 16.3.5, React 19.3.0, Apple M4. Le binaire et les modules antérieurs sont restaurés pour Rustyx avant, les bundles applicatifs restent identiques ; leurs empreintes figurent dans les données brutes.

Mesures locales synthétiques : les résultats dépendent des pages, de la concurrence, du GC et du matériel. Le RSS inclut les pages partagées de chaque processus et n'est pas une mesure de mémoire physique unique. L'essai de 120 secondes est un seul passage par moteur, Next puis Rustyx. Ces résultats ne donnent ni un plafond de capacité ni une preuve d'absence de fuite sur plusieurs heures. Les Server Actions et l'hydratation sont vérifiées par les tests fonctionnels, pas par le générateur de charge. Les gains ne s'appliquent pas automatiquement à toutes les applications Next.

## Pistes restantes

Le PPR parcourt encore l'arbre serveur vivant et effectue plusieurs encodages/décodages Flight pour fusionner les zones dynamiques. Réduire ce travail nécessite de préserver les frontières Suspense, les actions, les métadonnées et les valeurs riches. C'est le prochain axe ; augmenter le nombre de workers changerait le compromis RAM/concurrence et n'a pas été utilisé ici.

[Rapport visuel](performance.html) · [Passages bruts](cpu-results.json) · [Contrôle prolongé](stability.json) · [Sites et scénarios](index.html).
