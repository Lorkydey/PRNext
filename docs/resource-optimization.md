# Réduction des copies, buffers et coût natif

Cette série ajoute six mécanismes, avec des niveaux de maturité différents. React et les modules npm continuent à s’exécuter dans Node. Les mesures se trouvent dans [le rapport local](../reports/resource-optimization/README.md).

## Artefacts PPR entre threads

Le parent enregistre les octets immuables d’un artefact une fois, puis envoie un identifiant au thread RSC. Les huit entrées sont bornées à 256 Kio comptables par registre, avec au plus 64 Kio par entrée (deux octets comptés par caractère). Les objets du registre s’ajoutent à ces limites. Les gros artefacts conservent l’envoi ordinaire.

L’identité porte sur le contenu exact. L’artefact est toujours obtenu via le cache natif et ses invalidations avant l’envoi de l’identifiant. L’enregistrement, les requêtes et l’éviction utilisent le même MessagePort ; le récepteur résout l’identifiant avant toute attente asynchrone. Un redémarrage reconstruit le registre. Aucun cookie, modèle vivant ou contexte visiteur n’y entre.

## Continuation PPR directe, limitée aux cas prouvés

Une préparation statique dont les trous remplacent des champs entiers à la racine du modèle peut consommer directement le modèle React vivant dans l’encodeur final. Cela évite un encodage et un décodage intermédiaires. Le classificateur ne parcourt que les valeurs normalisées connues, sans appeler de fonctions applicatives.

Les trous imbriqués, collections contenant des trous, cycles, propriétés vivantes liées aux segments et routages avancés conservent l’aller-retour Flight existant. Ce n’est pas une suppression générale des conversions PPR. Un test compare le résultat au chemin ordinaire avec le véritable encodeur/décodeur React et deux visiteurs.

## Budget des réponses

Les connexions d’un même WorkerPool partagent désormais **8 Mio** pour les blocs en cours de lecture depuis Node ou en attente dans leurs files Rust. La réservation précède l’allocation et est libérée lorsque le consommateur HTTP prend le bloc, ou lorsque la réponse est abandonnée. La comptabilité arrondit à 4 Kio. Les files restent limitées à quatre blocs de 64 Kio par réponse.

Ce budget ne couvre pas les buffers Node, noyau, compression, ni les octets déjà consommés/conservés en aval. Les autres pools ont leur propre budget ; ce n’est pas un plafond global de RSS. Conserver les réservations jusqu’à la destruction des octets ferait bloquer un collecteur qui assemble une réponse plus grande que le budget. Les tests vérifient précisément ce cas, les gros flux et l’annulation entre workers.

`RUSTYX_RESPONSE_BUFFER_MIB=8` configure le budget par pool (entier de 1 à 64 ; valeur absente/invalide : 8). Une limite trop basse peut réduire le débit des gros flux et créer des attentes ; elle ne réduit pas le contenu d’une réponse. Le délai de blocage existant reste de 30 secondes. Le budget entrant partagé de 32 Mio reste distinct.

## Admission adaptative, option expérimentale

`RUSTYX_ADAPTIVE_ADMISSION=1` active des contrôleurs séparés pour les admissions API et pages. Sans cette variable, les plafonds existants restent en vigueur : jusqu’à 512 API et 16 rendus par worker sur le nouveau transport.

Le contrôleur observe le temps entre envoi au pool et réception des en-têtes, hors lecture du corps entrant et attente dans la file d’admission. Il réévalue les limites après au moins 32 réponses réussies et 500 ms, selon la latence moyenne et le niveau d’occupation. Il réduit progressivement la capacité disponible sans interrompre le travail accepté ; la capacité remonte lorsque les conditions s’améliorent. Les limites maximales et les files bornées restent inchangées. Le plancher est de 16 API ou 4 pages par worker.

Il n’y a pas de thread de surveillance, ni de collecte de métriques lorsque l’option est désactivée. Ce contrôleur ne mesure pas directement le CPU, le RSS ou les quotas cgroup ; c’est une première adaptation par latence. Les mélanges de routes lentes/rapides, les longs streams et le nombre de refus doivent être évalués avant activation. Le middleware garde son admission propre et partage toujours le pool principal.

## Compilation guidée par profils

`scripts/build-pgo.mjs` propose les phases `generate`, `train`, `build` et `all`. Les binaires instrumenté et optimisé sont séparés de `target/release`, sous `target/pgo`. Les sources Rust, Cargo.lock, la version du compilateur et les features doivent rester identiques entre phases. Les profils sont fusionnés avec le `llvm-profdata` du toolchain ; le script installe `llvm-tools-preview` si nécessaire.

```sh
node scripts/build-pgo.mjs --phase all --train-script scripts/train-resource-pgo.mjs
```

Le trainer fourni utilise les trois applications conservées dans `reports/resource-optimization/projects`, préalablement construites avec Rustyx. Ses requêtes instrumentées entraînent le compilateur : **leurs timings ne sont pas des benchmarks**. Pour un déploiement, fournir un trainer représentatif de l’application et de l’architecture cible. Le binaire résultant est `target/pgo/optimized/release/rustyx`. La PGO n’optimise pas le code machine V8 de Node.

## Allocateur optionnel

Le feature Cargo `mimalloc` sélectionne l’allocateur pour Rust. Le build par défaut conserve l’allocateur système.

```sh
node scripts/cargo.mjs build --release --features mimalloc --target-dir target/mimalloc
```

Le résultat est `target/mimalloc/release/rustyx`. Cette option n’altère pas l’allocateur de Node/V8. Tester les pics, la mémoire après récupération et le CPU sous Linux sur le VPS cible avant de la retenir. Le script PGO accepte aussi `--features mimalloc` pour entraîner et compiler cette combinaison séparément.

Sources techniques : [messages entre threads Node](https://nodejs.org/download/release/v22.17.1/docs/api/worker_threads.html), [régulation des flux Node](https://nodejs.org/learn/modules/backpressuring-in-streams), [admission Envoy](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/adaptive_concurrency_filter), [PGO Rust](https://doc.rust-lang.org/rustc/profile-guided-optimization.html), [mimalloc](https://github.com/microsoft/mimalloc).
