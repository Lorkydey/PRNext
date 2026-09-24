# Rustyx actuel face à Next.js

**Rustyx vaut le coup pour les applications dont les fonctions et la charge ont été validées.** Les gains de débit, de mémoire et de compilation sont concrets sur ces projets. Son intérêt est plus limité si le coût CPU du PPR ou une forte concurrence asynchrone domine : Next reste meilleur sur certains de ces critères. La RAM ne baisse pas dans tous les cas.

**300 passages de charge, 48 compilations et 44/44 comparaisons fonctionnelles équivalentes.** Les 294 passages principaux totalisent 17 182 538 réponses valides, sans erreur. Les six essais complémentaires à 512 clients révèlent en revanche 571 247 refus HTTP 503 de Rustyx ; Next n’en produit aucun. Toutes les vérifications de reprise passent. Ces deux catégories de résultats sont séparées dans le rapport.

## Parcours mixtes courts : Next → Rustyx

Médianes de trois passages de huit secondes, quatre clients simultanés. Chaque projet utilise un mélange fixe de routes ; les sources applicatives sont identiques entre moteurs. CPU et RSS couvrent tout l’arbre de processus serveur. Un signe négatif indique une réduction du coût CPU ou de la mémoire.

- Boutique Edge : 2 106 → 12 217 req/s (×5,80), CPU/réponse −62,5 %, RSS 307,7 → 292,0 Mio (−5,1 %).
- Boutique Node : 7 141 → 23 627 req/s (×3,31), CPU/réponse −30,7 %, RSS 258,3 → 165,2 Mio (−36,1 %).
- Journal Pages / i18n : 6 653 → 23 074 req/s (×3,47), CPU/réponse −48,0 %, RSS 251,1 → 232,4 Mio (−7,4 %).
- Dashboard PPR : 1 743 → 3 385 req/s (×1,94), CPU/réponse −13,1 %, RSS 288,1 → 273,7 Mio (−5,0 %).
- Portail SSR / asynchrone : 449 → 467 req/s (×1,04), CPU/réponse −19,3 %, RSS 167,2 → 184,3 Mio (+10,2 %).
- Documentation · 100 pages : 9 273 → 18 655 req/s (×2,01), CPU/réponse −17,6 %, RSS 228,3 → 135,5 Mio (−40,7 %).

Les gros gains de la boutique Edge ne représentent pas tous les usages Next. Sa variante Node permet le pré-rendu et accélère aussi beaucoup Next. Le portail léger utilise ici davantage de RAM avec Rustyx : +10,2 %. Il serait donc faux d’annoncer une baisse de RAM systématique ou un multiplicateur global de performance.

## Charge prolongée : le verdict change avec l’échauffement

Un passage de 60 secondes à 64 clients par moteur, suivi de 15 secondes de repos et d’un contrôle de reprise. Ces observations ne sont pas répétées trois fois. Les essais courts incluent encore la montée en régime ; la comparaison prolongée est utile pour éviter de surestimer certains gains.

- Dashboard PPR : 2 146 → 3 578 req/s (+66,8 %) ; CPU 0,597 → 0,674 ms/réponse (+12,8 %) ; RSS 339,7 → 310,0 Mio (−8,8 %).
- Portail SSR / asynchrone : 2 427 → 1 968 req/s (−18,9 %) ; CPU 0,522 → 0,394 ms/réponse (−24,5 %) ; RSS 375,3 → 243,6 Mio (−35,1 %).
- Documentation · 100 pages : 9 586 → 21 818 req/s (+127,6 %) ; CPU 0,123 → 0,132 ms/réponse (+7,5 %) ; RSS 245,9 → 143,3 Mio (−41,7 %).

Le dashboard et la documentation débitent davantage avec Rustyx mais coûtent ici plus de CPU par réponse. Le portail économise CPU et RAM tout en servant moins de requêtes par seconde. Un débit supérieur peut utiliser davantage de cœurs : il ne signifie pas automatiquement moins de CPU total ou une facture plus basse. Les économies de RAM sont mesurées aux débits indiqués, sans test à débit d’arrivée identique imposé.

## Limite prioritaire : admission des requêtes asynchrones

Sur l’API simulant 30 ms d’attente, à 512 clients, les médianes sont 5 543 réponses utiles/s pour Next et 497 pour Rustyx. Rustyx rejette 98,58 % des tentatives, avec environ 134,2 Mio de RSS contre 352,6 pour Next. Le P95 des réponses réussies est de 563 ms contre 87 ms.

