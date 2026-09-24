# Mesures locales

Ces mesures proviennent d'un Mac Apple M4, avec Node 22.17.1 et un worker de requêtes. L'ISR peut démarrer un worker de maintenance supplémentaire. Le client et le serveur tournent sur la même machine. Un [comparatif séparé avec Next.js 16.3.5](next-comparison.md) mesure désormais le même projet sous les deux frameworks : RAM, CPU, débit, build, poids JavaScript et saturation. Les snapshots historiques ci-dessous ne constituent pas des comparaisons avec Next.js ; ces démos ne représentent pas une capacité de production.

## Compression et mémoire du serveur statique

Le serveur possède désormais un petit cache mémoire des représentations de fichiers construits : **4 Mio de contenu au maximum, 256 entrées au maximum**, sans allocation préalable de ce budget. Une représentation identity ou gzip occupe une entrée ; seuls les fichiers d'au plus 64 Kio et les chemins d'au plus 1 024 octets sont admis. Les clés, métadonnées et allocations de la table s'ajoutent au budget du contenu. Les réponses en cours partagent les octets du cache sans les recopier, mais peuvent prolonger leur durée de vie après éviction : ce plafond n'est donc pas une limite de RSS totale du serveur.

Les entrées les moins récemment utilisées sont évincées. Sous Unix, chaque lecture valide taille, date de modification, identité du fichier et date de changement avant de réutiliser les octets ; un changement pendant le remplissage empêche leur publication. Le contrôle de confinement des chemins reste actif. Les autres plateformes conservent les lectures ordinaires. Les gros fichiers, requêtes conditionnelles et plages d'octets utilisent toujours le service de fichiers existant. Les fichiers publics et les réponses d'API dynamiques ne sont pas conservés dans ce cache. Le chemin actuel l'active pour les fichiers construits éligibles à la précompression.

Les vérifications du cache persistant et des chemins HTML/JSON d'une page statique sont regroupées dans une seule tâche bloquante. Aucun résultat de routage ni en-tête dépendant d'un visiteur n'est mémorisé par le cache de contenu.

Le build produit les variantes gzip des pages pré-rendues et des assets lorsqu'elles sont plus petites que les originaux. Le serveur peut les lire directement, sans répéter la compression à chaque requête. Les fichiers publics modifiables conservent une compression à la demande.

Sur le même parcours statique de trois secondes avec quatre clients, la RSS du serveur Rust après charge passe de **85,4 Mio** dans le [snapshot avec compression à la demande](benchmark-pages-runtime-gzip-local.json) à **5,7 Mio** dans le [snapshot avec précompression](benchmark-pages-precompressed-local.json). L'inspection de l'allocateur sur macOS a montré des régions de mémoire vides conservées après les compressions. Cette observation dépend de la plateforme et des charges précédentes ; elle ne mesure pas le pic de mémoire.

Le [dernier snapshot Pages Router](benchmark-local.json), avec le service de cache disponible mais sans données mises en cache par cette démo, mesure 9 155 réponses statiques/s, 9 902 réponses API/s et 10 679 rendus Pages SSR/s, sans erreur. Le parcours statique reste à **5,9 Mio de RSS native**. Le processus Node démarre à la première route dynamique : la RSS totale atteint alors 140,4 Mio après l'API et 147,6 Mio après le SSR. Les petites valeurs de RSS du parcours statique concernent uniquement Rust, avant le démarrage de Node.

```sh
npm run bench
```

## Débit App Router

Ces snapshots précèdent l'introduction du cache HTML/Flight : les parcours HTML et Flight effectuaient un rendu à chaque requête. La commande de benchmark sur la démo actuelle peut sélectionner des pages désormais statiques ; elle ne reproduit donc pas exactement cette charge historique.

Chaque parcours dure trois secondes avec quatre clients. Les parcours HTML, API puis Flight utilisent la même instance ; sa mémoire conserve les modules chargés précédemment. La RSS est relevée après chaque parcours, avec Rust, Node et ses threads RSC. Elle ne représente pas le pic d'allocation.

