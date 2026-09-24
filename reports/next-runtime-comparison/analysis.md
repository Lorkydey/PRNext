# Rustyx face à Next.js après reconstruction

**Rustyx est le plus intéressant sur les parcours mixtes mesurés pour le débit et le coût CPU, et sur plusieurs projets pour la RAM. Il ne gagne pas sur tous les points : Next reste plus économe en CPU sur plusieurs routes isolées et répond plus vite à la première requête dynamique après disponibilité du serveur.** Ce constat concerne ces applications et ce matériel.

**300 essais, 16 094 037 réponses valides, aucune erreur ni refus.** Les 294 passages principaux totalisent 15 810 197 réponses ; les six passages API à 512 clients, 283 840. Les 44 comparaisons fonctionnelles appariées, 48 builds et 12 contrôles de récupération réussissent. Les réponses d’échauffement et de récupération sont séparées de ce total.

## Parcours complets à quatre clients

Médianes de trois passages de huit secondes, Rustyx par rapport à Next. Un pourcentage CPU/RSS négatif est favorable. Il n’y a pas de score global pondéré arbitrairement : le poids des routes dépend du site réel.

- Boutique Edge : débit ×5,75, CPU/réponse -62,5 %, RSS -6,9 %, P95 5,60 → 0,84 ms.
- Boutique Node : débit ×2,68, CPU/réponse -15,1 %, RSS -37,3 %, P95 1,00 → 0,30 ms.
- Journal Pages / i18n : débit ×2,65, CPU/réponse -32,4 %, RSS -2,3 %, P95 1,56 → 0,35 ms.
- Dashboard PPR : débit ×1,86, CPU/réponse -10,3 %, RSS -2,4 %, P95 6,18 → 3,75 ms.
- Portail SSR / proxy : débit ×1,04, CPU/réponse -19,6 %, RSS -0,6 %, P95 32,31 → 32,26 ms.
- Documentation : débit ×1,88, CPU/réponse -11,9 %, RSS -40,2 %, P95 1,08 → 0,37 ms.

Le débit et le P95 sont nettement meilleurs sur cinq parcours. Le portail, limité par son attente applicative, a une latence pratiquement identique et un petit écart de débit. La RAM du journal, du dashboard et du portail est trop proche pour parler d’un avantage convaincant ; les écarts ne sont que de 0,6 à 2,4 %. La boutique Node et la documentation économisent respectivement 37,3 % et 40,2 % de RSS sur ces parcours.

## Cas où Next dépense moins de CPU

Les valeurs ci-dessous sont le surcoût CPU observé de Rustyx par réponse par rapport à Next, sur trois passages de cinq secondes. Attention : l’export gzip n’effectue pas un travail identique, puisque seul Rustyx compresse cette réponse ; il est détaillé plus bas. Rustyx conserve un meilleur débit, un P95 inférieur et un RSS inférieur dans ces mêmes cas : le parallélisme et le coût CPU par réponse sont deux critères différents.

- Portail SSR / proxy / Export JSON volumineux / gzip (gzip accepté par le client) : CPU Rustyx +42,8 %, débit ×1,26, RSS -23,2 %.
- Documentation / Page ISR déjà calculée : CPU Rustyx +42,6 %, débit ×1,56, RSS -96,2 %.
- Documentation / API Pages GET : CPU Rustyx +33,8 %, débit ×1,36, RSS -36,4 %.
- Journal Pages / i18n / API Pages POST 32 Kio : CPU Rustyx +33,7 %, débit ×1,25, RSS -12,9 %.
- Dashboard PPR / PPR Flight personnalisé : CPU Rustyx +26,4 %, débit ×1,17, RSS -9,7 %.
- Journal Pages / i18n / API Pages POST : CPU Rustyx +17,8 %, débit ×1,51, RSS -37,0 %.
- Boutique Edge / Image optimisée déjà calculée : CPU Rustyx +13,9 %, débit ×1,65, RSS -93,3 %.

Pour économiser le CPU à travail comparable, les priorités observées sont les hits ISR, les API Pages et l’upload, le PPR Flight, puis les images chaudes. Le cas de l’export gzip ci-dessus demande une lecture différente : Next n’a pas compressé la réponse, Rustyx l’a fait. Ce classement repose sur des coûts observés, sans profilage par fonction ; il ne prouve pas la cause interne de chaque surcoût. Les API App et le proxy local ont au contraire un avantage CPU avec Rustyx dans cette campagne.

## Concurrence, charge prolongée et récupération

À 512 clients sur l’API attendant 30 ms, Rustyx sert 13 254 réponses/s contre 5 509 pour Next, soit ×2,41. Son CPU/réponse varie de -23,9 %, et son RSS de -25,7 % (270,9 contre 364,6 Mio). P95 : 43,8 contre 96,4 ms. Les trois passages de chaque moteur réussissent ; 512 clients n’ont donc pas provoqué de refus ici.

