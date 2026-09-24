# Admission asynchrone et CPU PPR — comparaison locale

Le rapport compare **Rustyx avant cette intervention**, **Rustyx optimisé** et **Next.js 16.3.5 / webpack**, sur trois applications contrôlées aux sources identiques : portail (API, SSR, proxy), dashboard (PPR, Flight, navigation) et journal (Pages API). Ces applications sont des démonstrations, pas des sites de production indépendants.

- [Graphiques et tableaux](performance.html)
- [Analyse](analysis.md)
- [Résumé CSV avec dispersion](summary.csv) et [chaque mesure](measurements.csv)
- [Résultats bruts](results.json), [statistiques structurées](summary.json), [vérification arithmétique indépendante](validation.json)
- Les trois copies migrées sont conservées dans `projects/`.

## Changements évalués

Rust gère un ordonnanceur qui crée ses connexions de travail à la demande et réutilise en priorité les dernières libérées. Les nouveaux workers autorisent jusqu’à 512 admissions API par processus ; les rendus React restent limités à 16. Ils partagent le même pool, avec admission avant lecture des corps et budget entrant commun de 32 Mio. Les connexions supplémentaires inactives sont libérées après 30 secondes. Les anciens builds sans le nouveau marqueur de capacité restent à 16 connexions ; il faut reconstruire le projet.

Le thread RSC utilise une jeune génération V8 limitée à 16 Mio, retenue après des essais à 8, 16 et 32 Mio. Le PPR réutilise des préparations statiques bornées, sans retenir les objets internes du décodeur, les contextes ou modèles vivants des visiteurs. Les identités des manifestes et le contenu Flight sont vérifiés. Les valeurs non rejouables utilisent le chemin ordinaire. Les accès aux parents du modèle vivant sont mémorisés pour une seule requête ; les valeurs statiques déjà prêtes ne créent plus de promesses inutiles. Le JSON des artefacts n’est réutilisé qu’après une lecture autorisée du cache natif et une comparaison exacte des octets. Chaque reprise HTML obtient sa propre continuation React.

Le cache de préparation RSC contient au plus 8 entrées et un budget comptable de 512 Kio ; le mémo JSON, 16 entrées et 256 Kio encodés. Les objets JavaScript, références en cours et bibliothèques s’ajoutent à ces plafonds. Augmenter le nombre de réponses simultanées peut augmenter la RAM : aucun plafond global de RSS n’est revendiqué.

## Protocole

108 essais principaux terminés : 14 groupes, trois moteurs. Trois répétitions de 6 secondes pour chaque scénario ordinaire ; une observation de 45 secondes pour chacun des deux scénarios continus ; une observation de 6 secondes à C1024 pour la surcharge. Neuf contrôles de récupération à C4 pendant 2 secondes suivent les essais continus et de surcharge, après 1,5 seconde de repos. Ils sont stockés séparément sous `recovery`.

Un seul serveur de production tourne pendant les mesures ; aucune compilation, suite de tests ou session de profilage ne tourne en parallèle. L’ordre des moteurs change entre répétitions. Chaque essai redémarre le serveur et le préchauffe à C4 : 200 requêtes, sauf API asynchrone C4 (40). Le cache persistant Rustyx est réinitialisé ; les caches de l’OS et les caches du build Next ne sont pas purgés. Les scénarios de comparaison visent des réponses préchauffées. Le cache natif et le cache applicatif sont inclus dans le fonctionnement normal.

Rustyx est configuré avec un worker Node. Le thread RSC et les processus descendants sont inclus dans le CPU et le RSS du serveur. Le CPU provient des compteurs cumulés `ps`, le RSS est échantillonné toutes les 150 ms. Le client de charge est exclu de ces totaux mais partage la même machine Apple M4 de 16 Gio, avec les applications de bureau habituelles. Les deux moteurs peuvent utiliser plusieurs cœurs. Le RSS peut compter plusieurs fois des pages partagées.

