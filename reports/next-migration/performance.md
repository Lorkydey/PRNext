# RAM, CPU et débit : Next.js / Rustyx

2026-09-23T12:24:09.757Z · Next 16.3.5 · Rustyx 0.1.0-alpha.1 · Apple M4 · darwin/arm64 · v22.17.1

8 charges comparées ; 0 réponses invalides/erreurs. * = mesure incomplète ou non comparable (erreur, limite de requêtes ou disparition d’un processus).

Production sur la même machine, sans CDN ni TLS. Trois répétitions de 2 secondes, quatre requêtes concurrentes, 200 requêtes d’échauffement identiques par moteur, serveur neuf pour chaque charge et ordre Next/Rustyx alterné. Accueil : une seule route. Mixte : répartition égale entre les routes décrites ci-dessous. Le CPU est le delta du temps CPU cumulé du serveur et de ses descendants, mesuré par ps ; 100 % représente un cœur et non toute la machine. Le générateur de charge est un processus séparé, exclu du CPU/RAM serveur, mais partage le processeur. La RAM est la somme du RSS des processus serveur, échantillonnée environ toutes les 150 ms ; des pages partagées peuvent être comptées plusieurs fois. Les pics sont des maxima observés, pas des pics instantanés garantis. Les chiffres sont les médianes des répétitions, sauf le pic (maximum) et les erreurs (somme). Rustyx : un worker configuré, démarré à la demande ; Next : configuration par défaut. Ce test ne mesure pas la saturation maximale, le CPU de compilation ou le coût CPU du navigateur.

| Projet / charge | Moteur | RAM (Mio) | Pic (Mio) | CPU (% cœur) | CPU / 1 000 req (ms) | Req/s | p95 (ms) | Corps (Kio) | Erreurs | Rép. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| boutique / home | next | 182.83 | 252.17 | 131.5 | 148.76 | 8837 | 0.94 | 7.35 | 0 | 3 |
| boutique / home | rustyx | 10.02 | 10.08 | 254.5 | 95.07 | 26609 | 0.22 | 6.17 | 0 | 3 |
| boutique / mixed | next | 191.88 | 261.09 | 136.7 | 790.54 | 1729 | 6.65 | 4.93 | 0 | 3 |
| boutique / mixed | rustyx | 227.33 | 267.84 | 196.9 | 297.18 | 6627 | 1.53 | 3.69 | 0 | 3 |
| boutique-node / home | next | 176.38 | 225.94 | 131.5 | 147.79 | 8844 | 0.93 | 7.35 | 0 | 3 |
| boutique-node / home | rustyx | 9.98 | 10.09 | 254.5 | 94.12 | 27073 | 0.21 | 6.17 | 0 | 3 |
| boutique-node / mixed | next | 171.39 | 236.22 | 136.9 | 244.92 | 5612 | 1.36 | 4.93 | 0 | 3 |
| boutique-node / mixed | rustyx | 129.98 | 149.94 | 285.5 | 120.01 | 23786 | 0.26 | 3.62 | 0 | 3 |
| journal / home | next | 174.53 | 204.19 | 158.5 | 116.22 | 13635 | 0.51 | 2.10 | 0 | 3 |
| journal / home | rustyx | 8.61 | 8.70 | 240.5 | 69.12 | 34676 | 0.17 | 1.80 | 0 | 3 |
| journal / mixed | next | 166.88 | 217.67 | 144.5 | 285.35 | 5063 | 2.10 | 1.45 | 0 | 3 |
| journal / mixed | rustyx | 149.39 | 162.06 | 247.0 | 103.70 | 23912 | 0.33 | 1.23 | 0 | 3 |
| dashboard / home | next | 235.97 | 267.28 | 142.4 | 1838.71 | 774 | 7.12 | 8.56 | 0 | 3 |
| dashboard / home | rustyx | 245.58 | 272.61 | 170.5 | 2814.57 | 603 | 9.04 | 7.17 | 0 | 3 |
| dashboard / mixed | next | 209.81 | 249.92 | 143.9 | 1015.00 | 1426 | 7.10 | 5.31 | 0 | 3 |
| dashboard / mixed | rustyx | 232.59 | 258.03 | 165.8 | 1442.85 | 1149 | 5.30 | 4.17 | 0 | 3 |

## Charges

```text
boutique: GET / ; GET /produit/lampe ; GET /api/catalogue ; GET /edge
boutique-node: GET / ; GET /produit/lampe ; GET /api/catalogue ; GET /edge
journal: GET / ; GET /article/foret ; GET /recherche ; POST /api/contact
dashboard: GET / ; GET /api/session ; GET /projet/atlas
```

Les requêtes PPR portent des cookies distincts et la recherche SSR des paramètres distincts ; les réponses doivent contenir leur valeur. Les statuts et contenus sont contrôlés, y compris les POST API. La moyenne des octets de réponse est indiquée car les transports HTML/RSC des moteurs diffèrent.

[Graphiques et tableau](performance.html) · [Mesures brutes et détails des processus](results.json) · [Tests fonctionnels](index.html).
