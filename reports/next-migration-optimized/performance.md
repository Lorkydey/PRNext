# RAM, CPU et débit : Next.js / Rustyx

2026-09-23T17:14:40.041Z · Next 16.3.5 · Rustyx 0.1.0-alpha.1 · Apple M4 · darwin/arm64 · v22.17.1

8 charges comparées ; 0 réponses invalides/erreurs. * = mesure incomplète ou non comparable (erreur, limite de requêtes ou disparition d’un processus).

Production sur la même machine, sans CDN ni TLS. Trois répétitions de 2 secondes, quatre requêtes concurrentes, 200 requêtes d’échauffement identiques par moteur, serveur neuf pour chaque charge et ordre Next/Rustyx alterné. Accueil : une seule route. Mixte : répartition égale entre les routes décrites ci-dessous. Le CPU est le delta du temps CPU cumulé du serveur et de ses descendants, mesuré par ps ; 100 % représente un cœur et non toute la machine. Le générateur de charge est un processus séparé, exclu du CPU/RAM serveur, mais partage le processeur. La RAM est la somme du RSS des processus serveur, échantillonnée environ toutes les 150 ms ; des pages partagées peuvent être comptées plusieurs fois. Les pics sont des maxima observés, pas des pics instantanés garantis. Les chiffres sont les médianes des répétitions, sauf le pic (maximum) et les erreurs (somme). Rustyx : un worker configuré, démarré à la demande ; Next : configuration par défaut. Ce test ne mesure pas la saturation maximale, le CPU de compilation ou le coût CPU du navigateur.

| Projet / charge | Moteur | RAM (Mio) | Pic (Mio) | CPU (% cœur) | CPU / 1 000 req (ms) | Req/s | p95 (ms) | Corps (Kio) | Erreurs | Rép. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| boutique / home | next | 186.23 | 249.36 | 131.5 | 147.32 | 8890 | 0.92 | 7.35 | 0 | 3 |
| boutique / home | rustyx | 10.00 | 10.05 | 255.5 | 94.29 | 27092 | 0.21 | 6.17 | 0 | 3 |
| boutique / mixed | next | 191.16 | 263.63 | 136.6 | 786.23 | 1738 | 6.57 | 4.93 | 0 | 3 |
| boutique / mixed | rustyx | 210.97 | 253.25 | 200.3 | 294.66 | 6784 | 1.45 | 3.69 | 0 | 3 |
| boutique-node / home | next | 175.45 | 227.64 | 131.0 | 147.97 | 8851 | 0.94 | 7.35 | 0 | 3 |
| boutique-node / home | rustyx | 10.03 | 10.11 | 255.0 | 95.34 | 26690 | 0.22 | 6.17 | 0 | 3 |
| boutique-node / mixed | next | 173.39 | 239.69 | 136.5 | 243.75 | 5598 | 1.37 | 4.93 | 0 | 3 |
| boutique-node / mixed | rustyx | 130.30 | 152.09 | 286.5 | 120.03 | 23865 | 0.26 | 3.62 | 0 | 3 |
| journal / home | next | 173.14 | 202.13 | 159.0 | 116.86 | 13604 | 0.52 | 2.10 | 0 | 3 |
| journal / home | rustyx | 8.67 | 8.73 | 240.5 | 70.03 | 34230 | 0.17 | 1.80 | 0 | 3 |
| journal / mixed | next | 169.72 | 220.06 | 144.9 | 288.63 | 5040 | 2.11 | 1.45 | 0 | 3 |
| journal / mixed | rustyx | 143.58 | 157.61 | 246.0 | 106.03 | 23278 | 0.34 | 1.23 | 0 | 3 |
| dashboard / home | next | 235.64 | 256.47 | 142.3 | 1845.85 | 771 | 6.97 | 8.56 | 0 | 3 |
| dashboard / home | rustyx | 188.81 | 224.02 | 164.7 | 2234.26 | 738 | 7.20 | 7.17 | 0 | 3 |
| dashboard / mixed | next | 208.25 | 251.23 | 144.3 | 1017.61 | 1418 | 7.18 | 5.31 | 0 | 3 |
| dashboard / mixed | rustyx | 179.66 | 200.67 | 157.3 | 1094.13 | 1438 | 4.12 | 4.17 | 0 | 3 |

## Charges

```text
boutique: GET / ; GET /produit/lampe ; GET /api/catalogue ; GET /edge
boutique-node: GET / ; GET /produit/lampe ; GET /api/catalogue ; GET /edge
journal: GET / ; GET /article/foret ; GET /recherche ; POST /api/contact
dashboard: GET / ; GET /api/session ; GET /projet/atlas
```

Les requêtes PPR portent des cookies distincts et la recherche SSR des paramètres distincts ; les réponses doivent contenir leur valeur. Les statuts et contenus sont contrôlés, y compris les POST API. La moyenne des octets de réponse est indiquée car les transports HTML/RSC des moteurs diffèrent.

[Graphiques et tableau](performance.html) · [Mesures brutes et détails des processus](results.json) · [Tests fonctionnels](index.html).