| Snapshot | HTML/s | API/s | Flight/s | RSS totale après Flight |
| --- | ---: | ---: | ---: | ---: |
| [Avant streaming](benchmark-app-buffered-local.json) | 2 567 | 11 162 | 7 037 | 232,3 Mio |
| [Première version du streaming](benchmark-app-stream-initial-local.json) | 1 725 | 9 791 | 3 885 | 273,0 Mio |
| [Streaming optimisé](benchmark-app-local.json) | 2 169 | 10 615 | 5 728 | 266,8 Mio |

Le regroupement des petits blocs Flight, leur transfert sans copie quand leur allocation le permet, les écritures groupées dans le pipe et le décodage direct des métadonnées Rust réduisent le surcoût observé. Les petites réponses de la version actuelle restent plus coûteuses que celles du snapshot tamponné. Les démos et le graphe de composants ont aussi évolué : ces snapshots successifs ne constituent pas une comparaison A/B isolant une seule modification. Ils ne démontrent pas une économie globale de RAM.

```sh
BENCH_PROJECT=examples/app npm run bench
```

## Livraison progressive

Les API Pages qui terminent leur réponse en un seul `res.end()` — notamment via `res.json()` et `res.send()` — utilisent un chemin allégé si le corps ne dépasse pas **16 Kio** et qu'aucun `write()`, `writeHead()` ou `flushHeaders()` ne l'a précédé. Le worker évite alors le flux `PassThrough` intermédiaire et groupe en-tête, corps et fin dans une seule écriture vectorisée vers Rust. Il conserve une copie possédée des octets pour permettre au producteur de réutiliser son tampon après le callback. Il n'attend pas de remplir un tampon : toute réponse explicitement progressive garde le streaming et sa contre-pression. Aucune réponse API n'est mise en cache et chaque gestionnaire continue de s'exécuter.

La démo `/stream` contient deux composants serveur indépendants qui attendent volontairement 700 et 1 400 ms. Sur [trois requêtes après démarrage du worker](benchmark-stream-local.json), le premier bloc arrive entre **4,2 et 6,7 ms**, la première section vers **707 ms**, et la seconde vers **1 407 ms**. La réponse complète se termine vers 1 408 ms. Ces valeurs mesurent les octets HTML reçus, pas le moment où le navigateur les peint.

Les tests Chromium vérifient séparément que le layout est effectivement interactif avant la résolution du composant retardé, et qu'il conserve son état pendant les mises à jour. Les tests HTTP utilisent un verrou externe : ils lisent le premier bloc avant d'autoriser le serveur à terminer, plutôt que de se fier uniquement à une durée mesurée.

```sh
npm run bench:stream
```

## Mémoire et limites

Le transport utilise des blocs binaires d'au plus 64 Kio et une file native de quatre blocs. Il attend la consommation des données et libère les tampons en cas d'annulation ou de délai dépassé. Le pont RSC et la distribution HTML/Flight sont également bornés. Les API peuvent ainsi transmettre plus de 16 Mio sans assembler leur réponse entière dans Rustyx.

Ces garanties portent sur les tampons du framework. Une dépendance npm peut toujours allouer une grosse structure ou ignorer le résultat de `res.write()` ; les limites du framework ne remplacent pas un budget mémoire du code applicatif. Un flux long occupe encore un worker. Le SSR Pages et les réponses HTML des formulaires natifs restent tamponnés. Les Server Actions appelées par Flight transmettent désormais leur rendu progressivement après la mutation, par blocs transférables de 64 Kio au maximum ; aucun nouveau gain chiffré n’est revendiqué pour cette modification.

## Cache de données

Le [benchmark du cache](benchmark-cache-local.json) utilise une origine locale qui attend volontairement **10 ms**. Chaque parcours effectue 200 requêtes après une première lecture, avec quatre clients et un worker. Le tableau mesure le travail évité sur cette origine artificielle ; il ne compare pas Rustyx à Next.js.

| Parcours | Requêtes/s | Latence médiane | Appels à l'origine pendant les 200 répétitions |
| --- | ---: | ---: | ---: |
| `fetch` sans cache | 68 | 59,85 ms | 200 |
| `unstable_cache` | 1 570 | 2,15 ms | 0 |
| `fetch` avec cache | 1 743 | 2,05 ms | 0 |

