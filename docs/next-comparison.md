# PRNext / Next.js : CPU, RAM et concurrence

PRNext était nommé Rustyx lors de ces campagnes. Les rapports et données brutes conservent le nom utilisé pendant les mesures ; aucun résultat n'a été rechronométré pour le renommage.

## ISR, images, API Pages et PPR optimisés · 24 septembre 2026

[Rapport interactif](../reports/hot-path-optimization/performance.html) · [Analyse complète](../reports/hot-path-optimization/analysis.md) · [CSV](../reports/hot-path-optimization/summary.csv) · [Protocole](../reports/hot-path-optimization/README.md) · [Changements du runtime](hot-path-optimization.md).

**99 essais, 5 041 469 réponses valides, aucune erreur ; cinq projets et 36 comparaisons fonctionnelles réussies.** Ancien PRNext conservé, nouveau PRNext reconstruit et Next 16.3.5 / webpack, trois répétitions de cinq secondes par scénario. Un worker PRNext, sans PGO, allocateur alternatif ou option de tas V8. Les mesures incluent tous les processus serveur.

Médianes à quatre clients. Le CPU est le temps processeur par réponse valide ; le RSS est la mémoire résidente médiane en charge. Une variation CPU négative est favorable à PRNext.

| Scénario | CPU PRNext vs Next | RSS PRNext / Next, Mio | Débit PRNext / Next |
|---|---:|---:|---:|
| Hit ISR | −52,5 % | 9,6 / 211,1 | ×2,88 |
| Image déjà en cache | −81,0 % | 9,7 / 219,2 | ×2,77 |
| API Pages POST | −17,3 % | 138,9 / 213,9 | ×1,60 |
| API Pages GET | −11,9 % | 139,1 / 212,7 | ×1,56 |
| Flight PPR | −2,9 % | 227,8 / 249,1 | ×1,46 |
| HTML PPR | −22,8 % | 258,6 / 270,7 | ×1,87 |

**Le principal gain nouveau est le CPU.** Face à l'ancien PRNext de la même campagne, le CPU/réponse baisse de 43,4 % sur l'ISR, 86,3 % sur les images, 27,1 à 30,4 % sur les API Pages et 17,1 % sur Flight. La RAM des API varie de +0,6 à +1,7 %, celle de Flight baisse de 1,8 % : ces changements ne divisent pas la RAM des sites dynamiques. Le cache d'images encodées ajoute au plus 1 Mio comptable, partage ses octets entre réponses et évite les chemins disque sur un hit chaud. Une rétention du premier contexte App dans une promesse de chargement a également été corrigée et vérifiée par références faibles.

Les serveurs sont redémarrés entre essais. Les quelque 10 Mio des hits natifs correspondent à des routes servies sans démarrer Node ; un site ayant exécuté du JavaScript utilise davantage. À 512 clients sur l'API asynchrone, PRNext atteint 2,20× le débit de Next avec CPU/réponse −35,7 % et RSS −25,9 %, sans erreur. Le parcours PPR mixte à 64 clients coûte 32,3 % de CPU/réponse en moins que Next, mais augmente son RSS de 5,1 % face à l'ancien PRNext.

Sur **60 secondes de PPR mixte à 64 clients**, PRNext sert 4 124 réponses/s contre 1 897, avec CPU/réponse −15,9 % et RSS médian 333,4 contre 349,3 Mio (−4,6 %). Aucun échec en charge ni pendant la récupération. Après 15 secondes de repos, les RSS observés sont respectivement 152,1 et 167,4 Mio. Une observation par moteur, distincte des médianes courtes ; elle ne démontre pas l'absence d'une fuite lente.

Sur **30 secondes de Flight seul à quatre clients**, PRNext sert 2 309 réponses/s contre 1 401, avec CPU/réponse −4,9 % et RSS 242,4 contre 265,2 Mio (−8,6 %), sans erreur. Cette observation supplémentaire confirme la direction du gain, sans établir une avance CPU universelle ni être mélangée aux trois répétitions courtes.

**Le petit avantage CPU Flight face à Next reste incertain.** Les plages des répétitions se recouvrent. Une analyse du stockage macOS a aussi été observée à environ un cœur CPU en arrière-plan pendant cette campagne ; elle ne fait pas partie du CPU serveur mesuré, mais peut perturber les conditions. Toutes les répétitions sont conservées. Refaire les mesures sur un serveur Linux au repos avant de dimensionner un VPS ; aucun plafond global du RSS applicatif ni compatibilité Next exhaustive n'est démontré.

Validation : **554 tests JavaScript, 133 Rust, 273 HTTP et 45 navigateur ciblés**, TypeScript et Clippy réussis. Le binaire et les cinq candidats sont reconstruits. Reconstruire aussi tout autre projet importé pour mettre à jour sa copie du runtime. Les campagnes historiques ci-dessous restent distinctes.

## Comparaison avant ces optimisations · 24 septembre 2026

[Rapport interactif](../reports/next-runtime-comparison/performance.html) · [Analyse et limites](../reports/next-runtime-comparison/analysis.md) · [CSV](../reports/next-runtime-comparison/summary.csv) · [Protocole](../reports/next-runtime-comparison/README.md).

**300 essais, 16 094 037 réponses mesurées, aucune erreur ni refus, 44/44 comparaisons fonctionnelles, 48 builds et 12 récupérations réussis.** Six configurations aux sources identiques, Next 16.3.5 / webpack face au PRNext standard reconstruit, sans PGO, mimalloc ou admission adaptative. Mesures successives sur Apple M4 / 16 Gio ; aucun changement du moteur pendant les essais.

Parcours mixtes à quatre clients : médianes de trois passages de huit secondes. Les pourcentages comparent le coût CPU par réponse et le RSS de PRNext à ceux de Next ; une valeur négative est favorable. Les écarts de quelques pourcents ne sont pas conclusifs.

| Projet | Débit PRNext / Next | CPU par réponse | RSS |
|---|---:|---:|---:|
| Boutique Edge | ×5,75 | −62,5 % | −6,9 % |
| Boutique Node | ×2,68 | −15,1 % | −37,3 % |
| Journal Pages / i18n | ×2,65 | −32,4 % | −2,3 % |
| Dashboard PPR | ×1,86 | −10,3 % | −2,4 % |
| Portail SSR / proxy | ×1,04 | −19,6 % | −0,6 % |
| Documentation | ×1,88 | −11,9 % | −40,2 % |

À 512 clients sur l’API attendant 30 ms : **13 254 réponses/s pour PRNext contre 5 509**, CPU/réponse **−23,9 %**, RSS **−25,7 %**, sans erreur. Sur 60 secondes à 64 clients, PRNext conserve un meilleur débit sur les trois parcours prolongés ; la documentation utilise 44,9 % de RAM en moins mais 6,9 % de CPU supplémentaire par réponse. Ce sont des observations uniques par moteur.

**Next garde plusieurs avantages CPU.** PRNext coûte davantage par réponse sur le hit ISR de la documentation (+42,6 %), certaines API Pages et l’upload (+17,8 à +33,8 %), le PPR Flight (+26,4 %) et l’image déjà en cache (+13,9 %). Son meilleur débit sur ces routes ne signifie donc pas un meilleur coût CPU. Pour l’export JSON avec gzip accepté, PRNext utilise 42,8 % de CPU en plus mais compresse la réponse (−95,2 % d’octets), alors que Next la renvoie sans compression : le travail n’est pas identique. Les premiers rendus dynamiques après disponibilité du serveur sont aussi plus rapides avec Next dans les observations à froid, tandis que PRNext démarre son serveur et compile ces projets plus vite.