Le pool actuel autorise 16 requêtes actives et 256 en attente par worker. Il protège la mémoire mais limite la capacité d’une API qui passe beaucoup de temps à attendre. Le client de ce stress réémet immédiatement après un refus, sans respecter Retry-After : le taux de 503 décrit cette surcharge agressive, pas un taux de panne attendu sur tout trafic. Les refus restent des demandes non servies. Les six serveurs reprennent correctement la charge légère après le stress ; cela ne remplace pas une validation d’endurance sur plusieurs jours.

## CPU : les zones où il reste du travail

- PPR Flight personnalisé : 0,896 ms CPU/réponse chez Next contre 1,114 chez Rustyx, soit +24,3 %. Les couches de rendu React/Flight restent une priorité de profilage ; cette campagne ne mesure pas le pourcentage CPU de chaque fonction.
- Images déjà optimisées : débit plus élevé, mais CPU/réponse +12,1 %. Il faut profiler le chemin des images en cache avant de choisir une modification.
- API Pages : le POST court du journal est favorable à Rustyx. Le POST de 32 Kio a un coût CPU médian +4,2 %, trop proche pour en faire une conclusion forte. L’API GET de la documentation affiche +10,5 %, avec une dispersion notable et un avantage qui change de sens selon le passage. Une étiquette « API Pages » ne suffit pas à prévoir le résultat.
- À forte concurrence, les gains de débit des chemins natifs peuvent s’accompagner d’un coût CPU par réponse supérieur. Réduire les copies, allocations, accès au système de fichiers ou changements de thread est une piste à départager par profilage, pas une cause déjà démontrée par les compteurs globaux.

## Avantages concrets et limites de leur interprétation

Les chemins statiques et les rendus/API légers disposent d’une réserve de débit utile. Le RSS plus bas peut libérer de la mémoire pour d’autres services ou davantage d’instances, si le CPU et le débit nécessaires le permettent. Les très faibles RSS d’environ 8–23 Mio sur les routes statiques correspondent à un serveur neuf n’ayant pas lancé son worker JavaScript ; une application ayant déjà exécuté React et des API conserve une empreinte plus élevée. Un export statique Next servi sans Node n’est pas comparé ici.

Les builds initiaux de ces fixtures prennent 0,39–0,70 s avec Rustyx contre 2,44–5,34 s avec Next. Les rebuilds inchangés et après édition sont également mesurés. Chaque build est une observation unique et la référence Next utilise webpack : ce résultat ne compare pas Turbopack, ni le HMR, ni de gros dépôts industriels.

Le navigateur a reçu 20,8–30,8 % de JavaScript transféré en moins sur les accueils observés. C’est une capture par configuration, avec préchargements possibles ; ce n’est pas une mesure du bundle minimal, du CPU navigateur ou du LCP sur un réseau mobile.

Sur l’export JSON acceptant gzip, Next transmet ici environ 138,5 Kio non compressés contre 6,7 Kio compressés par Rustyx, soit 95,2 % d’octets en moins. Le supplément CPU de Rustyx finance aussi cette compression. Une configuration Next avec compression assurée par un proxy/CDN demanderait une autre comparaison. Les octets et encodages réellement observés figurent dans un tableau séparé.

## Ce que je ferais ensuite

- Adapter la concurrence au type de travail et aux ressources disponibles, tout en conservant des limites de mémoire et de file. La limite fixe de 16 opérations actives est le premier obstacle mesuré pour les attentes asynchrones.
- Profiler le PPR/Flight à chaud et les chemins natifs sous forte concurrence. Comparer le CPU par réponse utile et le P95, avec une charge identique et sans masquer les refus par un simple score de débit.
- Valider une application réelle, un débit d’arrivée imposé, des quotas CPU de déploiement, Linux/x86 et ARM, puis une endurance de plusieurs heures. Comparer aussi le build/runtime Next issu de Turbopack avant de généraliser le classement à toutes les configurations Next.

## Portée de la campagne

Six configurations de cinq projets de démonstration, dont une variante Edge/Node de la même boutique. Next 16.3.5, React 19.3.0, Node v22.17.1, Mac Apple M4 16 Gio ; un worker Rustyx, plusieurs cœurs disponibles. Les serveurs sont mesurés successivement, avec un nouveau processus à chaque passage et un ordre alterné. Aucun changement du moteur n’a été effectué pour cette comparaison.

Le client partage le Mac avec le serveur et des applications de bureau. Il est exclu des compteurs serveur mais peut limiter les routes rapides. Le RSS additionne les processus et peut compter plusieurs fois des pages partagées ; les pics sont échantillonnés. Les variations sont publiées, sans prétendre établir de petits écarts avec seulement trois répétitions. Ni CDN, réseau distant, vraie base externe, mesure énergétique, ni compatibilité Next universelle ne sont démontrés. La campagne mesure la version actuelle ; elle n’isole pas l’effet causal de chaque optimisation passée.
