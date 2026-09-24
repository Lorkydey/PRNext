# Résultats des optimisations d’admission et du PPR

Version finale : ordonnanceur Rust à connexions créées à la demande, jusqu’à 512 admissions API et 16 rendus React par worker, préparation statique PPR bornée et jeune génération RSC de 16 Mio. Les codes JavaScript/npm et React s’exécutent toujours dans Node ; l’admission et le transport sont gérés en Rust.

108 essais, 4 294 700 réponses validées, neuf vérifications de récupération réussies. Rustyx final ne produit aucune erreur hors surcharge C1024. Les 22 comparaisons fonctionnelles des trois projets passent, ainsi que 537 tests JavaScript, 124 tests Rust, 273 tests HTTP et 30 tests navigateur. TypeScript et Clippy passent également.

## Face à Rustyx avant cette intervention

Médianes de trois essais de 6 secondes. RSS médian en charge, pas plafond de mémoire.

| Scénario | Réponses/s avant → après | Variation débit | Variation CPU/réponse | RSS Mio avant → après |
|---|---:|---:|---:|---:|
| portail · API attente 30 ms · C64 | 488 → 1 985 | +306,9 % | -54,7 % | 121 → 145 |
| portail · API attente 30 ms · C512 | 488 → 13 697 | +2 704,6 % | Non comparable¹ | 137 → 278 |
| portail · Parcours mixte · C128 | 1 947 → 6 118 | +214,3 % | -23,4 % | 239 → 299 |
| portail · Proxy + SSR · C64 | 3 347 → 4 169 | +24,6 % | -5,3 % | 268 → 289 |
| dashboard · PPR HTML · C4 | 1 358 → 1 572 | +15,8 % | -11,6 % | 268 → 278 |
| dashboard · PPR Flight · C4 | 1 644 → 2 031 | +23,5 % | -17,9 % | 232 → 238 |
| dashboard · Parcours mixte · C64 | 2 776 → 3 116 | +12,3 % | -15,9 % | 265 → 282 |
| journal · API Pages POST · C4 | 19 361 → 19 085 | -1,4 % | +2,5 % | 138 → 136 |

¹ À C512, l’ancien moteur refuse une grande partie des tentatives. Son CPU par réponse utile inclut les refus : une baisse de ce ratio ne mesure pas seulement une accélération du code applicatif. Le gain de débit valide et la disparition des refus à C512 sont les indications pertinentes. À C64, les réponses de l’ancienne version restent valides, mais sa limite de 16 opérations actives bloque le débit.

## Face à Next.js 16.3.5

Même application source, version de production ; Next est compilé avec webpack. Un signe négatif sur CPU/RSS est favorable à Rustyx.

| Scénario | Débit Rustyx / Next | CPU par réponse | RSS |
|---|---:|---:|---:|
| portail · API attente 30 ms · C512 | 2,41× | -22,7 % | -23,2 % |
| portail · Parcours mixte · C128 | 3,07× | -47,5 % | -17,2 % |
| dashboard · PPR HTML · C4 | 1,82× | -19,8 % | +6,2 % |
| dashboard · PPR Flight · C4 | 1,39× | +6,9 % | -9,5 % |
| journal · API Pages POST · C4 | 1,50× | +20,3 % | -37,3 % |

Un coût CPU inférieur ne signifie pas nécessairement moins de CPU total : servir davantage de requêtes peut utiliser plus de cœurs. Les latences ne portent que sur les réponses valides ; les refus et erreurs sont comptés séparément.

## Charges prolongées : 45 secondes, une observation par moteur

portail : Rustyx avant = 495 réponses/s, 2,086 ms CPU/réponse, 157 Mio RSS, P95 568,7 ms ; Next = 6 094 réponses/s, 0,218 ms CPU/réponse, 403 Mio RSS, P95 106,8 ms ; Rustyx final = 12 845 réponses/s, 0,201 ms CPU/réponse, 293 Mio RSS, P95 46,8 ms. Face à la version précédente : débit +2 492,7 %, CPU par réponse non comparable¹, RSS +86,7 %, P95 -91,8 %. Face à Next : débit +110,8 %, CPU/réponse -7,7 %, RSS -27,4 %.

dashboard : Rustyx avant = 3 129 réponses/s, 0,738 ms CPU/réponse, 308 Mio RSS, P95 42,4 ms ; Next = 2 134 réponses/s, 0,604 ms CPU/réponse, 340 Mio RSS, P95 69,4 ms ; Rustyx final = 3 631 réponses/s, 0,598 ms CPU/réponse, 336 Mio RSS, P95 54,0 ms. Face à la version précédente : débit +16,0 %, CPU/réponse -18,9 %, RSS +9,1 %, P95 +27,3 %. Face à Next : débit +70,2 %, CPU/réponse -1,0 %, RSS -1,0 %.