**PRNext présente un avantage mesuré sur les parcours complets, sans gagner sur tous les points.** Le RSS du journal, du PPR et du portail à faible concurrence reste proche de Next. Ces tests ne couvrent ni Turbopack, ni un export statique Next servi sans Node, ni les limites d’un VPS à un cœur ; ils ne prouvent pas la compatibilité Next exhaustive. Les campagnes ci-dessous décrivent les essais précédents et ne sont pas fusionnées avec ces chiffres.

## Campagne précédente · six pistes CPU / RAM du 24 septembre 2026

[Rapport interactif](../reports/resource-optimization/performance.html) · [Analyse complète](../reports/resource-optimization/analysis.md) · [CSV](../reports/resource-optimization/summary.csv) · [Mécanismes et activation](resource-optimization.md).

**90 essais, 5 183 144 réponses valides, aucune erreur sur les six variantes, 22/22 comparaisons fonctionnelles réussies et six récupérations réussies.** Trois applications aux sources identiques, Next 16.3.5 / webpack, Apple M4 / 16 Gio. Deux répétitions de six secondes pour les charges courtes ; une observation de 30 secondes pour chaque charge prolongée. Les petits écarts demandent confirmation.

Le runtime standard réutilise les artefacts PPR immuables entre threads, évite les conversions intermédiaires pour les seuls modèles PPR admissibles, et partage un budget de **8 Mio par pool** pour les lectures et files de réponse. Ce budget ne plafonne pas le RSS total. L’admission adaptative, mimalloc et la compilation PGO sont disponibles séparément et restent optionnels. Il faut reconstruire les projets pour mettre à jour leur copie du runtime.

**Les gains standard restent modestes et variables.** Le portail mixte économise 3,4 % de CPU par réponse face à la version précédente. Le PPR prolongé utilise 2,6 % de RAM en moins, mais son CPU par réponse augmente de 6,1 % et son débit baisse de 7,2 % sur cet essai unique ; le rapport conserve cette régression. Le budget des files apporte une borne vérifiée, sans gain universel de consommation.

La **PGO** présente le compromis le plus intéressant parmi les options mesurées : CPU de l’API Pages −7,4 %, RSS −0,9 % face au nouveau build standard. Mimalloc réduit ce CPU de 10,6 %, mais augmente le RSS du portail mixte de 17,8 %, avec une forte variation entre deux passages. L’admission adaptative n’apporte pas de gain CPU convaincant sur ces charges. Ces constats macOS ne suffisent pas à choisir un allocateur ou un profil PGO pour Linux.

Face à Next sur 30 secondes, le nouveau PRNext sert **2,09× plus de réponses/s** sur l’API à C512 avec **8,4 % de CPU/réponse et 27,6 % de RSS en moins**. Le PPR mixte sert **1,75× plus de réponses/s**, avec **5,8 % de CPU/réponse et 5,5 % de RSS en moins**. Ce sont les ratios de deux scénarios, pas un gain valable pour tous les sites.

Validation : **542 tests JavaScript, 130 Rust, 273 HTTP et 30 navigateur ciblés**, TypeScript et Clippy réussis. Les tests Rust et Clippy passent aussi avec mimalloc. Les calculs du rapport sont vérifiés indépendamment ; données et limites figurent dans le nouveau rapport. Les campagnes ci-dessous décrivent les versions précédentes.

## Campagne précédente · admission asynchrone et CPU PPR du 24 septembre 2026

[Rapport interactif](../reports/admission-ppr/performance.html) · [Analyse et limites](../reports/admission-ppr/analysis.md) · [CSV](../reports/admission-ppr/summary.csv) · [Données brutes](../reports/admission-ppr/results.json) · [Protocole](../reports/admission-ppr/README.md).

**108 essais avant / après / Next.js, 4 294 700 réponses validées, 22/22 comparaisons fonctionnelles réussies.** Aucune erreur du nouveau PRNext hors surcharge volontaire à 1 024 clients ; les neuf contrôles de récupération réussissent. Next 16.3.5 / webpack, trois applications aux sources identiques, un worker PRNext, serveurs mesurés successivement sur Apple M4 / 16 Gio.

L’ordonnanceur Rust crée ses connexions à la demande et réutilise les dernières libérées. Les API disposent de 512 admissions actives par worker, contre 16 auparavant ; les rendus React gardent une admission distincte de 16. Le pool reste partagé. Les corps entrants conservent un budget commun de 32 Mio ; les connexions supplémentaires inactives ferment après 30 secondes. Il faut **reconstruire le projet** pour bénéficier du nouveau worker ; les anciens builds conservent leur capacité antérieure.

Le PPR réutilise des représentations statiques bornées et détachées du décodeur, évite des promesses inutiles et mémorise les accès au modèle vivant uniquement pour la requête courante. Le JSON est réutilisé après validation par le cache natif. Chaque reprise HTML reçoit sa propre continuation React. Les valeurs non rejouables gardent le chemin ordinaire. La jeune génération du thread RSC passe de 8 à 16 Mio après essais comparatifs à 8/16/32 Mio ; les données de cette expérience sont conservées séparément.

Médianes de trois essais de six secondes ; CPU par réponse utile, RSS médian de tous les processus serveur. La ligne prolongée est une observation unique de 45 secondes par moteur.

| Scénario | Réponses/s avant → après | CPU/réponse : variation | RSS Mio avant → après |
|---|---:|---:|---:|
| API attente 30 ms · C64 | 488 → 1 985 | −54,7 % | 121 → 145 |
| API attente 30 ms · C512 | 488 → 13 697 | Non comparable : nombreux refus avant | 137 → 278 |
| Portail mixte · C128 | 1 947 → 6 118 | −23,4 % | 239 → 299 |
| Proxy + SSR · C64 | 3 347 → 4 169 | −5,3 % | 268 → 289 |
| PPR HTML · C4 | 1 358 → 1 572 | −11,6 % | 268 → 278 |
| PPR Flight · C4 | 1 644 → 2 031 | −17,9 % | 232 → 238 |
| PPR mixte · C64 / 45 s | 3 129 → 3 631 | −18,9 % | 308 → 336 |

Face à Next, l’API C512 sert **2,41× plus de réponses/s**, avec **22,7 % de CPU en moins par réponse** et **23,2 % de RSS en moins**. Sur 45 secondes, le gain de débit est de 2,11×, avec CPU/réponse −7,7 % et RSS −27,4 %. Ces ratios concernent cette API attendant 30 ms, pas toutes les routes.

**Compromis :** le PPR prolongé augmente son P95 de 42,4 à 54,0 ms face à l’ancien PRNext, malgré un meilleur débit. Son CPU/réponse et son RSS deviennent proches de Next (environ −1 %, écart insuffisant pour conclure). Sur les essais courts, Flight coûte encore 6,9 % de CPU par réponse de plus que Next, et le HTML PPR utilise 6,2 % de RSS supplémentaire. L’API Pages POST utilise 20,3 % de CPU/réponse de plus que Next ; face à l’ancien PRNext, le débit baisse de 1,4 % et le coût CPU augmente de 2,5 %, petits écarts à confirmer.

La concurrence supérieure utilise davantage de RAM que l’ancienne limite de 16 opérations : les budgets de corps et de caches ne sont pas un plafond global de RSS. À C1024, le nouveau PRNext produit 117 060 refus HTTP 503 (62,68 % des tentatives du client qui réessaie immédiatement), Next observe 48 ETIMEDOUT ; les causes de ces erreurs de transport ne sont pas établies par le banc. Tous récupèrent. Le rapport distingue les réponses valides, les refus et les limites de mesure ; il ne démontre pas la compatibilité Next exhaustive ni l’endurance sur plusieurs jours.

