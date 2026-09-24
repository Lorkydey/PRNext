# Next.js / Rustyx — workloads dynamiques, parité avant performance

État : complete. 2026-09-24T12:14:24.969Z.

Apple M4, 16 Gio, darwin/arm64, Node v22.17.1. Next 15.5.12, React 19.3.0.

1 393 419 réponses de performance validées ; 0 essais invalides. Aucun résultat exclu n’est utilisé pour annoncer un gain.

## Preuve de rendu dynamique

| Moteur | Requêtes identiques | Exécutions SSR | Backend | Contrôle |
| --- | --- | --- | --- | --- |
| Next.js | 10000 | 10000 | 0 | Réussi |
| Rustyx | 10000 | 10000 | 0 | Réussi |

## Matrice de parité

| Contrôle | Next | Rustyx | Parité stricte | Portée |
| --- | --- | --- | --- | --- |
| SSR sans cache | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| params, searchParams, headers et cookies | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| SSR + données locales | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Route Handler GET (identity) | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Route Handler POST JSON (identity) | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Pages API GET | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Pages API POST JSON | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Session alice/bob | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Cache de données : hit | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Cache de données : miss | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Suspense : données et exécutions | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| 10 000 requêtes SSR identiques | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Négociation gzip par défaut (diagnostic) | Réussi | Réussi | Non | Écart documenté, exclu du comparatif direct |
| Session absente | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| redirect() HTTP 307 | Réussi | Réussi | Non | Écart documenté, exclu du comparatif direct |
| notFound() HTTP 404 | Réussi | Réussi | Non | Écart documenté, exclu du comparatif direct |
| Mutation, stale hit, invalidation, nouveau miss | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| 10 cycles miss → hit → invalidation → miss | Réussi | Réussi | Oui | Travail et contrat vérifiés |
| Flight dynamique décodé par le navigateur | Réussi | Réussi | Oui | Protocole émulé, exclu du comparatif direct |
| Server Action : arguments, mutation, résultat, revalidation | Réussi | Réussi | Non | Protocole émulé, exclu du comparatif direct |
| Shell avant données, identity + gzip | Réussi | Réussi | Oui | Travail et contrat vérifiés |

## Différences fonctionnelles et émulations

### Compression HTTP

Le diagnostic gzip par défaut donne des encodages différents pour les Route Handlers dans cette fixture. Il est exclu des comparaisons directes. Les mesures Route Handler utilisent identity des deux côtés ; les Pages API et le HTML utilisent gzip. Une réponse non compressée n’est jamais présentée comme un résultat gzip.

### Server Actions

Les deux navigateurs reçoivent le résultat attendu, la mutation +3 et le cookie ; le contenu revalidé affiche la nouvelle version. Mais Next exécute 3 producteurs de cache et Rustyx 2 (initialisation incluse). Même résultat, travail différent : aucun ratio de vitesse. Le protocole de réponse est aussi propre à chaque moteur.

### RSC / Flight

Deux navigations sans rechargement exécutent réellement la page produit, avec des cookies et headers distincts. Chaque navigateur décode le payload de son moteur et affiche les valeurs attendues. Next utilise son enveloppe de routeur ; Rustyx utilise notamment tree/router. Parité applicative vérifiée, compatibilité wire Next non établie : aucun comparatif direct.

### Redirect

Les deux moteurs retournent 307, la même Location et la même destination visible. Next annonce text/html avec gzip ; Rustyx omet Content-Type et renvoie une réponse vide sans compression. La comparaison stricte des en-têtes échoue : scénario exclu.

### notFound

Les deux réponses sont 404 avec noindex et le même contenu après JavaScript. Dans cette fixture et ces versions, Next envoie initialement un document d’erreur sans texte visible, puis le navigateur affiche le fallback ; Rustyx fournit le fallback dans l’HTML serveur. Le rendu initial diffère : scénario exclu.

## Lecture des résultats

À charge égale, le CPU par réponse de Rustyx est inférieur dans 12/12 workloads : les baisses médianes vont de 18,0 à 40,4 %. Ce sont des mesures instrumentées, avec les runtimes React propres aux moteurs.

