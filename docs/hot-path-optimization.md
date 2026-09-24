# ISR, Flight PPR, images et API Pages

Cette série réduit le travail effectué pour chaque réponse et les allocations temporaires. Les résultats mesurés avant/après et face à Next.js sont conservés dans [le rapport](../reports/hot-path-optimization/README.md).

## Ordonnanceur natif

Par défaut, le nombre de threads Tokio suit `--workers`, dans la limite du parallélisme disponible. Un worker JavaScript utilise donc un thread de multiplexage des entrées/sorties. Les opérations bloquantes continuent sur le pool dédié. Cela réduit les réveils et les migrations entre cœurs pour les petits sites et les VPS.

`TOKIO_WORKER_THREADS` conserve la priorité sur ce défaut. Une application servant beaucoup de contenu natif sur plusieurs cœurs peut avoir intérêt à augmenter cette valeur ; mesurer le débit, le CPU par réponse et les latences sur la machine cible.

## Images déjà encodées

Le cache chaud conserve au plus **1 Mio comptable**, **64 entrées** et **64 Kio encodés par image**. Le budget est réduit si la limite du cache disque est inférieure. Il compte les octets, les clés, les métadonnées et une réserve par entrée ; les structures de l'allocateur s'ajoutent à cette comptabilité. Aucune image décodée n'y entre.

Les réponses concurrentes partagent les mêmes `Bytes`. Une réponse lente conserve sa réservation d'admission jusqu'à la consommation ou l'abandon de son corps. L'expiration, les paramètres d'image autorisés, la négociation de format, HEAD et les validateurs HTTP restent vérifiés. Les gros fichiers utilisent le disque. Désactiver le cache disque désactive aussi la rétention dans ce cache chaud.

Un hit chaud évite les requêtes SQLite, l'ouverture du fichier et son passage par le pool bloquant. Le TTL de l'image reste applicable : modifier son fichier source n'invalide pas immédiatement une image déjà calculée, comme avec le cache disque précédent.

## API Pages et transport

Les réponses déjà terminées de **16 Kio maximum** peuvent utiliser une trame binaire complète négociée par Rust. Elle évite les trames de début/bloc/fin et la file de streaming intermédiaire. La taille et l'identifiant sont validés ; le budget partagé est réservé avant l'allocation. L'admission reste attachée au corps jusqu'à sa consommation ou son abandon.

Les réponses progressives, les plus grandes réponses et la publication ISR conservent le protocole de streaming. Un ancien runtime ignore l'option de négociation ; un ancien binaire ne la demande pas.

Après décodage d'un upload Pages, les octets bruts sont consommés dans `IncomingMessage`, au lieu de garder simultanément le JSON et sa file d'octets. `bodyParser: false` garde l'accès au flux brut. Le contexte des caches ne conserve plus une autre référence à l'upload. Les primitives HTTP Web réservées aux handlers App sont chargées à la demande ; les objets `Headers` et cookies d'un contexte Pages sont construits seulement s'ils sont utilisés, à partir d'une copie des en-têtes de la requête.

Les API Pages ESM déjà chargées disposent d'un index de 256 références maximum vers leurs espaces de noms. Cela évite de refaire la résolution et la chaîne de promesses d'importation à chaque appel. Node conserve déjà ces modules ; l'index ne garde aucune promesse d'importation ni contexte de requête. Les modules CommonJS continuent à observer `require.cache`. Les annulations sont vérifiées avant l'utilisation d'un module chaud.

Le chargement paresseux des primitives App ne garde lui aussi que les fonctions résolues. Un test avec références faibles vérifie que les contextes des appels terminés sont collectables, y compris le premier : garder la promesse globale d'importation retenait son contexte asynchrone.

## ISR et PPR

Une génération ISR publiée porte déjà ses informations d'invalidation. Le hit n'exécute donc plus les deux lectures SQLite concernant le repli sur les fichiers de build. La requête de génération publiée réutilise aussi sa préparation SQL. Les validations du cache et des fichiers restent actives, y compris les invalidations externes.

Le PPR classe les sous-arbres statiques pendant la préparation du modèle borné déjà existant. La reprise peut partager ceux qui n'ont ni trou dynamique, ni propriété vivante, ni clé à remplacer. Les cycles et les branches concernées utilisent la fusion ordinaire. Le modèle racine et les données du visiteur restent propres à chaque requête. Le budget des modèles normalisés n'est pas augmenté.

La reprise réutilise un seul signal d'annulation combiné. La limite des octets du Flight intermédiaire est appliquée par un lecteur unique, sans la seconde file d'un `TransformStream`. Annulation, erreurs et régulation du débit restent propagées. Les modules de rendu HTML sont chargés lorsqu'un document HTML en a besoin.

Le profilage a révélé des résolutions CommonJS répétées pour retrouver les lecteurs de contexte des caches et de génération statique. Leur fonction de lecture est maintenant résolue une fois. Chaque appel continue à lire le contexte asynchrone courant : aucune donnée de visiteur n'est mémorisée dans cette référence globale.

## Limites mémoire

Ces budgets ne sont **pas un plafond global de RSS**. React et les modules npm exécutent toujours du JavaScript dans Node/V8. Les objets applicatifs, les images en cours de décodage, les buffers réseau et les pages partagées peuvent augmenter la mémoire totale. Aucun plafond arbitraire du tas V8, GC forcé ou allocateur expérimental n'est activé par cette série.

Reconstruire le binaire natif et le projet pour intégrer tous les changements :

```sh
npm run build:native
node packages/rustyx/cli.mjs build /chemin/du/projet
```

Les builds historiques des rapports sont conservés pour permettre les comparaisons.