Validation : **537 tests JavaScript, 124 Rust, 273 HTTP et 30 navigateur ciblés**, TypeScript et Clippy réussis. Les statistiques sont recalculées et contrôlées indépendamment ; les 14 scénarios du rapport sont vérifiés dans le navigateur. Les campagnes antérieures ci-dessous sont conservées sans fusionner leurs résultats avec cette version.

## Campagne antérieure à cette optimisation · 300 passages

Nouvelle campagne enregistrée dans [le rapport interactif](../reports/current-comparison/performance.html), avec [analyse](../reports/current-comparison/analysis.md), [CSV](../reports/current-comparison/summary.csv), [données brutes](../reports/current-comparison/results.json) et [protocole](../reports/current-comparison/README.md). Les essais portent sur Next 16.3.5 compilé avec webpack et la version PRNext antérieure à l’optimisation d’admission, sans modifier le moteur pendant cette campagne.

**294 passages principaux, 17 182 538 réponses valides, aucune erreur ; 44/44 comparaisons fonctionnelles et 48 builds réussis.** Six essais supplémentaires de surcharge C512 sont comptés séparément : PRNext produit 571 247 refus HTTP 503, Next aucun. La récupération réussit dans tous les cas.

Parcours mixtes C4 : médianes de trois passages de huit secondes. Variations de PRNext par rapport à Next ; un coût CPU ou un RSS négatif est favorable.

| Projet | Débit PRNext / Next | CPU par réponse | RSS |
|---|---:|---:|---:|
| Boutique Edge | ×5,80 | −62,5 % | −5,1 % |
| Boutique Node | ×3,31 | −30,7 % | −36,1 % |
| Journal Pages / i18n | ×3,47 | −48,0 % | −7,4 % |
| Dashboard PPR | ×1,94 | −13,1 % | −5,0 % |
| Portail SSR / asynchrone | ×1,04 | −19,3 % | +10,2 % |
| Documentation · 100 pages | ×2,01 | −17,6 % | −40,7 % |

La charge prolongée nuance ce tableau : dashboard C64/60 s, débit +67 %, CPU/réponse +13 %, RSS −9 % ; portail, débit −19 %, CPU/réponse −25 %, RSS −35 % ; documentation, débit +128 %, CPU/réponse +8 %, RSS −42 %. Ce sont des observations uniques par moteur. À C512 sur l’API attendant 30 ms, PRNext sert environ 497 réponses/s contre 5 543 pour Next et refuse 98,58 % des tentatives du client agressif. L’admission asynchrone et le CPU PPR/Flight restent des priorités.

**PRNext présente un intérêt réel pour certaines charges, sans avantage universel sur CPU, RAM et capacité simultanément.** Les mesures locales, les effets d’échauffement, les différences de compression et la référence webpack sont détaillés dans le rapport. Les campagnes antérieures ci-dessous ne sont pas fusionnées avec ces chiffres.

## Optimisation du runtime et récupération sous charge

Campagne finale du 23 septembre 2026 : **72 passages**, **22/22 contrôles fonctionnels équivalents**, **4 264 995 réponses valides**, **zéro erreur sur les trois moteurs**. Le point de départ est la version PRNext de la campagne async précédente. Chaque ligne est la médiane de trois essais de huit secondes ; un worker PRNext.

Les corps entrants Rust–Node sont binaires, les manifestes React immuables sont réutilisés entre requêtes et les hits SQLite frais évitent les écritures pendant une fenêtre LRU d’une seconde, sans retarder les invalidations. Les réservations de corps suivent le passage middleware/rendu/proxy dans un budget partagé de 32 Mio, distinct du RSS. Le suivi des promesses applicatives et les surveillances natives permettent de retirer un worker bloqué après annulation, sans rejouer une mutation.

Le stress a également révélé un renouvellement excessif des connexions du cache. Le pool conserve désormais ses connexions entre rafales : **16 ouvertures contre 76** dans le test de six rafales de seize appels, avec un plafond inchangé de 32 connexions par pool et une expiration inactive à 30 secondes. La première campagne exploratoire est archivée ; tous les passages ci-dessous ont été refaits après correction.

| Scénario | CPU avant → après (ms/rép.) | CPU Next | Débit après / Next (req/s) | RAM avant → après (Mio) | RAM Next |
|---|---:|---:|---:|---:|---:|
| PPR HTML | 1,488 → 1,369 | 1,470 | 1 403 / 902 | 259,5 → 266,9 | 273,6 |
| PPR Flight | 1,145 → 1,031 | 0,821 | 1 766 / 1 441 | 240,8 → 248,2 | 264,3 |
| Dashboard · 128 clients | 0,825 → 0,688 | 0,767 | 3 587 / 1 877 | 305,0 → 289,8 | 381,4 |
| API Pages · POST 32 Kio | 0,204 → 0,137 | 0,128 | 16 384 / 10 056 | 227,2 → 223,2 | 241,6 |
| API Pages · POST court | 0,077 → 0,080 | 0,094 | 27 906 / 12 709 | 137,9 → 135,5 | 215,0 |
| API App immédiate | 0,128 → 0,127 | 0,181 | 16 557 / 6 864 | 174,7 → 177,9 | 263,9 |
| Proxy + SSR | 0,583 → 0,575 | 0,972 | 3 295 / 1 348 | 254,4 → 255,1 | 290,5 |
| Portail · 128 clients | 0,474 → 0,471 | 0,683 | 1 955 / 2 078 | 247,2 → 237,7 | 354,0 |

Le PPR Flight reste **25,5 % plus coûteux en CPU par réponse que Next.js**. L’API immédiate et le proxy changent peu face à la version précédente. La RAM varie selon le chemin et la phase du GC ; ces mesures ne garantissent pas une baisse uniforme. La continuation PPR directe, l’admission adaptative par catégorie et la comparaison de sockets Unix avec TCP restent des travaux distincts.

Autres compromis mesurés : le POST Pages très court utilise 3.1 % de CPU supplémentaire par réponse face à PRNext précédent ; le POST de 32 Kio utilise encore 6.6 % de CPU de plus que Next.js, malgré son débit supérieur. À 128 clients sur le portail, le débit PRNext est 5.9 % inférieur à Next.js. Les écarts de quelques pour cent demandent confirmation sur des essais plus longs.

Validation : **529 tests JavaScript, 124 Rust, 271 HTTP, 209 navigateur**, TypeScript, Clippy et formatage. Les dernières corrections ont aussi des vérifications ciblées d’uploads, d’annulation, de récupération et du cache.

[Rapport et graphiques](../reports/runtime-optimization/performance.html) · [Analyse](../reports/runtime-optimization/analysis.md) · [CSV](../reports/runtime-optimization/summary.csv) · [Données brutes](../reports/runtime-optimization/results.json) · [Validation](../reports/runtime-optimization/validation.json) · [Campagne exploratoire archivée](../reports/runtime-optimization/port-exhaustion.json).

## Optimisation async, concurrence, PPR et proxys

Campagne avant/après du 23 septembre 2026 : trois projets aux sources identiques, **114 passages mesurés**, **22/22 contrôles fonctionnels équivalents**, **2 389 535 réponses valides**. Aucun échec de réponse pour PRNext optimisé ou Next dans les passages retenus, y compris les trois stress à 128 clients sur chacun des deux projets. Les sept essais perturbés par l’épuisement des ports TCP du banc sont archivés puis rejoués après récupération.