La RSS après les trois parcours est de **10,0 Mio pour Rust**, et **137,3 Mio avec le worker Node**. Cette fixture utilise des route handlers ; elle ne charge pas de thread RSC pour rendre une page. La latence inclut l'attente des quatre clients devant le worker unique. Le premier appel sans cache inclut aussi le démarrage de ce worker.

Une [sonde séparée du service privé](benchmark-cache-native-local.json), sans worker Node, mesure environ 4 848 lectures/s pour une valeur de 512 octets, avec 5,8 Mio de RSS native. Une valeur de 2 Mio réduit ce débit à environ 160 lectures/s et porte la RSS à 52,7 Mio. Le transport du cache utilise encore JSON/base64 et des allocations temporaires : le stockage sur disque ne signifie donc pas que les grosses valeurs coûtent seulement la mémoire du pager SQLite. C'est un point d'optimisation restant.

Les tests vérifient également qu'au plus huit réponses du service privé restent en cours : huit clients TCP bloqués entraînent un `503` pour la neuvième opération, et la fermeture des clients libère la capacité.

```sh
npm run bench:cache
```

## Pages ISR servies par Rust

Le [snapshot ISR](benchmark-isr-local.json) mesure quatre clients pendant trois secondes par parcours. L'origine attend volontairement 10 ms pour rendre visible le travail évité. Les trois parcours cachés ne refont aucun appel à l'origine pendant leur mesure ; le SSR non caché en effectue 205. Aucune erreur HTTP n'a été observée.

| Parcours | Requêtes/s | Médiane | p95 | RSS Rust / totale |
| --- | ---: | ---: | ---: | ---: |
| HTML produit au build | 8 465 | 0,42 ms | 0,93 ms | 6,1 / 6,1 Mio |
| HTML produit à l'exécution, puis caché | 10 048 | 0,35 ms | 0,63 ms | 8,2 / 78,7 Mio |
| JSON de cette page | 9 981 | 0,36 ms | 0,60 ms | 8,3 / 78,7 Mio |
| SSR avec origine retardée | 67 | 60,05 ms | 63,37 ms | 10,7 / 112,1 Mio |

Le premier calcul d'une page absente prend 83,43 ms dans ce scénario, démarrage du worker Node et attente de l'origine compris. Le serveur conserve ensuite ce worker pendant 30 secondes d'inactivité pour amortir les régénérations proches. Après une pause de 31 secondes, une nouvelle lecture reste un `HIT`, aucun processus Node ne subsiste et la **RSS totale est de 8,0 Mio**. Le SSR démarre ensuite son worker de requêtes distinct.

La mémoire est relevée après chaque charge, pas au pic, et exclut le client, l'origine et le build. L'écart de débit avec le SSR reflète surtout les calculs et appels d'origine évités. Ces chiffres ne mesurent pas une accélération générale de JavaScript ni une comparaison avec Next.js.

```sh
npm run bench:isr
```

## App HTML et Flight servis par Rust

Le [snapshot App statique](benchmark-app-static-local.json) utilise aussi quatre clients pendant trois secondes, avec une origine locale retardée de 10 ms. Les parcours cachés ne rappellent pas l'origine pendant la mesure. Le SSR non caché l'appelle 205 fois. Toutes les réponses réussissent.

| Parcours | Requêtes/s | Médiane | p95 | RSS Rust / totale |
| --- | ---: | ---: | ---: | ---: |
| HTML App produit au build | 8 423 | 0,42 ms | 1,01 ms | 6,3 / 6,3 Mio |
| HTML App produit à l'exécution, puis caché | 9 890 | 0,36 ms | 0,61 ms | 8,8 / 119,6 Mio |
| Flight de cette page | 9 752 | 0,36 ms | 0,61 ms | 8,8 / 119,6 Mio |
| App SSR avec origine retardée | 67 | 59,61 ms | 65,51 ms | 11,3 / 156,6 Mio |

Le premier calcul d'un chemin absent prend 168,43 ms, avec démarrage du worker de maintenance, de son thread RSC et attente de l'origine. Après 31 secondes sans génération, ces ressources sont arrêtées ; une lecture reste un `HIT` avec **8,5 Mio de RSS totale et aucun processus Node**. Le SSR suivant démarre ensuite un worker de requêtes et son thread RSC.