Chaque parcours prolongé dure 60 secondes à 64 clients ; une seule observation par moteur, à lire séparément des répétitions courtes.

- Dashboard PPR : débit ×1,82, CPU/réponse -7,6 %, RSS -4,4 %, P95 71,74 → 52,60 ms.
- Portail SSR / proxy : débit ×2,36, CPU/réponse -26,2 %, RSS -7,8 %, P95 42,21 → 33,81 ms.
- Documentation : débit ×2,26, CPU/réponse 6,9 %, RSS -44,9 %, P95 19,28 → 5,62 ms.

La documentation prolongée illustre la limite d’un verdict unique : Rustyx sert 2,26× plus de réponses avec 44,9 % de RAM en moins, mais dépense 6,9 % de CPU supplémentaire par réponse. La charge légère reprend sans erreur après les six essais prolongés et les six essais à 512 clients. Cela ne démontre pas une endurance sur plusieurs jours ni le comportement au-delà de 512 clients.

## Builds, démarrage et première réponse

Les builds initiaux Rustyx prennent de 0,39 à 0,68 seconde contre 2,39 à 5,36 secondes pour Next/webpack sur ces projets. Les builds sans modification et après changement du titre sont aussi plus rapides. Le pic RSS observé pendant le build initial est de 178–228 Mio pour Rustyx et 893–1 260 Mio pour Next. Ces builds sont des observations uniques ; le pic peut être sous-échantillonné sur un build bref. Le moteur Rust est déjà compilé, comme le framework Next est déjà installé ; la compilation native initiale n’est pas comprise.

La disponibilité du serveur, sondée sur un fichier public, arrive vers 29 ms pour Rustyx contre 176–195 ms pour Next. Cela ne signifie pas que le worker React est déjà prêt. Sur le premier accès au dashboard, après disponibilité, Next répond en 40 ms contre 133 ms pour Rustyx ; sur le portail, 41 ms contre 125 ms. Le démarrage à la demande du worker Rustyx explique une partie de ce compromis. Ces premiers accès sont des observations uniques ; ils ne sont pas les latences à chaud.

## Images, compression et JavaScript côté navigateur

La première optimisation d’image mesurée prend 6,1 ms avec Rustyx contre 29,4 ms avec Next, pour un résultat vérifié de même format et mêmes dimensions. Ce point est une observation unique. Pour les images déjà en cache, les trois essais donnent un meilleur débit et beaucoup moins de RSS à Rustyx, mais 13,9 % de CPU supplémentaire par réponse.

La compression n’a pas un vainqueur unique. Sur les pages statiques, les deux moteurs servent gzip et Rustyx dépense moins de CPU. Sur le fichier public, Rustyx dépense aussi moins de CPU, mais transfère environ 8 % d’octets supplémentaires. Pour l’export JSON avec gzip accepté, Next renvoie ici 141 815 octets sans compression ; Rustyx renvoie environ 6 820 octets gzip, soit 95,2 % de trafic en moins. Son CPU par réponse est 42,8 % plus élevé, mais il effectue donc du travail supplémentaire : ce n’est pas la preuve d’un compresseur moins efficace. Le scénario export-identity fournit la comparaison sans compression, avec un corps de même taille : Rustyx y sert 34,3 % de réponses supplémentaires avec 14,9 % de CPU par réponse et 21,6 % de RSS en moins. Les encodages et volumes réellement transmis sont visibles dans le rapport.

Le JavaScript transféré lors du premier parcours navigateur observé représente environ 90–97 Kio avec Rustyx contre 114–140 Kio avec Next. Il s’agit des ressources observées à cet instant, avec leurs politiques de préchargement respectives ; ce n’est pas une mesure exhaustive de la taille installée ni du CPU du navigateur. La fonctionnalité testée est équivalente sur les 44 contrôles.

## Portée du verdict

Le CPU et le RSS incluent tous les processus serveur, dont Node et React. Rustyx peut occuper davantage de cœurs pour fournir son débit supérieur, même lorsque son CPU par réponse est inférieur. Les mesures ne prédisent pas directement un VPS limité à un cœur. Le client partage le Mac Apple M4 de 16 Gio, les applications du bureau restent actives et les sondes RSS peuvent compter des pages partagées plusieurs fois.

Ces mesures utilisent Rustyx standard, sans PGO, mimalloc ou admission adaptative, et Next.js 16.3.5 construit avec webpack. Elles ne couvrent pas Turbopack, un export statique Next servi sans Node, Linux, réseau distant, CDN, base de données externe ou consommation électrique. Les énormes économies de RAM sur les pages purement statiques viennent notamment du worker Node non démarré chez Rustyx ; les parcours dynamiques sont bien plus proches.

**Rustyx vaut donc le coup pour ces charges lorsque le débit, le coût CPU des parcours complets ou la RAM des projets concernés sont prioritaires. Next garde des avantages mesurés sur certaines opérations. Les résultats ne prouvent ni une supériorité universelle ni une compatibilité Next à 100 %.**