Un worker PRNext traite désormais jusqu’à 16 opérations asynchrones simultanées, avec connexions locales séparées, annulation par connexion et attente bornée avant lecture des corps. Le proxy applicatif partage le pool de rendu. Le proxy externe conserve 16 flux actifs avec 256 demandes en attente. Les chemins PPR entièrement pré-rendus utilisent le cache natif et ses invalidations. Les anciens workers stdio restent pris en charge ; **recompiler le projet pour bénéficier du nouveau runtime**.

Médianes de trois passages, concurrence 4 sauf mention, un worker PRNext. RAM = RSS du serveur et de ses descendants.

| Scénario | PRNext avant req/s | PRNext après req/s | Next req/s | RAM PRNext avant → après (Mio) | RAM Next (Mio) |
|---|---:|---:|---:|---:|---:|
| API avec attente 30 ms | 30 | 118 | 116 | 78,9 → 81,9 | 126,3 |
| Streaming 80 ms | 12 | 47 | 47 | 116,7 → 130,3 | 137,1 |
| Proxy + SSR | 2 857 | 3 091 | 1 181 | 354,2 → 249,2 | 264,7 |
| PPR entièrement pré-rendu | 6 162 | 27 664 | 8 511 | 149,2 → 8,0 | 235,9 |
| Portail, 128 clients | 114 | 1 948 | 1 943 | 154,4 → 230,2 | 350,8 |
| Dashboard, 128 clients | 801 | 3 072 | 1 761 | 199,0 → 288,0 | 369,5 |

**Compromis conservés dans le rapport :** le CPU du PPR Flight personnalisé reste 36,5 % au-dessus de Next. L’API App immédiate utilise 8,4 % de CPU supplémentaire par réponse face à l’ancienne version, malgré un meilleur débit. La mémoire du dashboard mixte augmente de 204,9 à 250,1 Mio et devient comparable à Next. Le parallélisme n’implique donc pas une RAM inchangée pour chaque route. Les limites bornées de surcharge restent nécessaires.

Validation : 523 tests unitaires JavaScript, 120 Rust, 269 HTTP et 209 navigateur, TypeScript, formatage et Clippy. Le rapport détaille aussi les contrôles de 30 secondes à concurrence 8, le CPU total et par réponse, les latences, les pics RSS échantillonnés, les erreurs et les méthodes.

[Rapport avec graphiques](../reports/async-concurrency/performance.html) · [Analyse détaillée](../reports/async-concurrency/analysis.md) · [CSV](../reports/async-concurrency/summary.csv) · [Données brutes](../reports/async-concurrency/results.json) · [Essais perturbés archivés](../reports/async-concurrency/host-port-exhaustion.json).

## Audit de six configurations Next.js transférées vers PRNext

Campagne du 23 septembre 2026 : **cinq sites contrôlés et une variante Node**, conservés en **12 copies Next/PRNext aux sources identiques**. Deux nouveaux projets complètent les sites précédents : un portail avec SSR, proxy, npm, API asynchrones et streaming ; une documentation avec 100 pages SSG, ISR et revalidation. Aucun code du moteur PRNext n'a été modifié pendant cette campagne.

**44/44 contrôles fonctionnels équivalents, 48 builds réussis, 250 passages de charge comparatifs**, plus deux diagnostics à quatre workers. Les passages comparatifs valident **9 922 374 réponses**. Les routes, parcours mixtes et essais prolongés n'ont aucune erreur ; les stress à concurrence 128 produisent **448 637 erreurs chez PRNext** (HTTP 503 et ECONNRESET), contre aucune chez Next. Ces stress sont présentés séparément et ne prouvent pas une capacité de travail équivalente lorsque des demandes sont refusées.

Médianes des parcours mixtes : trois passages de 10 s, quatre connexions, un worker PRNext, serveurs successifs sur Apple M4 / 16 Gio. Next 16.3.5, React 19.3.0, Node 22.17.1. **Next → PRNext** :

| Projet | Débit (req/s) | CPU par réponse (ms) | RSS sous charge (Mio) | Écart CPU | Écart RAM |
|---|---:|---:|---:|---:|---:|
| Boutique Edge | 2 167 → 8 962 | 0,576 → 0,213 | 332,5 → 281,6 | -63,1 % | -15,3 % |
| Boutique Node pré-rendue | 7 343 → 25 990 | 0,161 → 0,106 | 259,1 → 163,9 | -34,2 % | -36,7 % |
| Journal Pages / i18n | 6 875 → 25 565 | 0,180 → 0,085 | 247,2 → 227,4 | -52,9 % | -8,0 % |
| Dashboard PPR | 1 795 → 2 193 | 0,727 → 0,701 | 285,8 → 260,7 | -3,6 % | -8,8 % |
| Portail SSR / attente asynchrone | 461 → 112 | 1,058 → 1,841 | 195,3 → 158,1 | +74,0 % | -19,1 % |
| Documentation 100 pages | 9 330 → 23 905 | 0,130 → 0,083 | 226,2 → 135,0 | -36,0 % | -40,3 % |

PRNext a davantage de débit sur **5 profils mixtes sur 6** et un RSS inférieur sur les six. La variante boutique Node pré-rend la page /edge : elle ne constitue pas un essai de SSR Node. Le portail mesure du SSR réellement dynamique et met surtout en évidence le blocage des appels asynchrones. Le faible écart CPU du dashboard mixte ne constitue pas une preuve statistique d'avantage.

### Priorités mises en évidence

- **Concurrence asynchrone** : l'API attendant 30 ms atteint environ 31 req/s avec un worker PRNext, contre 121 chez Next à concurrence 4. La boucle du worker attend la réponse et la fin du flux avant la demande suivante. Sur le portail mixte, quatre workers rétablissent environ **464 req/s**, mais consomment **575 Mio**, contre **158 Mio** avec un worker. Il faut viser plusieurs opérations simultanées bornées par worker pour améliorer la vitesse sans multiplier les heaps.
- **Saturation** : à concurrence 128, les refus PRNext vont de 0 % sur la documentation à 99,71 % sur le portail. Next ne produit pas d'erreur dans ces passages. Les 503 génèrent chacun un log ; admission, équité, limitation des journaux et resets restent à travailler. Le client de stress relance immédiatement, sans respecter Retry-After.
- **PPR et chemin statique** : Flight demeure plus coûteux en CPU, et /projet/atlas passe par JavaScript malgré un artefact pré-rendu. Le drapeau pprFallback sans ssg dans son manifeste empêche le chemin natif SSG. Le dashboard prolongé reste plus rapide et moins gourmand en RAM, avec environ 4 % de CPU par réponse en plus que Next.
- **Proxy + SSR** : le RSS monte à environ 338 Mio contre 264 Mio chez Next sur cette route, même si PRNext la sert plus vite. Les gains mémoire du parcours mixte ne s'appliquent donc pas à toutes les routes.
- **Volume et compression** : Next renvoie l'export JSON sans compression malgré Accept-Encoding: gzip ; PRNext passe d'environ 138 Kio à 6,6 Kio sur le réseau. Le contrôle identity confirme un meilleur débit PRNext sans gzip. Comparer CPU et octets conjointement.
- **Recompilation** : les builds PRNext sont rapides, mais un rebuild inchangé reste proche du build froid ; éviter les étapes dont les dépendances n'ont pas changé demeure une piste.