La mémoire inclut les processus Node et leurs threads lorsqu'ils sont actifs. Elle est relevée après la charge, pas au pic, et exclut client, origine et build. Les parcours sont successifs sur la même instance. Ces résultats mesurent la réutilisation de pages déjà calculées ; ils ne démontrent ni une accélération générale du JavaScript ni une supériorité sur Next.js.

```sh
npm run bench:app-static
```

## Configuration, réécritures et proxy natifs

Le [snapshot de configuration](benchmark-config-local.json) mesure quatre clients pendant trois secondes par parcours. La fixture active des en-têtes personnalisés, des redirections et les trois phases de réécriture. Les réponses utilisent l'encodage identity, avec `compress:false`. Les pages App sont déjà précompilées ; le proxy interroge une origine HTTP locale sans délai artificiel. Tous les parcours réussissent sans démarrer de worker Node.

| Parcours | Requêtes/s | Médiane | p95 | RSS totale après charge |
| --- | ---: | ---: | ---: | ---: |
| Redirection native 307 | 21 968 | 0,15 ms | 0,26 ms | 9,3 Mio |
| Alias de page App, HTML caché | 12 308 | 0,28 ms | 0,50 ms | 11,2 Mio |
| Alias de page App, Flight caché | 11 725 | 0,30 ms | 0,54 ms | 11,3 Mio |
| Proxy HTTP local, réponse 201 | 12 614 | 0,26 ms | 0,45 ms | 12,5 Mio |

Les deux lectures de page réutilisent le même calcul du build sans rappeler l'origine. Leur métadonnée de réécriture dépend de la requête : le cache interne fournit les octets, puis Rust adapte la réponse de navigation et la marque privée sans cache HTTP. Le proxy effectue exactement 37 845 appels d'origine pour ses 37 845 requêtes mesurées. Le premier appel au proxy prend 2,19 ms dans cette exécution, initialisation du client comprise ; le scénario ne mesure pas de négociation TLS.

La RSS native commence à 7,8 Mio et inclut les allocations conservées par les parcours précédents sur la même instance. Elle est relevée après la charge, pas au pic. Le client, l'origine et le build sont exclus de cette mémoire ; client et origine partagent la machine et le processus de mesure. Les réponses sont vérifiées pendant la mesure. Ces microbenchmarks ne constituent pas une comparaison avec Next.js ni une estimation de capacité en production.

```sh
npm run bench:config --silent
```

## Route Handlers servis par Rust

Le [snapshot des handlers statiques](benchmark-route-static-local.json) mesure des réponses JSON avec quatre clients pendant trois secondes par parcours, sur Apple M4 et Node 22.17.1. L'origine locale attend volontairement 10 ms ; les réponses utilisent l'encodage identity. Les deux parcours cachés ne rappellent pas l'origine pendant la mesure, tandis que le handler dynamique l'appelle 202 fois. Toutes les requêtes réussissent.

| Parcours | Requêtes/s | Médiane | p95 | RSS Rust / totale |
| --- | ---: | ---: | ---: | ---: |
| JSON produit au build | 14 565 | 0,23 ms | 0,47 ms | 9,1 / 9,1 Mio |
| JSON produit à l'exécution, puis caché | 17 325 | 0,19 ms | 0,35 ms | 11,3 / 91,7 Mio |
| Handler dynamique avec origine retardée | 66 | 60,58 ms | 63,44 ms | 11,1 / 116,4 Mio |

Le premier calcul d'un chemin absent prend 82,38 ms, avec démarrage du worker Node de maintenance et attente de l'origine. Ce worker n'utilise pas de thread RSC. Après 31 secondes sans génération, il s'arrête : une nouvelle lecture reste un `HIT`, sans appel d'origine ni processus Node, avec **11,1 Mio de RSS totale**. Le parcours dynamique démarre ensuite un worker de requêtes distinct.