La charge est en boucle fermée. Chaque réponse vérifie son statut et son contenu, ainsi que les identifiants de visiteur/cookies/requête quand applicables. Le débit compte seulement les réponses valides. La latence est calculée sur les réponses valides. Le client relance immédiatement après un 503 et ne respecte pas `Retry-After` : il s’agit d’un scénario de surcharge agressif, pas d’une estimation du taux d’erreur réel d’un site.

Quand un moteur refuse des requêtes, son CPU par réponse valide inclut le coût des refus : ne pas interpréter cette valeur comme un traitement identique au moteur sans refus. Un coût CPU par réponse inférieur ne garantit pas un CPU total inférieur quand le débit augmente.

Les médianes, minimums, maximums et écarts-types d’échantillon sont fournis. Trois essais courts ne suffisent pas pour conclure sur quelques pourcents de différence. Les essais de 45 secondes sont des observations uniques, pas une preuve d’absence de fuite mémoire sur plusieurs jours.

## Validation fonctionnelle

Sur la version finale : 537 tests JavaScript, 124 tests Rust, 273 tests HTTP et 30 tests navigateur ciblés réussis ; TypeScript et Clippy sans avertissement. Les 22 comparaisons fonctionnelles entre Next et Rustyx des trois projets passent également. Les tests couvrent notamment 384 handlers réellement actifs dans le même processus, la non-préallocation de centaines de connexions, les refus bornés et la récupération, les annulations, les gros uploads, les workers bloqués, le PPR/Flight, les cookies, les collections, les invalidations et la navigation.

## Reproduire

Les empreintes du binaire, du framework et du client de charge sont dans `results.json`. Le binaire antérieur est conservé localement dans `/tmp/rustyx-before-admission-ppr/rustyx` ; ses sources sont archivées dans `baseline-source.tgz`. Les builds antérieurs Rustyx et Next se trouvent sous `../current-comparison/projects/<site>/{rustyx,next}`. Le binaire courant est `../../target/release/rustyx`. Le framework utilise toujours Node/React pour le code JavaScript et les composants ; ce n’est pas un moteur React réécrit intégralement en Rust.

```sh
# Référence : installation existante de Next 16.3.5, avec React 19.3.0.
export RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next
# La préparation reconstruit les copies de cette campagne et remplace son results.json.
ADMISSION_PHASE=prepare node scripts/bench-admission-ppr.mjs
# Fermer les autres tests, builds, serveurs et profileurs avant les mesures.
ADMISSION_PHASE=load node scripts/bench-admission-ppr.mjs
node scripts/report-admission-ppr.mjs
node scripts/analyze-admission-ppr.mjs
node scripts/report-admission-ppr.mjs
python3 scripts/validate-admission-ppr.py
node scripts/validate-admission-report.mjs
```

`ADMISSION_SCENARIOS=ppr-flight,async-512` permet une sélection ; le script reprend les essais manquants et refuse de mélanger des empreintes différentes. Le validateur attend la campagne complète de 108 essais. `pilot-results.json` conserve les premiers essais de la version intermédiaire, avant la préparation statique RSC ; ils ne sont pas agrégés au rapport final.

## Essais de réglage conservés

`heap8/` contient les 108 essais de la version intermédiaire avec une jeune génération RSC de 8 Mio. `experiments/heap.json` conserve six essais exploratoires de 30 secondes (deux par valeur : 8, 16, 32 Mio), effectués sur une copie de build où seul ce paramètre change. La campagne principale a ensuite été relancée intégralement avec 16 Mio ; les résultats des différentes versions ne sont pas fusionnés.

Les chiffres d’une série ne sont pas directement substituables à ceux d’une autre : la dispersion et l’état de la machine sont visibles, notamment dans les essais GC. Le choix de 16 Mio recherche un compromis CPU/RAM ; augmenter la jeune génération ne garantit pas un gain universel.