Le rapport détaille chaque route, API, image, SSR, PPR HTML/Flight, gzip, rotation des 100 pages, démarrage, volumes navigateur et essais de 60 s. Les builds et diagnostics de capacité sont des observations uniques ; les microbenchmarks répétés restent locaux, sans TLS, CDN, vraie base de données ni profil CPU par fonction. La RAM est le RSS additionné, pas uniquement le heap, et les forts débits peuvent être limités par le générateur. Ces fixtures ne démontrent pas une compatibilité Next universelle.

Une dépendance native Sharp endommagée dans la référence Next a été remplacée par la même version fonctionnelle déjà installée ; les images et parcours des boutiques ont été rejoués. La sonde Flight a été corrigée pour envoyer le paramètre _rsc attendu. Les observations initiales sont archivées, et les résultats finaux n'incluent pas ces passages non comparables.

[Rapport interactif complet](../reports/next-audit/performance.html) · [Données détaillées CSV / Excel](../reports/next-audit/measurements.csv) · [Synthèse CSV](../reports/next-audit/summary.csv) · [Vérifications](../reports/next-audit/validation.json) · [Projets et commandes](../examples/next-migration/README.md).

## Campagne précédente : coût CPU par réponse et débit PPR

La lecture PPR résout maintenant sa génération et son entrée dans une seule transaction Rust et un seul échange. SQLite réutilise ses requêtes préparées avec un plafond de 32 statements ; le décodeur SSR réutilise ses correspondances de modules avec des références faibles. Les limites des caches de données restent inchangées. Les invalidations, les leases et l'isolation des visiteurs sont conservés ; aucun modèle React personnalisé n'est ajouté au cache partagé.

Comparaison du même tableau de bord en production : **trois passages de 30 secondes par moteur**, huit connexions, 400 requêtes d'échauffement, serveur neuf, ordre tournant. L'ancien binaire et ses anciens modules sont restaurés pour chaque passage « avant ». Les chiffres sont les médianes des passages.

| Mesure | PRNext avant | PRNext optimisé | Next.js |
|---|---:|---:|---:|
| CPU par réponse (ms) | 0,789 | 0,595 | 0,595 |
| Débit (req/s) | 1 895 | 2 447 | 2 074 |
| RSS médian sous charge (Mio) | 265,4 | 270,3 | 301,0 |
| Latence p95 (ms) | 5,46 | 4,31 | 9,21 |

PRNext réduit son CPU par réponse de **24,6 %** et augmente son débit de **29,2 %**. La RAM augmente légèrement de **4,9 Mio (+1,8 %)** ; elle reste **10,2 % inférieure à Next** sur ces passages. Le CPU par réponse est comparable à Next, avec **18 % de débit supplémentaire**. Les RSS varient avec le GC : les neuf passages sont conservés dans le rapport, y compris le passage Next à 436 Mio.

Le contrôle distinct de **120 secondes par moteur** confirme un débit supérieur et un avantage RAM, mais un coût CPU encore un peu plus élevé que Next :

| Mesure prolongée | PRNext optimisé | Next.js |
|---|---:|---:|
| CPU par réponse (ms) | 0,566 | 0,545 |
| Débit (req/s) | 2 552 | 2 198 |
| RSS médian des dernières 30 s (Mio) | 282,9 | 305,5 |
| RSS après 15 s de repos (Mio) | 154,0 | 155,1 |

Sur ce passage : **+16,1 % de débit, −7,4 % de RAM sous charge, +3,9 % de CPU par réponse** face à Next. Il reste à réduire les encodages/décodages Flight et le parcours de l'arbre vivant pendant la reprise PPR. Les gains mesurés ne constituent pas une garantie sur toutes les applications ni une mesure de saturation maximale.

Validation : **523 tests unitaires JavaScript, 118 tests Rust, 265 tests HTTP, 209 tests navigateur**, TypeScript, formatage et Clippy passent. **30 scénarios de migration sur 30** passent. Les passages répétés et prolongés totalisent **1 148 067 réponses valides, sans erreur**, avec contrôle des cookies personnalisés.

[Rapport CPU/RAM avec graphiques](../reports/next-migration-cpu/performance.html) · [Méthode et détail des processus](../reports/next-migration-cpu/performance.md) · [Données répétées](../reports/next-migration-cpu/cpu-results.json) · [Contrôle prolongé](../reports/next-migration-cpu/stability.json) · [Tests des sites](../reports/next-migration-cpu/index.html).

## Campagne précédente : optimisation du PPR et de la mémoire Edge

Le transport du cache Rust local utilise désormais un pool HTTP persistant borné, sans passer par les objets Web de `fetch`. Les invalidations, leases, délais et annulations restent contrôlés. Le pool fonctionne hors des contextes de requêtes ; le test mémoire vérifie leur libération même avec les connexions persistantes ouvertes. La jeune génération V8 du worker RSC de production est limitée à 8 Mio ; la limite de l'ancienne génération reste inchangée. Aucun résultat personnalisé supplémentaire n'est conservé en cache.

Même machine, mêmes sources des sites et même protocole de charge mixte (trois passages de deux secondes, concurrence 4), avec Next rejoué :

| Mesure ciblée | PRNext avant | PRNext optimisé | Next rejoué |
|---|---:|---:|---:|
| RAM PPR (Mio) | 232.6 | 179.7 | 208.2 |
| CPU PPR (ms / 1 000 requêtes) | 1443 | 1094 | 1018 |
| Débit PPR (req/s) | 1149 | 1438 | 1418 |
| RAM boutique Edge (Mio) | 227.3 | 211.0 | 191.2 |

Le PPR mixte réduit son coût CPU par réponse d'environ **24 %**, sa RAM de **23 %**, et augmente son débit de **25 %**. Son débit devient proche de Next, avec environ **14 % de RAM en moins**, mais encore **8 % de CPU par réponse en plus**. La boutique Edge réduit sa RAM de **7 %**, tout en restant plus gourmande que Next. Les petites variations sur les parcours non ciblés restent dans quelques pour cent et ne sont pas des gains établis.

Validation : **520 tests unitaires, 265 tests HTTP, 209 tests navigateur**, vérifications TypeScript et **30 scénarios de migration sur 30** réussis. Les 48 mesures courtes ne contiennent aucune erreur. Les chiffres avant proviennent de la campagne précédente ; les conditions sont identiques, mais ce n'est pas une preuve statistique ou un plafond de capacité.

L’essai prolongé de **deux minutes par moteur à concurrence 8** traite **499 568 réponses sans erreur**. Sur les dernières 30 secondes, le RSS médian est de **282,5 Mio pour PRNext contre 310,6 Mio pour Next**. Next conserve toutefois un avantage : **2 204 contre 1 959 req/s**, et **543 contre 750 ms CPU pour 1 000 requêtes**. La RAM redescend au repos vers 159 / 156 Mio. Ce passage ne prouve pas l’absence de fuite sur plusieurs heures.

[Rapport avant/après](../reports/next-migration-optimized/optimization.html) · [Graphiques détaillés face à Next](../reports/next-migration-optimized/performance.html) · [Données brutes](../reports/next-migration-optimized/results.json).

## Campagne précédente : corrections Edge et migration de sites

Le 23 septembre 2026, deux défauts ont été corrigés : le CSS global d'un layout partagé avec Edge était rejeté pendant sa résolution ; les CSS/Sass Modules importés uniquement par un Server Component Edge ne publiaient pas leur feuille de style. La résolution interne est maintenant distinguée des imports exécutés dans la VM, et ces styles sont collectés pour le navigateur. Les restrictions des Route Handlers Edge restent appliquées. Aucun cache permanent supplémentaire n'est ajouté au serveur.

