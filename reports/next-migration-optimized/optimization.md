# Optimisation PPR et mémoire Edge

2026-09-23T17:14:40.041Z

Sur la charge PPR mixte : RAM -22.8 %, CPU par réponse -24.2 %, débit +25.1 %. La boutique Edge réduit sa RAM de 7.2 %. Par rapport à Next rejoué dans la nouvelle campagne, le PPR Rustyx utilise 13.7 % de RAM en moins, mais encore 7.5 % de CPU supplémentaire par réponse ; les débits sont proches. La RAM Edge reste supérieure à Next.

| Charge mixte | RAM Rustyx avant / après (Mio) | CPU avant / après (ms/1 000 req) | Débit avant / après (req/s) |
|---|---:|---:|---:|
| boutique | 227.3 / 211.0 | 297 / 295 | 6627 / 6784 |
| boutique-node | 130.0 / 130.3 | 120 / 120 | 23786 / 23865 |
| journal | 149.4 / 143.6 | 104 / 106 | 23912 / 23278 |
| dashboard | 232.6 / 179.7 | 1443 / 1094 | 1149 / 1438 |

## Changements

- Les échanges JSON avec le cache Rust local utilisent un petit pool HTTP persistant (32 connexions maximum, 4 libres par origine, au plus 32 au total), sans créer les objets Web de fetch. Le protocole de génération, les invalidations et les leases restent vérifiés à chaque échange. Le corps est borné à 4 Mio et le délai total à 5 secondes. Les autres origines conservent fetch.
- Le pool fonctionne hors du contexte des requêtes. Un test GC vérifie que les données terminées sont libérées même avec les connexions persistantes ouvertes. Annulations, saturation, contenu incorrect et récupération sont testés.
- En production, la jeune génération V8 du worker React serveur est limitée à 8 Mio pour réduire les allocations temporaires résidentes. Le plafond de l'ancienne génération reste inchangé. Aucun modèle personnalisé ni réponse dynamique n'est ajouté à un cache partagé.

## Vérification prolongée

| PPR sur 120 s, concurrence 8 | Requêtes valides | Erreurs | RSS premières / dernières 30 s (Mio) | Pic échantillonné (Mio) | RSS après 15 s de repos (Mio) |
|---|---:|---:|---:|---:|---:|
| next | 264534 | 0 | 302.3 / 310.6 | 311.0 | 156.2 |
| rustyx | 235034 | 0 | 264.2 / 282.5 | 282.5 | 158.5 |

| PPR prolongé | Débit (req/s) | CPU (ms / 1 000 requêtes) | p95 (ms) |
|---|---:|---:|---:|
| next | 2204 | 543 | 8.63 |
| rustyx | 1959 | 750 | 5.12 |

Sur ce passage prolongé à huit requêtes concurrentes, Rustyx garde une RAM sous charge plus basse, mais son débit est environ 11 % inférieur à Next et son CPU par réponse environ 38 % supérieur. Les gains de la campagne courte ne doivent pas être extrapolés à cette charge.

Deux minutes par moteur, mêmes routes PPR avec cookies distincts et huit requêtes concurrentes. Un seul passage long par moteur : ces valeurs ne prouvent pas l'absence de fuite sur des heures. Les séries RSS et les processus figurent dans [stability.json](stability.json).

## Validation et méthode

520 tests unitaires, 265 tests HTTP, 209 tests navigateur et les vérifications TypeScript passent. Les 30 scénarios de migration restent identiques. La campagne répétée comprend 48 mesures sans erreur. Les mesures avant proviennent de la campagne précédente ; les mêmes sources applicatives, versions, machine et charges ont été vérifiées, et Next a été rejoué. Les chiffres courts restent sensibles au GC et au bruit de mesure ; les petites variations des parcours non ciblés ne sont pas des gains établis.

[Graphiques RAM/CPU/débit actuels](performance.html) · [Données actuelles](results.json) · [Données avant optimisation](../next-migration/results.json) · [Comparaisons fonctionnelles](index.html).