La RAM dynamique ne reproduit pas l’avantage d’un serveur statique : SSR simple, 182,22 Mio pour Next et 175,28 Mio pour Rustyx. Avec une lecture backend, Next utilise 194,56 Mio contre 202,34 Mio pour Rustyx. Les cas API conservent un avantage mémoire plus marqué pour Rustyx.

Priorité d’analyse : la concurrence du streaming. À C32, Next termine 616 req/s contre 374 pour Rustyx ; les p95 sont 66,18 et 88,96 ms. Le travail du composant et les lectures backend par réponse sont identiques. Ce constat n’identifie pas à lui seul la cause interne.

Priorité de compatibilité : expliquer ou aligner la revalidation des Server Actions et les protocoles Flight/Actions. Leur comportement visible testé peut réussir alors que le nombre de lectures backend ou le protocole diffère. Ils ne fournissent ici aucun gain de performance comparable.

## Résultats

| Scénario / charge | Moteur | Rép. valides | Encodage | Req/s | CPU ms/réponse | Idle froid Mio | Idle chaud Mio | RAM charge Mio | Pic Mio | p50 ms | p95 ms | p99 ms | TTFB p95 ms | Corps reçu octets | Backend/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SSR sans cache / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 2,440 | 105,50 | 140,38 | 182,22 | 191,55 | 1,69 | 2,88 | 6,98 | 2,22 | 1 620 | 0,0 |
| SSR sans cache / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 1,500 | 7,63 | 113,67 | 175,28 | 194,55 | 1,01 | 1,61 | 2,59 | 1,44 | 1 505 | 0,0 |
| SSR sans cache / concurrency-32 / C32 | Next.js | 3/3 | gzip | 925 | 1,669 | 105,66 | 140,28 | 334,69 | 362,88 | 33,35 | 45,48 | 54,54 | 24,38 | 1 631 | 0,0 |
| SSR sans cache / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 4 644 | 0,477 | 7,72 | 114,16 | 271,36 | 274,92 | 6,44 | 10,34 | 13,58 | 10,29 | 1 489 | 0,0 |
| params, searchParams, headers et cookies / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 2,587 | 105,16 | 142,23 | 181,78 | 194,39 | 1,78 | 3,25 | 6,54 | 2,32 | 1 820 | 0,0 |
| params, searchParams, headers et cookies / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 1,560 | 7,67 | 114,42 | 176,88 | 194,13 | 1,04 | 1,77 | 2,79 | 1,61 | 1 703 | 0,0 |
| params, searchParams, headers et cookies / concurrency-32 / C32 | Next.js | 3/3 | gzip | 857 | 1,807 | 105,34 | 141,67 | 389,56 | 405,06 | 35,76 | 48,47 | 58,49 | 29,60 | 1 820 | 0,0 |
| params, searchParams, headers et cookies / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 4 616 | 0,475 | 7,61 | 114,98 | 266,78 | 278,39 | 6,42 | 10,21 | 13,76 | 10,16 | 1 703 | 0,0 |
| SSR + données locales / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 2,693 | 105,81 | 155,16 | 194,56 | 208,59 | 1,92 | 3,56 | 7,38 | 2,44 | 1 805 | 250,1 |
| SSR + données locales / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 2,053 | 7,77 | 130,44 | 202,34 | 208,25 | 1,22 | 2,24 | 3,62 | 2,12 | 1 642 | 250,1 |
| SSR + données locales / concurrency-32 / C32 | Next.js | 3/3 | gzip | 715 | 2,114 | 105,72 | 155,59 | 350,03 | 378,67 | 42,80 | 56,31 | 70,55 | 40,22 | 1 815 | 714,7 |
| SSR + données locales / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 2 972 | 0,757 | 7,70 | 125,69 | 289,61 | 297,83 | 10,14 | 16,16 | 19,31 | 16,08 | 1 630 | 2 972,4 |
| Route Handler GET (identity) / fixed-250 / C32 | Next.js | 3/3 | identity | 250 | 1,300 | 105,94 | 131,89 | 163,02 | 176,73 | 0,89 | 1,31 | 2,58 | 1,28 | 2 403 | 0,0 |
| Route Handler GET (identity) / fixed-250 / C32 | Rustyx | 3/3 | identity | 250 | 0,827 | 7,80 | 73,25 | 93,61 | 116,52 | 0,66 | 1,56 | 2,75 | 1,50 | 2 403 | 0,0 |
| Route Handler GET (identity) / concurrency-32 / C32 | Next.js | 3/3 | identity | 3 638 | 0,360 | 105,30 | 130,77 | 273,28 | 322,30 | 7,72 | 14,38 | 17,84 | 14,37 | 2 409 | 0,0 |
| Route Handler GET (identity) / concurrency-32 / C32 | Rustyx | 3/3 | identity | 10 593 | 0,163 | 7,59 | 72,81 | 179,59 | 194,06 | 2,60 | 5,28 | 6,98 | 5,27 | 2 409 | 0,0 |
| Route Handler POST JSON (identity) / fixed-250 / C32 | Next.js | 3/3 | identity | 250 | 1,367 | 105,83 | 131,08 | 170,59 | 177,92 | 0,98 | 1,52 | 2,41 | 1,48 | 2 476 | 0,0 |
| Route Handler POST JSON (identity) / fixed-250 / C32 | Rustyx | 3/3 | identity | 250 | 0,860 | 7,80 | 73,58 | 97,48 | 118,31 | 0,68 | 1,56 | 2,51 | 1,51 | 2 476 | 0,0 |
| Route Handler POST JSON (identity) / concurrency-32 / C32 | Next.js | 3/3 | identity | 3 307 | 0,401 | 105,86 | 131,44 | 297,50 | 338,91 | 8,38 | 15,86 | 21,15 | 15,85 | 2 482 | 0,0 |
| Route Handler POST JSON (identity) / concurrency-32 / C32 | Rustyx | 3/3 | identity | 10 101 | 0,161 | 7,61 | 73,69 | 178,98 | 197,11 | 2,76 | 5,44 | 6,99 | 5,44 | 2 482 | 0,0 |
| Pages API GET / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 0,960 | 105,47 | 124,06 | 158,42 | 168,45 | 0,75 | 1,71 | 2,77 | 1,58 | 439 | 0,0 |
| Pages API GET / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 0,620 | 7,73 | 72,48 | 92,20 | 110,44 | 0,57 | 1,78 | 2,46 | 1,66 | 441 | 0,0 |
| Pages API GET / concurrency-32 / C32 | Next.js | 3/3 | gzip | 7 093 | 0,207 | 106,33 | 125,16 | 303,02 | 313,42 | 4,11 | 6,89 | 9,57 | 5,24 | 443 | 0,0 |
| Pages API GET / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 18 347 | 0,120 | 7,58 | 71,59 | 152,28 | 152,72 | 1,48 | 2,90 | 3,99 | 2,89 | 445 | 0,0 |
| Pages API POST JSON / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 0,987 | 106,25 | 124,78 | 160,02 | 169,16 | 0,75 | 1,69 | 2,75 | 1,58 | 481 | 0,0 |
| Pages API POST JSON / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 0,627 | 7,77 | 72,58 | 92,38 | 110,31 | 0,58 | 1,87 | 2,51 | 1,76 | 482 | 0,0 |
| Pages API POST JSON / concurrency-32 / C32 | Next.js | 3/3 | gzip | 6 861 | 0,214 | 104,97 | 124,47 | 308,13 | 321,22 | 4,26 | 7,19 | 9,90 | 5,29 | 485 | 0,0 |
| Pages API POST JSON / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 18 013 | 0,116 | 7,58 | 72,19 | 152,02 | 152,33 | 1,50 | 2,98 | 4,01 | 2,97 | 486 | 0,0 |
| Session alice/bob / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 2,460 | 105,67 | 140,95 | 179,94 | 194,56 | 1,68 | 2,84 | 5,40 | 2,22 | 1 514 | 0,0 |
| Session alice/bob / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 1,467 | 7,80 | 116,00 | 175,56 | 195,63 | 0,99 | 2,10 | 3,68 | 1,95 | 1 414 | 0,0 |
| Session alice/bob / concurrency-32 / C32 | Next.js | 3/3 | gzip | 906 | 1,684 | 105,11 | 139,36 | 310,19 | 374,09 | 33,97 | 46,97 | 57,28 | 23,64 | 1 514 | 0,0 |
| Session alice/bob / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 4 755 | 0,466 | 7,80 | 117,06 | 269,95 | 274,91 | 6,29 | 9,95 | 13,36 | 9,88 | 1 412 | 0,0 |
| Cache de données : hit / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 2,513 | 105,63 | 142,22 | 182,23 | 196,30 | 1,71 | 3,16 | 10,92 | 2,35 | 1 732 | 0,0 |
| Cache de données : hit / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 1,920 | 7,66 | 119,81 | 181,80 | 198,52 | 1,18 | 2,19 | 4,26 | 2,05 | 1 695 | 0,0 |
| Cache de données : hit / concurrency-32 / C32 | Next.js | 3/3 | gzip | 882 | 1,721 | 105,48 | 141,61 | 332,45 | 359,80 | 34,89 | 46,61 | 58,61 | 22,94 | 1 742 | 0,0 |
| Cache de données : hit / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 3 587 | 0,618 | 7,70 | 117,52 | 269,22 | 282,38 | 8,25 | 13,50 | 17,17 | 13,38 | 1 661 | 0,0 |
| Cache de données : miss / fixed-250 / C32 | Next.js | 3/3 | gzip | 250 | 2,853 | 104,98 | 156,75 | 209,47 | 293,50 | 2,04 | 4,28 | 11,62 | 2,70 | 1 816 | 250,1 |
| Cache de données : miss / fixed-250 / C32 | Rustyx | 3/3 | gzip | 250 | 2,340 | 7,69 | 131,09 | 207,86 | 212,56 | 1,60 | 2,71 | 5,97 | 2,58 | 1 699 | 250,1 |
| Cache de données : miss / concurrency-32 / C32 | Next.js | 3/3 | gzip | 691 | 2,319 | 105,55 | 156,67 | 354,77 | 398,63 | 45,16 | 56,07 | 67,89 | 42,12 | 1 827 | 691,0 |
| Cache de données : miss / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 2 117 | 1,257 | 7,64 | 130,45 | 294,23 | 302,31 | 12,97 | 27,17 | 48,70 | 27,09 | 1 669 | 2 117,1 |
| Mutation, stale hit, invalidation, nouveau miss / fixed-250 / C1 | Next.js | 3/3 | gzip + identity | 250 | 2,320 | 106,33 | 165,13 | 190,34 | 194,39 | 1,74 | 2,83 | 3,54 | 2,34 | 1 377 | 125,2 |
| Mutation, stale hit, invalidation, nouveau miss / fixed-250 / C1 | Rustyx | 3/3 | gzip + identity | 250 | 1,787 | 7,64 | 145,17 | 198,86 | 209,22 | 1,33 | 2,15 | 3,05 | 2,05 | 1 304 | 125,2 |
| Mutation, stale hit, invalidation, nouveau miss / concurrency-32 / C1 | Next.js | 3/3 | gzip + identity | 565 | 2,276 | 106,41 | 166,77 | 222,70 | 306,83 | 1,85 | 2,76 | 3,58 | 2,27 | 1 386 | 282,3 |
| Mutation, stale hit, invalidation, nouveau miss / concurrency-32 / C1 | Rustyx | 3/3 | gzip + identity | 797 | 1,600 | 7,67 | 145,64 | 212,98 | 220,11 | 1,18 | 1,86 | 2,83 | 1,75 | 1 306 | 398,4 |
| Suspense : données et exécutions / fixed-250 / C32 | Next.js | 3/3 | gzip | 248 | 2,973 | 105,39 | 158,92 | 232,70 | 258,98 | 42,14 | 43,91 | 49,41 | 2,52 | 2 392 | 248,4 |
| Suspense : données et exécutions / fixed-250 / C32 | Rustyx | 3/3 | gzip | 248 | 2,287 | 7,75 | 134,81 | 195,55 | 200,42 | 41,46 | 42,72 | 45,42 | 1,59 | 2 278 | 248,4 |
| Suspense : données et exécutions / concurrency-32 / C32 | Next.js | 3/3 | gzip | 616 | 2,516 | 105,48 | 158,77 | 360,13 | 391,06 | 49,54 | 66,18 | 95,63 | 13,15 | 2 392 | 616,4 |
| Suspense : données et exécutions / concurrency-32 / C32 | Rustyx | 3/3 | gzip | 374 | 1,888 | 7,73 | 135,38 | 210,16 | 218,58 | 85,10 | 88,96 | 92,56 | 48,01 | 2 274 | 373,5 |

