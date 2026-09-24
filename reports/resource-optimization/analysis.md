# Résultats des six pistes

90 essais ; 5 183 144 réponses valides ; 0 erreurs du nouveau Rustyx standard. Deux répétitions de six secondes par scénario court : les petits écarts ne sont pas conclusifs. Les contrôles prolongés sont des observations uniques de 30 secondes.

## Ce que montrent les mesures

Les gains du fonctionnement standard restent modestes et variables dans cette campagne. La PGO présente le compromis le plus intéressant parmi les options : sur l’API Pages, CPU/réponse -7,4 % et RSS -0,9 % face au nouveau build standard. Mimalloc réduit davantage le CPU de certaines API, mais son RSS médian varie de 17,8 % dans le parcours portail mixte, avec une forte variation entre les deux essais. L’admission adaptative n’apporte pas de gain CPU convaincant ici. Ces options restent désactivées par défaut. Le PPR prolongé mérite un suivi : face au Rustyx précédent, RSS -2,6 %, CPU/réponse 6,1 % et débit -7,2 % sur cet essai unique. Cette campagne ne permet pas d’attribuer cet écart à un mécanisme isolé.

## Nouveau Rustyx standard face à la version précédente

Les différences CPU/RSS négatives sont favorables ; le débit compte les réponses valides.

| Scénario | Débit | CPU/réponse | RSS |
|---|---:|---:|---:|
| portail · API attente 30 ms · C512 | 0,6 % | 0,5 % | -0,7 % |
| portail · Parcours mixte · C128 | 5,2 % | -3,4 % | -0,2 % |
| portail · API immédiate · C4 | -0,5 % | 0,9 % | -0,4 % |
| dashboard · PPR HTML · C4 | -1,3 % | -1,3 % | -1,2 % |
| dashboard · PPR Flight · C4 | 2,6 % | -3,6 % | 2,2 % |
| dashboard · Parcours mixte · C64 | -0,7 % | 0,9 % | 0,3 % |
| journal · API Pages POST · C4 | -2,6 % | 2,4 % | 0,5 % |

### Admission adaptative par rapport au nouveau build standard

- portail/async-512 : CPU 1,3 %, RSS -1,6 %, erreurs 0
- portail/mixed-128 : CPU 1,8 %, RSS -2,8 %, erreurs 0
- portail/api-fast : CPU 1,2 %, RSS 2,9 %, erreurs 0
- dashboard/ppr-html : CPU 0,7 %, RSS -1,5 %, erreurs 0
- dashboard/ppr-flight : CPU 2,8 %, RSS -2,6 %, erreurs 0
- dashboard/mixed-64 : CPU 0,3 %, RSS -3,3 %, erreurs 0
- journal/api-pages : CPU -0,2 %, RSS -0,4 %, erreurs 0

### Rustyx + mimalloc par rapport au nouveau build standard

- portail/async-512 : CPU -6,7 %, RSS 0,3 %, erreurs 0
- portail/mixed-128 : CPU -2,4 %, RSS 17,8 %, erreurs 0
- portail/api-fast : CPU -5,3 %, RSS 2,7 %, erreurs 0
- dashboard/ppr-html : CPU -1,7 %, RSS -0,4 %, erreurs 0
- dashboard/ppr-flight : CPU 0,4 %, RSS 2,2 %, erreurs 0
- dashboard/mixed-64 : CPU -3,6 %, RSS 3,1 %, erreurs 0
- journal/api-pages : CPU -10,6 %, RSS 3,4 %, erreurs 0

### Rustyx + PGO par rapport au nouveau build standard

- portail/async-512 : CPU -3,9 %, RSS -1,5 %, erreurs 0
- portail/mixed-128 : CPU -0,3 %, RSS -1,3 %, erreurs 0
- portail/api-fast : CPU -3,2 %, RSS 0,8 %, erreurs 0
- dashboard/ppr-html : CPU -3,2 %, RSS 1,1 %, erreurs 0
- dashboard/ppr-flight : CPU 0,4 %, RSS -1,6 %, erreurs 0
- dashboard/mixed-64 : CPU -2,5 %, RSS -4,8 %, erreurs 0
- journal/api-pages : CPU -7,4 %, RSS -0,9 %, erreurs 0

## Charges prolongées

portail · API · C512 / 30 s : Rustyx avant = 12 811 réponses/s, 0,200 ms CPU/réponse, 287,8 Mio RSS, P95 46,4 ms ; Rustyx nouveau = 12 657 réponses/s, 0,203 ms CPU/réponse, 286,7 Mio RSS, P95 47,3 ms ; Next.js = 6 043 réponses/s, 0,222 ms CPU/réponse, 396,1 Mio RSS, P95 105,5 ms. Nouveau face à avant : débit -1,2 %, CPU/réponse 1,3 %, RSS -0,4 %.

dashboard · PPR mixte · C64 / 30 s : Rustyx avant = 3 951 réponses/s, 0,555 ms CPU/réponse, 326,3 Mio RSS, P95 49,4 ms ; Rustyx nouveau = 3 665 réponses/s, 0,589 ms CPU/réponse, 317,8 Mio RSS, P95 53,7 ms ; Next.js = 2 091 réponses/s, 0,625 ms CPU/réponse, 336,1 Mio RSS, P95 71,9 ms. Nouveau face à avant : débit -7,2 %, CPU/réponse 6,1 %, RSS -2,6 %.

## Limites et choix de déploiement

Les artefacts immuables enregistrés par identifiant, le budget partagé des files de réponse et la continuation directe des seuls modèles PPR prouvés sont dans le runtime standard. Les autres continuations gardent leur encodage/décodage habituel. Le budget de 8 Mio porte sur les files et lectures Rust d’un pool, pas sur le RSS total ni sur les données déjà consommées.

L’admission adaptative reste optionnelle ; elle utilise la latence des en-têtes et l’occupation, sans mesure directe du CPU/RSS. Des refus éventuels ne constituent pas une réduction de coût à travail identique. Mimalloc ne modifie que Rust et a été mesuré sur macOS. La PGO repose sur ces applications et cette architecture ; ses données d’entraînement ne sont pas des mesures de performance. Aucun de ces choix ne garantit un gain sur chaque VPS.

Tous les processus serveur sont inclus dans le CPU/RSS. Le client partage le Mac mais est exclu de ces compteurs ; le RSS peut compter plusieurs fois les pages partagées. Aucune compilation, suite de tests ou instrumentation PGO n’est active pendant les mesures finales.