**30 scénarios de migration sur 30 passent**, avec les mêmes sources Next.js et PRNext : boutique Edge, variante Node, magazine multilingue Pages et tableau de bord PPR. La suite de validation passe aussi : 517 tests unitaires, 265 HTTP, 209 navigateur et vérifications TypeScript. Les couleurs des styles Edge sont testées avec esbuild et webpack.

Les mesures ci-dessous concernent les **charges mixtes propres à chaque site**, et non la fixture synthétique des campagnes précédentes. Médianes de trois répétitions de deux secondes, quatre requêtes concurrentes, 200 requêtes d'échauffement par moteur, serveur neuf et ordre alterné. Apple M4, Node 22.17.1, Next 16.3.5, PRNext 0.1.0-alpha.1. Le CPU inclut le serveur et ses descendants ; le client de charge est exclu. La RAM est le RSS additionné, pas seulement le heap JavaScript.

| Site | RAM Next / PRNext (Mio) | CPU Next / PRNext (ms / 1 000 requêtes) | Débit Next / PRNext (req/s) |
|---|---:|---:|---:|
| Boutique Edge | 191.9 / 227.3 | 791 / 297 | 1729 / 6627 |
| Boutique Node | 171.4 / 130.0 | 245 / 120 | 5612 / 23786 |
| Magazine Pages | 166.9 / 149.4 | 285 / 104 | 5063 / 23912 |
| Tableau de bord PPR | 209.8 / 232.6 | 1015 / 1443 | 1426 / 1149 |

**48 mesures de charge, 1,141,654 réponses valides, aucune erreur.** PRNext réduit le coût CPU par réponse et augmente le débit sur les boutiques et le magazine. La boutique Edge consomme toutefois davantage de RAM. Le tableau de bord PPR reste moins efficace : environ **42 % de CPU par réponse et 11 % de RAM supplémentaires**, avec un débit inférieur d'environ 19 %. Sa p95 mixte est meilleure (5,30 ms contre 7,10 ms), ce qui ne compense pas automatiquement son coût CPU supérieur.

Les accueils statiques PRNext utilisent environ 9–10 Mio sous charge, mais le coût mémoire augmente lorsque les workers JavaScript sont sollicités. Le rapport distingue accueil, charge mixte et relevé après parcours navigateur/API/actions. Les tests de charge n'appellent pas les Server Actions ; celles-ci sont couvertes par les tests fonctionnels. Les tailles HTML/RSC diffèrent entre moteurs. Ces mesures courtes et locales ne prouvent pas un gain universel ni la saturation maximale.

[Graphiques RAM/CPU/débit](../reports/next-migration/performance.html) · [Tableau complet et méthode](../reports/next-migration/performance.md) · [Captures et tests des sites](../reports/next-migration/index.html) · [Données brutes](../reports/next-migration/results.json) · [Diagnostic des corrections](../reports/next-migration/diagnostic-edge.md).

Commande de reproduction :

```sh
MIGRATION_BENCH=1 PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next node scripts/compare-migration-sites.mjs
```

## Campagne précédente : cache mémoire borné et API Pages

La version actuelle ajoute un cache de **4 Mio de contenu maximum, 256 entrées maximum**, alloué à la demande. Les clés et métadonnées s'ajoutent à ce plafond ; les réponses en cours peuvent conserver des octets après éviction. Il ne s'agit pas d'une limite de RAM totale. Les représentations HTML/JSON/assets et gzip construites d'au plus 64 Kio sont partagées sans recopier leur corps à chaque réponse. Les fichiers restent contrôlés pour détecter changements et remplacements. Les vérifications persistantes et les contrôles des chemins HTML/JSON sont regroupés dans une seule tâche bloquante, sans supprimer le confinement des chemins.

Les API Pages qui terminent un petit corps en un seul `end()` (dont `json()` et `send()`) évitent le flux intermédiaire et groupent les trames Rust–Node. Le seuil est de 16 Kio ; un `write`, `writeHead` ou `flushHeaders` préalable conserve le streaming. Les callbacks, cookies, corps binaires et réponses progressives restent pris en charge. **Aucune réponse API dynamique n'est mise en cache.** Les paramètres et limites sont décrits dans [performance.md](performance.md).

Le comparatif rejoue trois passages de 13 scénarios sous Next.js, PRNext avant et PRNext actuel. L'ancien moteur utilise son ancien binaire **et ses anciens modules `api.mjs` / `transport.mjs`** ; les autres fichiers du build applicatif sont identiques. Les mesures regroupent les effets du cache, du regroupement des opérations sur fichiers et du chemin API allégé : elles n'isolent pas le gain du cache seul.

| Parcours | CPU Next (ms/rép.) | PRNext avant | PRNext actuel | Baisse CPU avant → actuel | Hausse débit PRNext |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pages statique | 0,1067 | 0,1406 | 0,0961 | 31,6 % | 28,7 % |
| App statique | 0,1470 | 0,1444 | 0,0969 | 32,9 % | 30,3 % |
| API Pages | 0,0938 | 0,1124 | 0,0844 | 24,9 % | 19,9 % |
| Pages statique gzip | 0,1671 | 0,1642 | 0,1206 | 26,6 % | 22,8 % |
| App statique gzip | 0,2607 | 0,1622 | 0,1138 | 29,8 % | 23,6 % |

Pages statique et API Pages utilisent désormais respectivement **9,9 % et 10,0 % de CPU en moins que Next.js** sur cette fixture. Les débits actuels sont de 27 640 et 20 562 réponses/s. Les écarts CPU des parcours non ciblés Pages SSR (+0,6 %), App SSR (+1,2 %) et API App (+2,7 %) restent faibles sur ces trois passages ; ils ne constituent pas une preuve d'équivalence statistique.

| RSS médiane sous charge | PRNext avant | PRNext actuel |
| --- | ---: | ---: |
| Pages statique | 8,03 Mio | 8,00 Mio |
| App statique | 8,33 Mio | 8,06 Mio |
| API Pages | 137,05 Mio | 133,73 Mio |
| Application mixte | 263,72 Mio | 264,52 Mio |

Cette petite fixture ne remplit pas le cache. La RAM statique reste proche et l'application mixte augmente de 0,80 Mio (+0,3 %). Ces RSS incluent allocations et pages résidentes du serveur : elles ne mesurent pas seulement les octets du cache et ne garantissent pas une absence de hausse mémoire sur un gros projet.

Pour **70 000 requêtes identiques sur une seule instance**, PRNext passe de **17,18 à 15,92 secondes CPU** (−7,3 %) et de **9,63 à 9,25 secondes écoulées** (−4,0 %). Next.js mesure 26,63 secondes CPU, 21,71 secondes écoulées et 305,34 Mio de RSS. Les tableaux présentent les médianes des trois passages.

Validation : **117 mesures de charge, 6 376 627 réponses valides, aucune erreur**, y compris les essais SSR à huit connexions. Les six contrôles Chromium d'hydratation passent. Les contrôles de code couvrent 117 tests Rust, 489 tests unitaires JavaScript, 263 tests HTTP et 37 tests navigateur ciblés, ainsi que formatage et Clippy. Un contrôle complémentaire vérifie le streaming après destruction d'une réponse dont seuls les en-têtes ont été envoyés.

[Résultats bruts de cette campagne](benchmark-next-cache-api-local.json). Le protocole et les limites du microbenchmark décrits plus bas restent applicables. Pour reproduire les trois moteurs, fournir `BENCH_BASELINE_BINARY` et `BENCH_BASELINE_RUNTIME_DIR` avec les anciens modules `.mjs` ; leurs empreintes sont conservées dans le JSON. Les variables `BENCH_GZIP=1 BENCH_MIXED=1` activent les mêmes variantes et la charge globale.