## Essais invalides

Aucun.

## Protocole et limites

- Référence : Next.js 15.5.12, React 19.3.0. Comparaison avec le binaire Rustyx identifié ci-dessous, pas avec toutes les versions de Next. Les deux projets proviennent du même ensemble de fichiers applicatifs ; seules les commandes de build et de lancement diffèrent.
- React déclaré dans les deux projets : 19.3.0. Attention : le Next App Router embarque ici React 19.2.0-canary-0bdb9206-20250818, tandis que Rustyx utilise les packages installés. Ce sont les runtimes par défaut de ces moteurs ; les mêmes sources applicatives ne signifient pas des internes React identiques. Cette différence est consignée dans integrity.json et limite toute attribution des gains au seul langage Rust. Le code applicatif JavaScript reste exécuté par Node chez Rustyx.
- La parité est un préalable bloquant, pas une appréciation visuelle. Les tests vérifient les statuts, Content-Type, la politique de stockage Cache-Control, les en-têtes applicatifs, Location, les attributs des cookies, les données JSON complètes, le texte visible, les arguments effectivement lus, les appels backend et les exécutions de fonctions. Les 10 000 requêtes no-cache ont exactement la même URL, les mêmes headers et les mêmes cookies.
- Instrumentation identique : un appendFileSync JSON par entrée dans une fonction auditée (rendu, handler, producteur du cache, action, invalidation, composant async). Le journal commun à tous les processus compte aussi les workers RSC. Pas de fsync par ligne. Ce coût CPU/I/O est inclus dans les mesures : il ne s’agit pas d’un benchmark sans instrumentation. Les écritures de journal ne sont pas des appels backend.
- Les corps HTML propres à chaque framework peuvent différer. Le test préalable compare le contenu applicatif visible et les données, pas les scripts de transport byte-for-byte. Pendant la charge, chaque réponse est entièrement décompressée et son objet applicatif comparé aux paramètres de sa requête. Les traces de chaque fonction et tous les arguments backend sont vérifiés après chaque essai.
- Compression identique exigée : gzip pour les pages HTML et les Pages API, qui renvoient un catalogue déterministe de 32 articles. Les Route Handlers restent non compressés chez Next dans cette fixture : le profil comparable demande donc identity explicitement aux DEUX moteurs. Les petits accusés d’invalidation utilisent également identity. Content-Encoding est vérifié avant les mesures et sur chaque réponse mesurée. Les tailles indiquent les octets réellement reçus ; les lignes identity sont explicitement non compressées.
- Normalisations explicites : casse et ordre des attributs Set-Cookie, media type sans charset, espaces autour des directives HTTP. Sous no-store, no-cache/max-age=0/must-revalidate sont redondants pour le stockage. Date, ETag, Content-Length et les noms de Vary du routeur ne sont pas des égalités exigées ; leurs valeurs brutes restent dans parity.json. Les transports Flight et Actions sont traités séparément comme émulations.
- Un backend Node local indépendant fournit des valeurs déterministes. Ses compteurs enregistrent chaque méthode, clé, tenant et mutation. Sa RAM et son CPU sont mesurés séparément et ne sont pas inclus dans les colonnes serveur. Il n’y a pas de délai artificiel, sauf 40 ms pour le workload Suspense ; le contrôle de streaming bloque réellement le backend jusqu’à réception du shell.
- Cache : le HTML des workloads reste dynamique/no-store, y compris les workloads de cache de données. Hit = producteur non exécuté et zéro lecture backend ; miss = une exécution du producteur et une lecture backend. Une mutation reste invisible dans le cache jusqu’à revalidateTag/revalidatePath. Un cycle mesuré comprend quatre réponses HTTP : miss, hit, POST d’invalidation, miss ; il produit deux lectures backend et trois rendus. Ce test ne mesure pas le cache HTML ISR ni le PPR.
- Serveur neuf par essai, cache persistant de données supprimé avant lancement, code compilé conservé. Échauffement : 32 opérations séquentielles, soit 128 réponses pour les cycles à quatre étapes. Puis compteurs et journaux remis à zéro. Les hits sont amorcés avant la mesure ; les misses emploient des clés neuves. Les clés des cycles sont isolées et leur concurrence est 1, car revalidatePath invalide un chemin commun.
- Trois répétitions par paire et profil, ordre Next/Rustyx puis Rustyx/Next puis Next/Rustyx. Profil à cadence imposée : 250 réponses HTTP/s, six secondes, au plus 32 requêtes simultanées. Profil de débit : quatre secondes à concurrence 32, ou 1 pour les cycles. Les moyennes globales entre workloads sont volontairement absentes.
- À cadence imposée, les deux moteurs traitent les mêmes 1 500 réponses et les mêmes appels backend par run. À concurrence imposée, le moteur plus rapide termine davantage de requêtes pendant les quatre secondes : les totaux backend peuvent donc différer, mais le nombre et les paramètres des appels par réponse sont vérifiés. Pour comparer RAM et CPU à quantité de travail égale, privilégier le profil fixed-250.
- Chaque run mesure req/s, CPU serveur par réponse, RSS idle avant et après échauffement, RSS sous charge, p50/p95/p99, TTFB, tailles reçues et décompressées, backend/s et coût du backend. Tableau : médiane des trois runs, y compris la médiane de leurs pics RSS ; minimums et maximums figurent dans summary.json. TTFB = premier octet du corps HTTP compressé ; temps des headers également conservé.
- RAM serveur = somme du RSS du processus principal et de tous ses descendants, échantillonnée environ toutes les 150 ms. Les pages partagées peuvent être comptées plusieurs fois. RSS n’inclut pas tout le cache disque du système. Idle froid peut précéder le démarrage des workers paresseux ; idle chaud et RAM en charge sont les valeurs utiles pour comparer un serveur qui rend réellement des pages.
- CPU = delta de temps CPU cumulé ps du serveur et de ses descendants ; un worker qui disparaît invalide la mesure. 100 % représente un cœur. Les temps incluent la journalisation applicative. Le client de charge et le backend tournent sur la même machine, dans des processus distincts. Le CPU du client est publié : un client proche de 100 % peut limiter le débit observé.
- Un run est invalide si une réponse échoue, si des paramètres ou compteurs diffèrent, si un worker échappe au comptage, ou si la cadence imposée dévie de plus de 5 % / présente un retard d’émission p95 ≥ 10 ms. Toute paire qui n’a pas trois runs valides pour chaque moteur est exclue des graphiques et comparatifs, et ses erreurs restent visibles.
- Portée : microbenchmarks instrumentés sur un seul Mac M4, loopback HTTP, sans TLS/CDN/base de données distante. Trois répétitions courtes ne constituent pas un essai d’endurance, un test de fuite mémoire ou une estimation de capacité VPS. Les serveurs de développement préexistants ont été laissés ouverts mais inactifs. Aucune compatibilité Next.js exhaustive n’est déduite de ces tests.
- Une première campagne pilote a été exclue intégralement : ses petites réponses JSON étaient non compressées chez Next et compressées chez Rustyx. Elle a servi à corriger le contrôle de parité, le jeu de données Pages API et à aligner les Route Handlers sur identity. Aucun de ses résultats de performance n’est réutilisé dans ce rapport. Les chiffres finaux proviennent de la nouvelle campagne après correction.

## Traçabilité et reproduction

Sources fixture SHA-256 : 3b540cae483fedd59c55c0471143d22b002328f6edf79398dfe22fd16a939d2e

Binaire Rustyx SHA-256 : b5b60174ab8435e9b431abf89fb6de999f727a67741eb03f7cd82e4de613ec14

Commit de base : f83a2d9cfcdbc0c5608c2898b9a9dd36ca9107ca. Les nouveaux scripts et leur empreinte sont fournis dans le paquet de résultats.

Voir README.md pour les commandes. results.json conserve les runs, les traces de parité, les en-têtes bruts et les erreurs. Les journaux de 10 000 exécutions sont joints.

Références : [Next 15 dynamic](https://nextjs.org/docs/15/app/api-reference/file-conventions/route-segment-config), [unstable_cache](https://nextjs.org/docs/15/app/api-reference/functions/unstable_cache), [revalidateTag](https://nextjs.org/docs/15/app/api-reference/functions/revalidateTag), [redirect](https://nextjs.org/docs/15/app/api-reference/functions/redirect).
