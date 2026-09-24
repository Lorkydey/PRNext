# Comparaison après optimisation des chemins fréquents

99 essais, 5,041,469 réponses valides, aucune erreur. Médianes de trois mesures de cinq secondes. C4 sauf les parcours mixtes C64 et l’API C512. Apple M4, 16 Gio, Node v22.17.1, Next 16.3.5 / webpack.

| Scénario | CPU Next → Rustyx, ms/réponse | CPU vs Next | RAM Next → Rustyx, Mio | RAM vs Next | Débit vs Next |
|---|---:|---:|---:|---:|---:|
| Hit ISR · documentation | 0.0921 → 0.0438 | -52.5 % | 211.1 → 9.6 | -95.5 % | 2.88× |
| Image en cache · boutique | 0.1050 → 0.0200 | -81.0 % | 219.2 → 9.7 | -95.6 % | 2.77× |
| API Pages POST · journal | 0.1458 → 0.1206 | -17.3 % | 213.9 → 138.9 | -35.0 % | 1.60× |
| API Pages GET · documentation | 0.1399 → 0.1233 | -11.9 % | 212.7 → 139.1 | -34.6 % | 1.56× |
| Flight PPR · dashboard | 1.1969 → 1.1626 | -2.9 % | 249.1 → 227.8 | -8.5 % | 1.46× |
| HTML PPR · dashboard | 1.9318 → 1.4907 | -22.8 % | 270.7 → 258.6 | -4.5 % | 1.87× |
| API attente 30 ms · portail | 1.6667 → 1.1570 | -30.6 % | 138.7 → 91.2 | -34.2 % | 1.01× |
| Upload API 32 Kio · journal | 0.1442 → 0.1284 | -10.9 % | 245.7 → 189.4 | -22.9 % | 1.61× |
| Parcours mixte · C64 · dashboard | 1.0195 → 0.6905 | -32.3 % | 323.5 → 276.5 | -14.5 % | 2.45× |
| API asynchrone · C512 · portail | 0.2918 → 0.1875 | -35.7 % | 366.8 → 271.9 | -25.9 % | 2.20× |
| Parcours mixte · C64 · documentation | 0.1767 → 0.1134 | -35.8 % | 243.9 → 147.1 | -39.7 % | 2.79× |

## Face à l’ancien Rustyx

| Scénario | CPU/réponse | RAM médiane | Débit |
|---|---:|---:|---:|
| Hit ISR · documentation | -43.4 % | -1.0 % | +17.2 % |
| Image en cache · boutique | -86.3 % | -23.2 % | +135.9 % |
| API Pages POST · journal | -30.4 % | +0.6 % | +18.4 % |
| API Pages GET · documentation | -27.1 % | +1.7 % | +13.5 % |
| Flight PPR · dashboard | -17.1 % | -1.8 % | +18.5 % |
| HTML PPR · dashboard | -14.3 % | -1.5 % | +14.9 % |
| API attente 30 ms · portail | -5.6 % | +0.1 % | -0.1 % |
| Upload API 32 Kio · journal | -26.1 % | -3.2 % | +14.0 % |
| Parcours mixte · C64 · dashboard | -15.2 % | +5.1 % | +19.6 % |
| API asynchrone · C512 · portail | -24.6 % | +0.2 % | -2.5 % |
| Parcours mixte · C64 · documentation | -39.1 % | +1.9 % | +5.4 % |

## PPR mixte prolongé à 64 clients

Une observation de 60 secondes par moteur, puis 15 secondes de repos et un contrôle de récupération de deux secondes. Ces résultats restent séparés des médianes de la campagne principale.

| Moteur | Réponses/s | CPU ms/réponse | RSS médian | Pic RSS échantillonné | RSS en fin de charge | RSS après 15 s de repos | Erreurs charge / récupération |
|---|---:|---:|---:|---:|---:|---:|---:|
| rustyx | 4124 | 0.5761 | 333.4 Mio | 337.4 Mio | 337.4 Mio | 152.1 Mio | 0 / 0 |
| next | 1897 | 0.6851 | 349.3 Mio | 349.9 Mio | 349.9 Mio | 167.4 Mio | 0 / 0 |

Le RSS peut rester élevé après repos : V8 et les allocateurs ne restituent pas immédiatement toute la mémoire inutilisée au système. Ces relevés ne suffisent pas à exclure une fuite lente. [Mesures prolongées](sustained.json).

## Flight PPR seul pendant 30 secondes

Une observation par moteur à quatre clients, pour vérifier le coût sur une durée supérieure aux essais courts. Elle ne constitue pas une répétition supplémentaire de la médiane principale.

| Moteur | Réponses/s | CPU ms/réponse | RSS médian Mio | Pic RSS échantillonné Mio | Erreurs |
|---|---:|---:|---:|---:|---:|
| rustyx | 2309 | 0.7577 | 242.4 | 244.4 | 0 |
| next | 1401 | 0.7969 | 265.2 | 270.0 | 0 |

[Mesures Flight prolongées](flight-sustained.json).

## Interprétation

Le CPU indiqué est le temps processeur de tous les processus serveur, divisé par le nombre de réponses valides. Un serveur plus rapide peut consommer davantage de CPU total à saturation tout en coûtant moins par réponse. Le RSS inclut les workers Node et RSC ; il peut compter plusieurs fois certaines pages partagées. Les pics sont échantillonnés, pas garantis instantanés.

Pendant la campagne finale, une analyse de stockage macOS a été observée à environ un cœur CPU en arrière-plan (background-observations.jsonl). Elle est exclue de la comptabilité serveur, mais peut augmenter la dispersion et modifier les conditions de concurrence. Aucune répétition n’a été éliminée en fonction de son résultat. Refaire le banc au repos avant de dimensionner un serveur.

Les cinq projets ont les mêmes sources pour les deux moteurs, et 36 comparaisons fonctionnelles passent. Le générateur de charge est un processus séparé, mais partage ce Mac avec le serveur. Les moteurs sont lancés successivement, dans des ordres alternés. Les petits écarts et les plages de répétitions qui se recouvrent ne démontrent pas une supériorité stable.

La compression est identique sur les charges de ce rapport : identity, et la même image WebP de 2 254 octets. Les tailles HTML/Flight peuvent différer entre implémentations. Chaque réponse dynamique est vérifiée avec un identifiant de visiteur ou de recherche propre à la requête.

Chaque essai redémarre le serveur. Sur les hits ISR et images seuls, Rustyx peut éviter de lancer Node : leur très faible RSS ne représente pas un site après un rendu React dynamique. Les parcours mixtes mesurent aussi les workers démarrés.

Ces mesures couvrent des charges locales de quelques secondes et des caches chauds. Elles ne prouvent ni une compatibilité Next exhaustive, ni la capacité d’un VPS Linux, ni l’endurance sur plusieurs jours. Le tas applicatif Node n’a pas de plafond global ajouté par ces optimisations. La RAM des pages dynamiques demeure principalement celle de JavaScript et React.

[Données brutes](results.json) · [CSV](summary.csv) · [Contrôles indépendants](validation.json) · [Comparaisons fonctionnelles](functional.json) · [Détails des changements](../../docs/hot-path-optimization.md)