Les corps de ces réponses sont petits : 46 octets pour la version produite au build et 75 octets pour celle générée à l'exécution. La RSS est relevée après la charge, pas au pic, et inclut tous les processus descendants du serveur. Le client, l'origine et le build sont exclus ; les parcours partagent successivement la même instance. Le débit reflète ici la réutilisation de réponses calculées et l'absence d'attente d'origine, sans comparaison avec Next.js ni affirmation d'une accélération générale de JavaScript.

```sh
npm run bench:route-static --silent
```

## Middleware et chemins exclus

Le [snapshot middleware](benchmark-middleware-local.json) mesure quatre clients pendant trois secondes par parcours, sur Apple M4 et Node 22.17.1. Les réponses utilisent identity et les redirections ne sont pas suivies. Les cinq parcours partagent successivement la même instance ; aucun n'échoue. L'origine locale compte seulement les imports du module middleware, sans délai artificiel par requête.

| Parcours | Requêtes/s | Médiane | p95 | RSS Rust / totale |
| --- | ---: | ---: | ---: | ---: |
| Page App cachée, exclue du middleware | 11 539 | 0,30 ms | 0,55 ms | 9,5 / 9,5 Mio |
| Redirection du middleware | 15 208 | 0,20 ms | 0,56 ms | 9,8 / 156,1 Mio |
| Réponse JSON directe du middleware | 12 174 | 0,26 ms | 1,00 ms | 9,9 / 159,9 Mio |
| Middleware puis page App cachée réécrite | 9 275 | 0,37 ms | 0,87 ms | 10,0 / 160,3 Mio |
| Middleware puis Route Handler dynamique | 7 908 | 0,39 ms | 1,17 ms | 9,9 / 311,2 Mio |

Le premier parcours ne démarre aucun processus Node. Le premier appel de middleware prend 54,02 ms, démarrage de son worker et import applicatif compris. Après les trois parcours suivants et 31 secondes sans invocation, une lecture de la page exclue reste un `HIT`, avec **9,8 Mio de RSS totale et aucun processus Node**. Le dernier parcours redémarre le middleware et un worker de requêtes distinct ; ce premier passage prend 103,89 ms.

La RSS inclut les workers Node actifs et leurs allocations conservées après la charge. Elle est relevée après chaque parcours, pas au pic, et exclut client, origine et build. Ces scénarios ne démarrent pas de thread RSC. Les corps diffèrent : 1 837 octets pour la page exclue, aucun pour la redirection, 252 pour le JSON direct, 1 947 pour la page réécrite et 629 pour le handler dynamique. Les débits ne constituent donc pas une comparaison de tâches identiques.

Ces mesures montrent aussi le coût mémoire restant du JavaScript exécuté à chaque requête : le chemin natif ne signifie pas que les workers npm coûtent seulement quelques Mio. Le benchmark ne compare pas Rustyx à Next.js et ne prédit pas une capacité de production.

```sh
npm run bench:middleware --silent
```

## Chargement différé des moteurs de rendu

Le [comparatif des workers](benchmark-worker-memory-local.json) utilise le même compilateur, le même binaire Rust et les mêmes routes pour les deux versions du runtime. Chaque parcours démarre un serveur neuf avec un worker, puis reçoit 20 000 requêtes avec quatre clients. Les valeurs ci-dessous sont les moyennes de trois répétitions ; l'ordre avant/après alterne. Toutes les réponses et les transitions vers un rendu Pages puis App sont vérifiées.

| Parcours | RSS totale première requête, avant → après | RSS totale après charge, avant → après | Première requête, avant → après | Requêtes/s, avant → après |
| --- | ---: | ---: | ---: | ---: |
| Middleware JSON | 73,9 → 65,5 Mio | 153,4 → 144,9 Mio | 50,3 → 40,3 ms | 11 826 → 12 057 |
| Route Handler App | 74,3 → 66,6 Mio | 166,8 → 157,6 Mio | 50,3 → 41,7 ms | 11 968 → 11 961 |
| API Pages | 74,1 → 65,7 Mio | 141,6 → 133,9 Mio | 48,6 → 40,5 ms | 14 239 → 14 324 |

Le runtime précédent importait React et ReactDOM au démarrage de tous les workers. Le runtime actuel les charge lorsque le rendu d'une page les demande. Les sondes confirment leur absence avant ce rendu, puis leur présence dans le même processus, avec le compteur du module API conservé. Une application qui importe elle-même React en conserve naturellement le coût.