## Rapport Word et Excel : campagne antérieure au cache mémoire

Cette campagne antérieure au cache mémoire compare uniquement Next.js et PRNext, sur trois passages, avec une charge mixte supplémentaire de **70 000 requêtes par moteur et par passage**. Une seule instance traite 10 000 requêtes sur chacun des sept parcours. Les résultats ci-dessous sont les médianes historiques utilisées dans les fichiers Word et Excel ; les chiffres de la version actuelle figurent dans la première section.

| Charge mixte | Next.js | PRNext | Réduction PRNext |
| --- | ---: | ---: | ---: |
| Temps pour 70 000 réponses | 21,52 s | 9,62 s | 55,3 % |
| Temps CPU serveur cumulé | 26,44 s | 17,07 s | 35,4 % |
| RSS globale médiane | 307,8 Mio | 262,4 Mio | 14,8 % |
| Pic RSS, médiane des passages | 312,2 Mio | 269,2 Mio | 13,8 % |

Les 78 mesures de charge ont validé 3 885 563 réponses, sans erreur. Les quatre contrôles d’hydratation passent. Next.js conserve un avantage CPU sur Pages statique et API Pages. Ces microbenchmarks courts ne prouvent ni une compatibilité complète ni un gain universel. Le CPU total baisse sur la charge mixte, mais PRNext mobilise davantage de cœurs en moyenne pendant son exécution plus courte.

[Rapport Word](../reports/next-vs-prnext/Rapport-PRNext-vs-Nextjs.docx) · [Excel avec graphiques modifiables](../reports/next-vs-prnext/PRNext-vs-Nextjs.xlsx) · [Données brutes](../reports/next-vs-prnext/mesures-brutes.json)

Pour reproduire cette campagne, utiliser `BENCH_GZIP=1 BENCH_MIXED=1 BENCH_OUTPUT=reports/next-vs-prnext/mesures-brutes.json` avec la commande de benchmark documentée plus bas. Le générateur de documents est `scripts/report-next-comparison.py` ; ses dépendances sont dans `scripts/report-requirements.txt`.

## Campagne précédente : optimisation avant/après

Mise à jour après optimisation native du 2026-09-23. Le même benchmark compare **Next.js 16.3.5**, **PRNext avant** et **PRNext après**. L’ancien binaire est celui du [premier comparatif](benchmark-next-comparison-local.json), vérifié par SHA-256 ; les sources de l’application sont identiques.

## Ce qui a changé

- Les petits fichiers (64 Kio maximum par représentation, gzip compris) sont ouverts, inspectés et lus dans une seule tâche bloquante. Les fichiers plus gros, les plages d’octets, les requêtes conditionnelles et les négociations pondérées restent servis par le chemin de streaming existant.
- Les recherches de fichiers publics absents vérifient leur existence avant de parcourir tous les parents du chemin avec `canonicalize`. Un fichier existant reste soumis au contrôle de confinement, y compris les liens symboliques. Les variantes gzip périmées restent exclues.
- Aucun cache persistant de fichiers n’est ajouté : les modifications sur disque restent visibles immédiatement et la mémoire ne dépend pas du nombre de fichiers déjà visités.
- La limite de refus immédiat de cinq requêtes dynamiques par worker est remplacée par **quatre requêtes avec corps chargé par worker**, puis **jusqu’à 64 demandes en attente par worker**, plafonnées à 1 024 au total. L’attente précède la lecture du corps et expire après 30 secondes. La capacité se libère à l’annulation ; les enveloppes de jobs annulés ne provoquent plus de faux refus de nouvelles requêtes admises.
- Une file réellement pleine conserve le `503` avec `Retry-After: 1` ; une attente expirée renvoie `504`. Les longues réponses en streaming continuent d’occuper leur worker. Le nombre de workers Node n’a pas augmenté.

## CPU avant / après PRNext

Temps CPU cumulé de Rust et de ses descendants par réponse valide. Médianes de trois passages, quatre requêtes simultanées. « Gzip » désigne les requêtes HTTP compressées ; le client vérifie le contenu après décompression.

| Parcours | CPU avant (ms/rép.) | CPU après (ms/rép.) | Baisse CPU | Débit après/avant | RSS après (Mio) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fichier public 32 Kio | 0,131 | 0,064 | 51,1 % | ×1,44 | 8,4 |
| Pages pré-rendu | 0,274 | 0,138 | 49,6 % | ×1,69 | 8,0 |
| App pré-rendu | 0,279 | 0,139 | 50,1 % | ×1,67 | 8,4 |
| Fichier public 32 Kio · gzip | 0,208 | 0,104 | 50,0 % | ×1,67 | 17,0 |
| Pages pré-rendu · gzip | 0,269 | 0,152 | 43,5 % | ×1,53 | 8,0 |
| App pré-rendu · gzip | 0,266 | 0,148 | 44,4 % | ×1,51 | 8,0 |

## Huit requêtes simultanées

Test distinct de deux secondes par passage, après chauffe à quatre connexions. Le client relance une demande dès qu’une réponse arrive, sans attendre `Retry-After`. Les taux de refus de l’ancienne version décrivent cette charge de saturation ; ils ne représentent pas un trafic réel avec temporisation.

| Route | Moteur | Erreurs / tentatives, trois passages | Taux d’erreur | p95 des réponses valides (ms) |
| --- | --- | ---: | ---: | ---: |
| pages-ssr-c8 | Next.js | 0 / 19 217 | 0,0 % | 4,68 |
| pages-ssr-c8 | PRNext avant | 139 130 / 187 175 | 74,3 % | 0,97 |
| pages-ssr-c8 | PRNext après | 0 / 58 043 | 0,0 % | 1,06 |
| app-ssr-c8 | Next.js | 0 / 6 513 | 0,0 % | 8,88 |
| app-ssr-c8 | PRNext avant | 155 960 / 164 330 | 94,9 % | 4,86 |
| app-ssr-c8 | PRNext après | 0 / 9 995 | 0,0 % | 5,97 |

Les erreurs de l’ancienne version sont des 503. **Le nouveau binaire ne renvoie aucune erreur dans les six passages à huit requêtes simultanées.** Les tests HTTP vérifient en plus des rafales de 32 requêtes Pages SSR, App SSR et POST, puis une surcharge de 96 demandes bloquées : 68 restent admises ou en attente et 28 reçoivent un 503, avant reprise normale du serveur.

## Next.js / PRNext après optimisation

RAM = RSS cumulée du serveur et de ses processus Node, threads RSC inclus. Valeur médiane sous charge, puis médiane des trois passages. Les réponses HTML/API de ce tableau utilisent `Accept-Encoding: identity`.

| Scénario | RSS Next (Mio) | RSS PRNext (Mio) | Next réponses/s | PRNext réponses/s | Ratio débit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fichier public 32 Kio | 213,8 | 8,4 | 23 233 | 32 067 | ×1,38 |
| Pages pré-rendu | 230,0 | 8,0 | 11 201 | 21 813 | ×1,95 |
| App pré-rendu | 229,0 | 8,4 | 8 031 | 21 345 | ×2,66 |
| Pages SSR | 202,8 | 111,8 | 3 476 | 10 104 | ×2,91 |
| App SSR | 273,8 | 245,1 | 1 156 | 1 756 | ×1,52 |
| API Pages | 229,1 | 139,7 | 13 078 | 17 175 | ×1,31 |
| API App | 254,8 | 164,8 | 6 726 | 15 088 | ×2,24 |

