# Optimisation ISR, PPR, images et API Pages

[Rapport avec graphiques](performance.html) · [Analyse et tableaux](analysis.md) · [Résumé CSV](summary.csv) · [Mesures CSV](measurements.csv) · [Données brutes](results.json) · [Vérification indépendante](validation.json) · [Changements](../../docs/hot-path-optimization.md).

La page HTML présente les résultats avec un comparateur de 11 scénarios et six mesures, une option pour afficher l'ancien Rustyx, les observations prolongées et la méthode. Elle fonctionne sans connexion externe et garde le tableau complet accessible sans JavaScript. Son design est conservé dans `scripts/templates/hot-path-performance.{html,css,js}` et rendu par `scripts/render_hot_path_page.py` : `python3 scripts/report-hot-paths.py` permet de la régénérer sans perdre la présentation. Les fichiers de mesures restent la source des chiffres affichés.

## Protocole principal

- Cinq projets aux sources identiques : boutique App, journal Pages multilingue, documentation avec ISR, dashboard PPR et portail asynchrone.
- Trois moteurs : binaire/runtime Rustyx préservés avant modification, Rustyx optimisé, Next.js 16.3.5 en production avec webpack.
- Un worker Rustyx, allocateur système, admission adaptative désactivée, budget des files de réponse de 8 Mio. Aucun profil PGO ni option de tas V8 dans la campagne principale.
- Serveurs successifs, trois répétitions de cinq secondes par scénario, ordre alterné. 200 requêtes de chauffe avant chaque essai ; limite client de dix millions de requêtes, non atteinte.
- Onze scénarios, soit 99 essais : ISR, image en cache, API Pages POST et GET, Flight PPR, HTML PPR, API attendant 30 ms, upload API de 32 Kio, deux parcours mixtes C64 et API asynchrone C512. C4 pour les autres charges.
- CPU et RSS de l'arbre de processus serveur entier, incluant Node et ses threads RSC. Le client tourne dans un autre processus sur le même Mac. Les pics RSS sont échantillonnés. Les pages mémoire partagées peuvent être comptées plusieurs fois entre processus.
- Le débit ne compte que les réponses avec statut et contenu valides. Les requêtes dynamiques reçoivent des identifiants distincts vérifiés dans la réponse. La même image WebP de 2 254 octets est servie ; les autres charges utilisent `Accept-Encoding: identity`.
- Les cinq paires de projets passent 36 comparaisons fonctionnelles navigateur/API. Les empreintes des sources, des copies de runtime et des binaires sont enregistrées. Les tests ne tournent pas pendant les mesures.

Chaque essai redémarre le serveur. Les hits ISR et images peuvent donc être servis sans démarrer le worker JavaScript : leur RSS très bas ne représente pas celui du même site après un rendu React dynamique. Les scénarios mixtes et API incluent la mémoire des workers effectivement démarrés.

Le CPU/réponse est le temps CPU serveur total divisé par les réponses valides. À saturation, un serveur qui fournit davantage de réponses peut consommer plus de CPU total. Les différences de quelques pourcents et les plages de répétitions qui se recouvrent restent incertaines.

**Machine partagée :** pendant la campagne finale, l'analyse de stockage macOS `OtherUsersStorageExtension` a été observée à environ 100 % d'un cœur. Les observations sont conservées dans `background-observations.jsonl`. Ce processus est exclu des comptes CPU/RSS des serveurs, mais sa concurrence pour les ressources peut modifier les temps, la fréquence des cœurs et la dispersion. Les répétitions ne sont pas supprimées en fonction de leur résultat. Refaire ces mesures sur une machine au repos avant un dimensionnement de production.

Validation du code : 554 tests JavaScript, 133 tests Rust, 273 tests HTTP et 45 tests navigateur ciblés réussis ; TypeScript et Clippy réussis. Les tests ajoutés vérifient notamment le partage des images, l'expiration, la conservation des admissions, le protocole binaire malformé, l'isolation PPR et la libération des contextes terminés.

## Reproduction

Les builds Next et l'ancien runtime proviennent de `reports/next-runtime-comparison/projects`. Ils sont conservés. Le binaire précédent se trouve dans `baseline/target/release/rustyx`. Les candidats reconstruits sont sous `projects/`. Le paquet Next installé peut être indiqué avec `RUSTYX_NEXT_REFERENCE`.

```sh
HOT_PHASE=check node scripts/bench-hot-paths.mjs
HOT_REPETITIONS=3 HOT_DURATION_MS=5000 node scripts/bench-hot-paths.mjs
python3 scripts/report-hot-paths.py
```

Filtres disponibles : `HOT_ENGINES`, `HOT_SCENARIOS` et `HOT_OUTPUT`. Les serveurs sont arrêtés après chaque essai et en cas d'erreur. Les scénarios de ce rapport ne démontrent ni une capacité universelle, ni une compatibilité Next exhaustive, ni l'endurance d'un déploiement Linux.

## Expériences séparées

`threads-pilot.json` et `threads-stress-pilot.json` testent le nombre de threads natifs sur le binaire précédent. `iteration-one-results.json` et `iteration-two-results.json` conservent les deux séries complètes intermédiaires. Leurs runtimes sont conservés sous `iteration-one-runtime/` et `iteration-two-runtime/`. `second-pilot.json` est un essai intermédiaire, antérieur à l'index des modules Pages et à la mémorisation des fonctions de lecture de contexte. Ne pas mélanger ces séries pour calculer les médianes finales.

`memory-profile.json` explore `--max-semi-space-size=8` avec **la même option sur Next et Rustyx**, une observation de quatre secondes par moteur/scénario. C'est un réglage V8, distinct des gains obtenus en Rust, et il n'est pas activé par défaut. Il peut modifier le coût du GC et augmenter la jeune génération dans les petits conteneurs où Node choisit déjà une valeur inférieure. Tester sur la machine cible avant utilisation.

Le script `profile-hot-paths.cjs` permet une collecte CPU diagnostique avec `HOT_NODE_PRELOAD`. Les mesures instrumentées doivent rester séparées des comparaisons de performance.

`interrupted-iteration-three.json` conserve un passage interrompu pour supprimer une rétention du premier contexte App dans une promesse globale. Il est exclu de la campagne finale. `retention-regression.log` confirme la rétention avant correction ; le test `request-memory.test.mjs` vérifie la collecte après correction.

`sustained.json` mesure séparément le parcours PPR mixte à 64 clients pendant 60 secondes pour Rustyx et Next, puis 15 secondes de repos et deux secondes de récupération. Une observation par moteur, sans fusion avec les médianes des essais courts :

```sh
HOT_ENGINES=rustyx,next HOT_REPETITIONS=1 HOT_DURATION_MS=60000 HOT_SCENARIOS=dashboard:mixed-64 HOT_RECOVERY=1 HOT_OUTPUT=sustained.json node scripts/bench-hot-paths.mjs
```

Le petit écart CPU Flight des essais courts est également vérifié avec une observation séparée de 30 secondes par moteur, à quatre clients. Les 200 requêtes de chauffe initiales chauffent les caches, sans garantir que V8 a terminé toutes ses optimisations JIT :

```sh
HOT_ENGINES=rustyx,next HOT_REPETITIONS=1 HOT_DURATION_MS=30000 HOT_SCENARIOS=ppr-flight HOT_OUTPUT=flight-sustained.json node scripts/bench-hot-paths.mjs
```