Le gain mesuré après charge est d'environ **8 à 9 Mio par worker**, avec un débit proche du précédent. La RSS inclut Rust et ses descendants Node ; elle exclut le client, le build et un éventuel lanceur npm/CLI extérieur au serveur natif. Elle est relevée après la première requête et après la charge, pas au pic. Aucun GC forcé, réglage du heap ou redémarrage de worker n'intervient pendant ces parcours. Les chiffres concernent ces petites réponses locales, sans comparaison avec Next.js.

```sh
npm run bench:worker-memory --silent
# Comparer aussi une copie historique de packages/rustyx :
BENCH_BASELINE_PACKAGE=/chemin/ancien/packages/rustyx npm run bench:worker-memory --silent
```

Le comparatif historique remplace les modules `runtime` et `compat` après le build ; le compilateur et `env.mjs` compilé restent identiques. Le JSON conserve les empreintes des sources et les résultats individuels. `BENCH_REPETITIONS` et `BENCH_REQUESTS` permettent d'ajuster la durée.

## Libération des requêtes terminées

Deux [diagnostics de rétention](benchmark-request-retention-local.json) vérifient les objets encore référencés, indépendamment de la RSS réservée par l'allocateur de Node :

- Une promesse applicative externe qui reste bloquée après la deadline de `waitUntil` conservait les observateurs du framework et leurs contextes. Quatre vagues de dix POST de 4 Mio faisaient croître les buffers vivants de 80 à 320 Mio. Après détachement des observateurs, ils restent à environ 8 Mio dans cette sonde, qui garde elle-même une dernière requête.
- Les timers des RPC du cache conservaient leurs contextes jusqu'à cinq secondes après des réponses déjà terminées. Avec quarante contextes contenant chacun 2 Mio de mémoïsation, la sonde passait à 80 Mio. Le nettoyage immédiat des timers maintient ici environ 4 Mio, correspondant aux dernières références d'import/connexion de la sonde. La deadline continue de couvrir la lecture du corps JSON, et l'annulation de la requête reste effective.

Ces sondes utilisent explicitement le GC pour distinguer les objets collectables de ceux encore retenus. Le serveur de production ne force aucune collecte. Les tests isolent ensuite l'import initial et les connexions HTTP pour vérifier qu'aucun des corps ou contextes mesurés ne subsiste. Ils couvrent aussi les sous-classes de Promise et les rejets tardifs. Le framework ne peut pas libérer les objets que le code applicatif conserve lui-même.

```sh
node --test packages/rustyx/runtime/request-memory.test.mjs
```

## Réglage optionnel du ramasse-miettes Node

Rustyx conserve les réglages adaptatifs de Node. Le [comparatif des tailles de génération jeune](benchmark-node-heap-local.json) explique ce choix : réduire cet espace économise parfois de la RAM, mais peut augmenter les promotions d'objets et ralentir leur traitement. Sur trois répétitions d'une API construisant puis sérialisant 4 096 objets, la limite de semi-espace à 4 Mio réduit le débit de **15,8 %**. La documentation Node recommande de mesurer ce compromis avec la charge de l'application. [Option Node `--max-semi-space-size`](https://nodejs.org/download/release/v22.17.1/docs/api/cli.html#--max-semi-space-sizesize-in-mib).

La variante à 8 Mio donne ces résultats moyens dans le profil de grosses allocations. La mémoire de ce tableau est celle du processus Node, **threads RSC compris une seule fois** ; Rust utilise en plus environ 9 Mio.

| Parcours | Débit adaptatif → semi-espace 8 Mio | RSS Node adaptative → semi-espace 8 Mio |
| --- | ---: | ---: |
| JSON de 1,21 Mo | 292 → 284 requêtes/s | 173,8 → 135,0 Mio |
| HTML App, table React de 1 400 lignes | 26,2 → 26,0 requêtes/s | 305,7 → 231,2 Mio |
| Flight de cette table | 46,5 → 46,9 requêtes/s | 289,5 → 237,7 Mio |

