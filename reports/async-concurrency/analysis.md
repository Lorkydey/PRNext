Résultats de la campagne

114 passages mesurés, 22/22 comparaisons fonctionnelles entre les projets Next.js et Rustyx, 2 389 535 réponses valides. Sur les passages retenus : aucune erreur pour Rustyx optimisé et Next.js ; 1 342 545 erreurs pour l’ancienne version, pendant les stress à 128 clients. Le statut, le contenu, les paramètres et les cookies propres à chaque visiteur sont contrôlés.

Async et streaming

L’API avec attente de 30 ms passe de 30 à 118 req/s (Next : 116), pour 81,9 Mio contre 78,9 avant et 126,3 chez Next. Le streaming avec attente de 80 ms passe de 12 à 47 req/s. Les attentes peuvent avancer ensemble dans le même processus ; le débit n’est plus limité à une seule attente à la fois.

Forte concurrence

À 128 clients, le portail atteint 1 948 req/s, contre 1 943 pour Next. Son coût CPU par réponse baisse de 30,7 % et son RSS de 34,4 % face à Next. Le dashboard atteint 3 072 req/s contre 1 761 chez Next, avec 288,0 contre 369,5 Mio. Les 503 restent intentionnels au-delà de la file bornée : cela ne signifie pas une capacité illimitée. Les CPU et latences de l’ancienne version en surcharge ne représentent pas un travail équivalent, puisque presque toutes ses demandes sont refusées.

Proxy et PPR

Le proxy applicatif et le SSR partagent désormais le processus Node : RSS 354,2 → 249,2 Mio (-29,6 %), débit 2 857 → 3 091 req/s. Les réécritures HTTP/HTTPS externes conservent 16 flux actifs et ajoutent une file de 256 demandes avant lecture de leur corps ; leurs bornes et annulations sont vérifiées par les tests, séparément de ce benchmark proxy.js.

La route entièrement pré-rendue /projet/atlas est maintenant servie par le cache Rust, avec invalidation : 6 162 → 27 664 req/s, RSS 149,2 → 8,0 Mio. Next atteint 8 511 req/s et 235,9 Mio. Les chemins PPR incomplets ou inconnus conservent leur reprise dynamique ; les données visiteur ne sont pas mises en cache partagé.

Compromis qui restent

Le PPR Flight personnalisé coûte encore 36,5 % de CPU supplémentaire par réponse face à Next (1,276 contre 0,935 ms). La petite API App immédiate gagne 11,7 % de débit mais ajoute 8,4 % de CPU par réponse par rapport à l’ancienne version. Ce ne sont pas des optimisations uniformes de tous les chemins.

La concurrence augmente aussi la mémoire de certains profils : le dashboard mixte passe de 204,9 à 250,1 Mio, proche de Next (252,1). Les budgets d’admission des corps sont de 32 Mio par étape, en unités de 64 Kio ; ils ne plafonnent pas le RSS total, les copies de transport, les corps déjà transmis à l’étape suivante ni les allocations npm. Les réponses gardent quatre blocs de 64 Kio au maximum en attente par connexion.

Contrôle prolongé

Sur 30 secondes à 8 clients, le portail traite 966 req/s contre 931 chez Next, avec 215,2 contre 296,8 Mio. Le dashboard traite 3 604 contre 2 071 req/s, avec 0,622 contre 0,596 ms CPU par réponse et 299,9 contre 447,6 Mio. Ce sont des observations locales, pas une garantie d’absence de fuite sur plusieurs heures.

Incident du banc de test

L’épuisement des ports éphémères de macOS après le stress de l’ancienne version a perturbé sept essais (un chargement et six démarrages/préchauffages), y compris Next et Rustyx optimisé. Ils sont conservés dans host-port-exhaustion.json et exclus des statistiques finales. Ils ont été rejoués après récupération, avec 35 secondes de repos après les stress de l’ancienne version ; le MSL local est de 15 secondes. Les autres essais valides sont conservés, sans sélection des meilleurs résultats.

Validation et utilisation

523 tests unitaires JavaScript, 120 tests Rust, 269 tests HTTP et 209 tests navigateur passent ; les contrôles TypeScript, de formatage et Clippy passent également. Les vérifications ciblées portent notamment sur le partage de processus, les annulations, les corps de réponses, l’arrêt du parent, la compatibilité des workers stdio, la saturation et la régénération PPR. Recompiler les projets avec Rustyx pour intégrer le nouveau runtime ; les anciens builds restent servis avec leur transport historique. Les versions, hashes, sources et commandes sont conservés dans ce dossier.