La charge prolongée peut nuancer les essais courts : le préchauffage de V8, les collections mémoire et les ressources partagées de la machine évoluent. Une mesure de 45 secondes ne démontre pas l’absence de fuite sur plusieurs jours. Le PPR garde un aller-retour d’encodage/décodage du modèle vivant ; les préparations statiques ne suppriment pas ce travail. Dans cet essai prolongé PPR, les écarts face à Next sont de -1,0 % pour le CPU et -1,0 % pour le RSS. Des écarts proches de 1 % ne permettent pas de conclure à une supériorité sur ces deux métriques. Face à l’ancien Rustyx, le RSS passe de 308 à 336 Mio et le P95 de 42,4 à 54,0 ms. Le débit supérieur n’est donc pas un gain uniforme de latence. Les API Pages très rapides restent aussi un point à surveiller face à Next.

## Surcharge volontaire : C1024

Rustyx avant : 236 151 erreurs/refus sur 239 335 tentatives (98,67 %) ; HTTP 503 : 236 151. Récupération C4 : 0 erreur.

Next : 48 erreurs/refus sur 36 031 tentatives (0,13 %) ; ETIMEDOUT : 48. Récupération C4 : 0 erreur.

Rustyx final : 117 060 erreurs/refus sur 186 770 tentatives (62,68 %) ; HTTP 503 : 117 060. Récupération C4 : 0 erreur.

Les refus Rustyx sont intentionnels : 512 admissions API et 256 places d’attente par worker, avec délai borné, au lieu d’une accumulation sans limite. Le client relance immédiatement après chaque refus, sans respecter Retry-After. Ce taux n’est donc pas une prévision du taux d’erreur d’un site réel. Les éventuels ETIMEDOUT sont des erreurs de transport observées côté client dans cette rafale ; ces essais n’en identifient pas la cause et ne prouvent pas un défaut applicatif de Next. Le temps écoulé inclut la vidange des requêtes, ce qui peut pénaliser le débit mesuré en présence de délais réseau.

## Compromis CPU / RAM

La concurrence supplémentaire consomme plus de RAM sous forte charge que l’ancien plafond de 16 opérations. Le budget des corps reste de 32 Mio et les buffers de réponse restent bornés par flux, mais ce ne sont pas des plafonds globaux de RSS. Les connexions supplémentaires inactives ferment après 30 secondes. Les requêtes séquentielles réutilisent quelques connexions au lieu d’en ouvrir plusieurs centaines.

La préparation RSC conserve au plus huit représentations statiques détachées du décodeur, avec budget comptable de 512 Kio. Le mémo JSON garde au plus 16 artefacts et 256 Kio encodés ; les objets décodés s’ajoutent à cette limite. Les modèles vivants et les contextes visiteurs ne sont pas partagés. Les invalidations continuent à passer par le cache natif.

Le réglage V8 a fait l’objet d’une expérience séparée : deux passages de 30 secondes par valeur, ordre 8/16/32 puis 32/16/8, sur une copie du même build. Moyennes des deux passages :

| Jeune génération RSC | CPU ms/réponse | RSS Mio |
|---|---:|---:|
| 8 Mio | 0,633 | 303,0 |
| 16 Mio | 0,559 | 323,5 |
| 32 Mio | 0,537 | 349,2 |

16 Mio a été retenu comme compromis. La dispersion est visible dans les données brutes ; ces niveaux ne doivent pas être comparés directement à ceux d’une autre série. La campagne principale a été entièrement relancée après ce choix. Les résultats antérieurs restent dans heap8/ et pilot-results.json ; ils ne sont pas agrégés aux chiffres ci-dessus.

## Portée

Ces résultats montrent surtout l’intérêt de Rustyx pour un serveur combinant beaucoup d’attentes asynchrones avec des routes dynamiques. L’avantage n’est pas uniforme pour chaque route, chaque niveau de charge ou chaque budget CPU. Le transport Rust/Node et le runtime React officiel conservent un coût. Trois applications de démonstration, même avec des millions de réponses contrôlées, ne prouvent ni la compatibilité exhaustive Next.js/npm ni une capacité universelle en production.

Les essais sont exécutés un par un sur le même Mac Apple M4 de 16 Gio, sans compilations, tests ou profileurs en parallèle. Le client de charge partage la machine mais est exclu du CPU/RSS serveur. Des processus de bureau et les caches OS restent présents ; le RSS peut compter plusieurs fois des pages partagées. Consulter README.md pour le protocole, summary.csv pour les minimums/maximums et écarts-types, results.json pour chaque mesure et validation.json pour les contrôles arithmétiques indépendants.
