Résultats de la campagne finale

72 passages, 22/22 contrôles fonctionnels équivalents, 4 264 995 réponses valides dont 1 748 809 pour Rustyx optimisé. Zéro erreur sur les trois moteurs. Toutes les mesures de CPU sont valides et aucune limite de nombre de requêtes n’est atteinte.

Face à Rustyx après l’optimisation async précédente :
• PPR HTML : CPU -8,0 %, débit +6,0 %.
• PPR Flight : CPU -10,0 %.
• Dashboard à 128 clients : CPU -16,5 %, débit +8,4 %.
• API Pages POST 32 Kio : CPU -32,8 %, débit +62,7 %.

Le PPR Flight conserve un coût CPU 25,5 % supérieur à Next.js, malgré son débit supérieur dans cette campagne. Les gains ne sont pas uniformes et la RAM ne baisse pas sur chaque scénario. Le coût CPU par réponse et le CPU total sont distincts : traiter plus de réponses peut mobiliser davantage de cœurs.

Autres compromis mesurés : le POST Pages très court utilise 3.1 % de CPU supplémentaire par réponse face à Rustyx précédent ; le POST de 32 Kio utilise encore 6.6 % de CPU de plus que Next.js, malgré son débit supérieur. À 128 clients sur le portail, le débit Rustyx est 5.9 % inférieur à Next.js. Les écarts de quelques pour cent demandent confirmation sur des essais plus longs.

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

Optimisations du runtime — campagne du 23 septembre 2026

Modifications évaluées

• Corps entrants Rust–Node transmis en binaire, avec conservation de la compatibilité des workers antérieurs. Les Server Actions ne repassent pas non plus en base64 pour l’envoi au thread RSC.
• Manifestes clients/actions enregistrés une fois par thread en production, registre limité à 32 manifestes. Réutilisation des tables de modules dérivées et des manifestes Edge, sans modèle React décodé ni contexte visiteur partagé.
• Hits SQLite frais sans écriture pendant la fenêtre de regroupement LRU d’une seconde. Expiration, associations et génération sont encore vérifiées dans la base ; invalidations interprocessus et leases restent transactionnels. Aucun cache supplémentaire de réponses en RAM.
• Réservation de 32 Mio de corps entrants partagée entre middleware et rendu, transférée avec le corps et conservée pendant le traitement. Les uploads de taille inconnue rendent leur réservation inutilisée après lecture. Le proxy garde également la réservation pendant l’envoi.
• Réutilisation des connexions du cache entre rafales, plafond inchangé de 32 connexions par pool et expiration inactive à 30 secondes. Le test de six rafales de seize appels ouvre désormais seize connexions, contre soixante-seize avant la correction.
• Surveillance native de la boucle Node, suivi de la vraie promesse applicative après annulation, retrait et récupération des processus bloqués, collecte des processus terminés, délais RSC conservés après déconnexion. Une action annulée qui dépasse son délai retire encore l’isolate. Les mutations ne sont jamais rejouées automatiquement.

Solidité et portée

529 tests unitaires JavaScript, 124 tests Rust, 271 tests HTTP et 209 tests navigateur passent. TypeScript, Clippy et formatage passent également. Des tests ciblés suivent les dernières corrections : 24 HTTP sur le binaire final et 30 sur le rendu/actions RSC. Les contrôles couvrent les corps fragmentés, les octets arbitraires, douze uploads simultanés de 2 Mio, le refus au-delà de 8 Mio, la récupération d’un processus partagé ayant des connexions inactives, les mutations annulées, les invalidations du cache et la rétention mémoire. Voir validation.json pour les commandes et les détails.

Le budget de 32 Mio n’est pas un plafond de RSS : allocations et copies applicatives, buffers réseau, heaps JavaScript et travail temporairement retenu par du code ignorant l’annulation s’ajoutent à ce budget. Un retrait forcé peut interrompre les autres requêtes du même processus ; le framework ne peut pas arrêter arbitrairement du JavaScript tout en garantissant que ses effets de bord n’ont pas eu lieu.

Les enchaînements d’encodage/décodage du PPR dynamique restent présents pour préserver les références React, les promesses, les actions et l’isolation des visiteurs. Les changements de cette campagne réduisent surtout les métadonnées répétées et le coût du cache. Une continuation directe limitée aux zones dynamiques, une admission adaptative par catégorie de route et le remplacement éventuel du TCP local par des sockets Unix restent des pistes distinctes à profiler et à valider ; aucun gain n’est revendiqué pour ces pistes.

Les mesures suivantes sont synthétiques et locales. Trois essais de huit secondes par moteur et scénario, sans autre test ou compilation pendant la mesure ; ordre alterné, préchauffage, serveur neuf. Le générateur de charge partage la machine et utilise une concurrence fixe, sans débit d’arrivée imposé. Les faibles écarts peuvent être du bruit de mesure. Une campagne prolongée et un générateur sur une autre machine restent nécessaires pour qualifier une capacité de production.

La première campagne a révélé un défaut réel : la réduction du pool RPC à quatre connexions inactives provoquait un renouvellement excessif des ports TCP sous concurrence. Les essais perturbés touchent les trois moteurs ; ils sont archivés et exclus des chiffres finaux. Tous les passages sont refaits avec la correction du pool et une pause de 35 secondes après chaque stress du dashboard, y compris Next.js.