Chaque variante démarre un serveur neuf, puis enchaîne JSON, HTML et Flight, avec quatre clients et trois secondes par parcours. La RSS est relevée 550 ms après la charge, sans GC forcé. Les compteurs GC enregistrés dans le JSON sont cumulatifs depuis le démarrage de chaque isolate ; leur durée cumulée ne représente pas directement le temps de pause du processus. Ces chiffres instrumentés servent à comparer les réglages dans ce profil, pas à comparer les deux versions du runtime du tableau précédent.

Ce réglage reste facultatif et ne limite pas la RAM totale du processus. Dans un petit conteneur, Node peut déjà choisir un espace plus petit. Pour mesurer la même charge sur sa machine, puis essayer 8 Mio avec son application :

```sh
npm run bench:node-heap --silent
NODE_OPTIONS="--max-semi-space-size=8" npm run start -- examples/app --workers 1
```

Le script construit et supprime son propre projet temporaire avec le compilateur actuel. Il reproduit les allocations de ce scénario ; les octets ajoutés par le framework peuvent différer du snapshot historique. `npm run bench:node-heap --silent -- --smoke` vérifie seulement le fonctionnement du scénario sur une durée courte.

## Pages contenant des scripts tiers

Le [snapshot Script](benchmark-script-local.json) mesure des pages précompilées contenant réellement `next/script` et `rustyx/script`, avec un `_document` Pages personnalisé et un layout App. Les trois parcours utilisent quatre clients pendant trois secondes, sur Apple M4 avec Node 22.17.1 pour le build et le client de mesure. Chaque réponse est vérifiée : statut, type MIME, contenu, taille et cache `HIT`.

| Parcours caché | Requêtes/s | Médiane | p99 | RSS totale serveur |
| --- | ---: | ---: | ---: | ---: |
| HTML Pages avec Script | 12 693 | 0,27 ms | 1,36 ms | 8,4 Mio |
| HTML App avec Script | 12 620 | 0,27 ms | 1,36 ms | 8,5 Mio |
| Flight App avec Script | 12 684 | 0,27 ms | 1,40 ms | 8,6 Mio |

Les **113 999 requêtes** réussissent. Aucun processus Node ne démarre sous le serveur natif et aucune source de script tierce n'est appelée au build ou pendant la charge. Les corps mesurent respectivement 1 533, 3 874 et 1 564 octets, avec encodage identity. Le benchmark contrôle également le total des octets reçus pour détecter une erreur de comptage entre clients concurrents.

La RSS est relevée après chaque parcours, pas au pic ; elle inclut Rust et tous ses descendants, et exclut le build, le client de mesure et l'origine tierce locale. Les parcours partagent successivement le même serveur. Ce résultat vérifie que déclarer des scripts n'impose pas de rendu dynamique. Il ne mesure ni leur coût dans le navigateur ni les performances de Partytown, qui sont couverts fonctionnellement par Chromium. Il ne compare pas Rustyx à Next.js et ne prédit pas une capacité de production.

```sh
npm run bench:script --silent
# Vérifier uniquement le scénario, sans mesure de débit :
npm run bench:script --silent -- --check
```

Après les ajouts Draft Mode, polices, styles, métadonnées et compilation npm, le [nouveau snapshot](benchmark-compatibility-local.json) reprend ce même scénario, sur la même machine et avec les mêmes paramètres :

| Parcours caché | Requêtes/s | Médiane | p99 | RSS totale serveur |
| --- | ---: | ---: | ---: | ---: |
| HTML Pages avec Script | 11 867 | 0,28 ms | 1,43 ms | 8,7 Mio |
| HTML App avec Script | 13 131 | 0,27 ms | 1,33 ms | 8,8 Mio |
| Flight App avec Script | 13 138 | 0,27 ms | 1,33 ms | 8,8 Mio |

Les 114 423 requêtes réussissent, sans processus Node ni appel à l'origine tierce. Les deux snapshots sont des exécutions uniques : leurs écarts ne prouvent ni un gain ni une régression. Ils vérifient que les changements conservent le parcours natif du cache. Les limites du benchmark précédent restent applicables. Un test HTTP distinct vérifie également que les fichiers robots, sitemap et manifest précompilés sont servis sans démarrer de worker Node ; aucune mesure de débit dédiée à ces fichiers n'est présentée ici.