| Scénario | CPU Next (ms/rép.) | CPU PRNext (ms/rép.) | CPU PRNext/Next | p95 Next (ms) | p95 PRNext (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fichier public 32 Kio | 0,073 | 0,064 | ×0,88 | 0,25 | 0,18 |
| Pages pré-rendu | 0,106 | 0,138 | ×1,31 | 0,63 | 0,25 |
| App pré-rendu | 0,147 | 0,139 | ×0,95 | 0,84 | 0,26 |
| Pages SSR | 0,389 | 0,131 | ×0,34 | 2,06 | 0,49 |
| App SSR | 1,158 | 0,861 | ×0,74 | 4,47 | 3,06 |
| API Pages | 0,094 | 0,112 | ×1,19 | 0,53 | 0,33 |
| API App | 0,192 | 0,116 | ×0,61 | 1,20 | 0,38 |

Le coût CPU ne devient pas inférieur à Next.js sur tous les parcours. Le rendu React dynamique utilise toujours Node : son coût CPU et sa RAM évoluent peu avec ces modifications du serveur Rust. Un débit plus élevé ne signifie pas automatiquement moins de CPU par réponse.

## Mémoire à nombre de requêtes identique et pics

Les mesures après 1 000 requêtes de chauffe comparent un nombre identique de réponses, contrairement aux passages chronométrés où le moteur le plus rapide traite plus de requêtes. Les pics sont les médianes des maxima échantillonnés de chaque passage.

| Scénario | Après 1 000 Next (Mio) | Après 1 000 PRNext (Mio) | Pic Next (Mio) | Pic PRNext (Mio) |
| --- | ---: | ---: | ---: | ---: |
| Fichier public 32 Kio | 127,7 | 7,9 | 217,0 | 8,5 |
| Pages pré-rendu | 128,5 | 7,7 | 232,8 | 8,0 |
| App pré-rendu | 128,8 | 7,9 | 238,0 | 8,4 |
| Pages SSR | 148,0 | 85,2 | 236,9 | 118,9 |
| App SSR | 237,5 | 197,6 | 285,6 | 250,5 |
| API Pages | 130,5 | 89,9 | 230,3 | 140,0 |
| API App | 144,1 | 88,2 | 260,7 | 165,7 |

## Build, démarrage et navigateur

| Mesure | Next.js | PRNext après |
| --- | ---: | ---: |
| Build de la fixture | 2,037 s | 0,511 s |
| Pic RSS échantillonné du build | 2 099,9 Mio | 208,9 Mio |
| Sorties du build | 42,7 Mio | 4,1 Mio |
| Démarrage HTTP, sonde fichier public | 155,9 ms | 27,1 ms |
| Première requête Pages SSR, HTTP déjà prêt | 17,2 ms | 61,5 ms |
| Première requête App SSR, HTTP déjà prêt | 30,7 ms | 112,4 ms |
| JS chargé sur /pages-static, compressé | 119,1 Kio | 84,2 Kio |
| JS chargé sur /app-static, compressé | 130,6 Kio | 89,3 Kio |

PRNext lance Node à la première requête dynamique : son démarrage HTTP est court, mais cette première requête est plus longue. Le JavaScript du navigateur n’a pas été modifié par cette optimisation native. Le compteur a été hydraté et cliqué dans un contexte Chromium neuf pour les deux pages et les trois moteurs, sans erreur JavaScript.

Les builds effacent `.next` / `.prnext`, mais ne vident pas le cache disque du système. Ils excluent l’installation des dépendances et la compilation préalable de PRNext. Next utilise son Turbopack et ses neuf workers de collecte/pré-rendu par défaut. La taille des sorties inclut les caches propres à chaque build, mais exclut les dépendances et le binaire Rust : elle ne mesure pas un déploiement complet.

## Protocole et limites

- Apple M4, 10 cœurs logiques, 16 Gio, Darwin 24.6.0, Node v22.17.1. Next.js 16.3.5, dépendances React/react-dom 19.3.0, PRNext 0.1.0-alpha.1.
- Même source applicative : liste de 100 lignes et compteur React, API JSON de 20 valeurs, fichier public de 32 Kio. Aucun appel distant ni base applicative. Les deux binaires PRNext utilisent exactement le même build et runtime JavaScript.
- Trois passages, ordre des trois moteurs alterné. Serveur neuf par scénario, un worker PRNext, configuration Next par défaut. Sonde de disponibilité statique, première requête, 1 000 réponses de chauffe puis quatre secondes à quatre connexions HTTP keep-alive ; les essais à huit connexions durent deux secondes.
- Statut et contenu vérifiés à chaque réponse. Un identifiant variable doit être reflété par les routes dynamiques. Les erreurs ne sont pas comptées dans le débit des réponses valides. Les fichiers gzip sont décompressés par le client pour vérifier leur contenu.
- RSS de tous les processus du serveur relevée toutes les 150 ms environ, client et navigateur exclus. Les pages mémoire partagées peuvent être comptées plusieurs fois ; ce n’est pas une mesure de mémoire physique unique. Un pic bref peut échapper à l’échantillonnage.
- CPU = différence des temps CPU cumulés de l’arbre de processus via `ps`. Le client HTTP tourne sur la même machine et peut devenir limitant sur les parcours les plus rapides. Les tests ne mesurent ni énergie électrique ni capacité maximale sur un serveur dédié.
- Trois passages courts ne démontrent ni absence de fuite mémoire ni stabilité de production. Les variations de RAM avec la durée, le ramasse-miettes et le débit ne sont pas des preuves de rétention illimitée.
- Images, routages complexes, ISR/PPR, modules npm lourds, compilation incrémentale et HMR ne sont pas évalués par ce microbenchmark. Aucune compatibilité Next.js à 100 % ni accélération universelle n’est déduite de ces chiffres.

## Validation du changement

- 115 tests Rust, dont admission bornée, expiration, annulation, récupération après jobs annulés, gzip, plages d’octets, validateurs et confinement des liens symboliques.
- 263 tests HTTP, dont les nouvelles rafales de rendu et de POST, la surcharge bornée et la reprise.
- 49 tests Chromium ciblés : hydratation, navigation Pages/App, pages statiques, streaming, middleware, configuration et Server Actions. Six vérifications Chromium supplémentaires dans le comparatif.
- `cargo fmt --check`, Clippy sur tous les targets avec avertissements interdits et compilation release réussis.

## Reproduire

```sh
PRNEXT_NEXT_REFERENCE=/chemin/vers/node_modules/next \
BENCH_GZIP=1 \
BENCH_OUTPUT=docs/benchmark-next-optimized-local.json \
npm run bench:next
```

Ajouter `BENCH_BASELINE_BINARY=/chemin/vers/prnext-avant` pour comparer aussi un binaire antérieur. La comparaison des deux binaires utilise le même build applicatif : elle isole des modifications natives, pas des modifications du compilateur ou du runtime JavaScript. Sans cette variable, le script compare uniquement Next et PRNext actuel.

La fixture temporaire est créée sous le dossier parent de l’installation Next puis supprimée. Les paramètres, sources et empreintes SHA-256 sont enregistrés dans les résultats. Les budgets de RAM restent ceux du serveur existant ; aucun paramètre de workers ou de mémoire n’a été augmenté pour les résultats après optimisation.

[Nouveaux résultats bruts](benchmark-next-optimized-local.json) · [Premier comparatif conservé](benchmark-next-comparison-local.json) · [Script](../scripts/bench-next-comparison.mjs)