Après l'ajout des images natives, des routes parallèles/interceptées, de Cache Components avec pré-rendu partiel et de Fast Refresh, le [snapshot du 23 septembre 2026](benchmark-features-local.json) reprend ce scénario :

| Parcours caché | Requêtes/s | Médiane | p99 | RSS totale serveur |
| --- | ---: | ---: | ---: | ---: |
| HTML Pages avec Script | 12 526 | 0,27 ms | 1,42 ms | 9,0 Mio |
| HTML App avec Script | 12 763 | 0,27 ms | 1,36 ms | 9,1 Mio |
| Flight App avec Script | 13 136 | 0,27 ms | 1,34 ms | 9,3 Mio |

Les **115 282 requêtes** réussissent, avec contenu, statut, type MIME, taille et cache `HIT` vérifiés. Aucun worker Node ne démarre. Les réponses mesurent respectivement 1 533, 4 158 et 1 778 octets ; les arbres App ont évolué depuis les snapshots précédents. Cette exécution unique confirme que les nouveaux modules préservent le service natif des pages en cache ; elle ne démontre pas une accélération ou une réduction de RAM par rapport aux versions précédentes. Elle ne mesure ni le rendu dynamique, ni l'encodage d'images, ni le développement. La RSS est relevée après charge, pas au pic, et aucune comparaison avec Next.js n'est réalisée.

Après l'extension des routages complexes, du PPR et des options de configuration, le [snapshot des options avancées](benchmark-advanced-local.json) reprend le même scénario :

| Parcours caché | Requêtes/s | Médiane | p99 | RSS totale serveur |
| --- | ---: | ---: | ---: | ---: |
| HTML Pages avec Script | 12 785 | 0,27 ms | 1,38 ms | 9,0 Mio |
| HTML App avec Script | 12 901 | 0,27 ms | 1,34 ms | 9,1 Mio |
| Flight App avec Script | 12 984 | 0,27 ms | 1,36 ms | 9,1 Mio |

Les **116 019 requêtes** réussissent, sans processus Node ni appel à l'origine tierce. Les réponses mesurent respectivement 1 593, 4 282 et 1 870 octets. Le contenu, le statut, le type MIME, la taille et le cache `HIT` sont vérifiés pendant la mesure. Il s'agit d'une seule exécution locale, avec quatre clients pendant trois secondes par parcours ; la RSS est échantillonnée après charge et n'est pas une mesure du pic. Ce résultat vérifie le maintien du chemin de cache natif. Il ne mesure pas le coût du rendu dynamique, du PPR à la première visite, des branches conservées ou d'un gestionnaire de cache externe, et ne compare pas Rustyx à Next.js.

Après les ajouts du déploiement autonome, du runtime Edge, du cache incrémental externe et des enveloppes PPR génériques, le [snapshot final du cache natif](benchmark-cached-pages-local.json) reprend le même scénario :

| Parcours caché | Requêtes/s | Médiane | p99 | RSS totale serveur |
| --- | ---: | ---: | ---: | ---: |
| HTML Pages avec Script | 12 639 | 0,27 ms | 1,36 ms | 9,2 Mio |
| HTML App avec Script | 12 773 | 0,27 ms | 1,32 ms | 9,5 Mio |
| Flight App avec Script | 12 967 | 0,27 ms | 1,34 ms | 9,5 Mio |

Les **115 142 requêtes** réussissent, avec statut, contenu, type MIME, taille et cache `HIT` vérifiés. Aucun worker Node ni appel à l'origine tierce n'est déclenché. Les corps mesurent toujours 1 593, 4 282 et 1 870 octets. Cette exécution locale unique mesure quatre clients pendant trois secondes par parcours ; la RSS après charge exclut le client et le build et ne mesure pas le pic.

Ce contrôle confirme que les fonctionnalités facultatives ne démarrent pas leur runtime sur les pages déjà servies par le cache natif. Il ne mesure pas un rendu Edge ou SSR, le premier calcul PPR, un backend externe ou la consommation des modules npm. Les petits écarts entre snapshots ne démontrent ni gain ni régression et aucune comparaison avec Next.js n'est réalisée.
