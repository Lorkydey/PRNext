# Profils de production

Le profil de production par défaut est `balanced`, sans modifier les sources de l’application :

```sh
corepack yarn prn build
corepack yarn prn start
```

Les trois profils principaux sont `balanced`, `speed` et `memory`, tous sélectionnés avec `--profile`. `classic` permet de retrouver les réglages historiques. Redémarrer le serveur pour changer de profil sur le même build. Pour une installation locale depuis ce dépôt, reconstruire d’abord le binaire avec `npm run build:native`, puis refaire le build de l’application.

| Profil principal | Priorité | Compromis recherché |
| --- | --- | --- |
| `balanced` (défaut) | Équilibrer RAM, CPU et latence | Génération jeune intermédiaire, optimisation mémoire V8 et concurrence intermédiaire. |
| `speed` | Répondre vite, notamment aux flux async concurrents | Plus de rendus simultanés ; accepte davantage de RAM et de charge CPU. |
| `memory` | Réduire la RAM sous forte concurrence | Petite génération jeune, moins de rendus simultanés ; accepte davantage d’attente et de CPU par réponse. |

Le profil `cpu` est supprimé. `--profile cpu` et `PRNEXT_PROFILE=cpu` sont refusés au démarrage ; choisir explicitement `balanced` ou `speed` pour le remplacer. Les rapports précédents contenant des mesures CPU restent des archives.

## Profil mémoire

```sh
corepack yarn prn start --profile memory
```

`memory` privilégie la RAM lors des pics de concurrence avec une petite génération jeune et moins de rendus simultanés. Il accepte davantage de GC, de CPU par réponse et d’attente. Il ne garantit pas une RAM inférieure à `balanced` sur toute application ou à faible charge.

La variable `PRNEXT_PROFILE=memory` permet aussi de sélectionner ce profil.

## Profil historique : classic

`classic` est le nouveau nom de `standard`, avec exactement les mêmes réglages. `prn start` sans option ni variable de profil utilise désormais `balanced`. Pour conserver l’ancien comportement :

```sh
corepack yarn prn start --profile classic
```

Les deux autorisent 32 pages ou flux simultanés par worker. `balanced` active l’optimisation mémoire de V8, limite les API actives à 256 au lieu de 512 et réduit le budget de réponses en transit à 4 Mio au lieu de 8 Mio. Cela peut économiser de la RAM au prix de davantage de travail de récupération mémoire et d’un débit inférieur à saturation.

L’ancien nom `standard` reste un alias de `classic`, dans `--profile` et `PRNEXT_PROFILE`, pour préserver les scripts existants. Le serveur affiche le nom canonique `classic`. Les rapports de benchmark historiques conservent l’étiquette `standard` utilisée lors des mesures.

`compact` conserve les réglages historiques de `PRNEXT_MEMORY_PROFILE=compact` et reste accepté par `--profile` pour la compatibilité.

Un profil ne peut pas minimiser simultanément RAM, CPU et latence pour tous les sites. Le [comparatif avec Next.js](../reports/speed-next-balanced/README.md) mesure `speed` et `balanced` face à Next.js en production. Les [mesures précédentes](../reports/profile-comparison/README.md) détaillent aussi l’ancien mode CPU et le mode mémoire.

## Réglages effectifs

Les capacités suivantes correspondent à un worker avec le transport concurrent actuel. Elles ne créent pas de workers supplémentaires. Les anciens transports restent limités à leur capacité négociée.

| Profil | Semi-space V8 (Mio) | `optimize-for-size` | Démarrages avant headers | Pages/flux vivants | API actives | Budget de réponses en transit (Mio/pool) |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `classic` | Automatique | Non | 16 | 32 | 512 | 8 |
| `compact` | 4 | Oui | 16 | 32 | 512 | 8 |
| `balanced` | 8 | Oui | 16 | 32 | 256 | 4 |
| `speed` | 16 | Non | 32 | 128 | 512 | 16 |
| `memory` | 2 | Oui | 8 | 16 | 64 | 1 |

La table est partagée par le natif Rust et le runtime JS dans `packages/prnext/runtime/profiles.json`. Le budget de réponses est partagé dans chaque pool ; c’est un plafond de données en transit, pas une réservation permanente ni un plafond global de RAM. Les contextes React, les caches applicatifs, les buffers des autres couches et les allocations des dépendances restent comptés en plus.

Le permis de démarrage est rendu après les headers. Le permis de réponse reste détenu pendant le flux, jusqu’à sa consommation, son annulation ou son expiration. Les files d’attente, délais et budgets restent bornés dans tous les profils. Le mode rapide ne désactive aucune de ces protections.

## Variables et priorités

```sh
PRNEXT_PROFILE=memory corepack yarn prn start
# L’option explicite gagne sur la variable : ce serveur utilise speed.
PRNEXT_PROFILE=memory corepack yarn prn start --profile speed
```

Ordre : option explicite `--profile` → `PRNEXT_PROFILE` → ancien `PRNEXT_MEMORY_PROFILE=compact` → `balanced`. Un nom inconnu dans la nouvelle option ou variable provoque une erreur au démarrage.

`NODE_OPTIONS=--max-semi-space-size=8` conserve le choix explicite de semi-space, même si le profil en propose un autre. L’orthographe Node avec underscores est aussi reconnue. `PRNEXT_RESPONSE_BUFFER_MIB` (1 à 64) conserve la priorité sur le budget de transit proposé par le profil. `--workers` continue de contrôler le nombre de workers, indépendamment du profil.

Les profils s’appliquent à la production (`prn start`). Le développement conserve ses réglages habituels, désormais nommés `classic`. Il n’y a ni plafond arbitraire de vieille génération, ni GC forcé, ni recyclage périodique des workers. Un mode mémoire ne garantit donc pas un site sous 100 Mio ou une économie fixe en pourcentage.

## Ce qui est mesuré et préservé

Les profils ne modifient pas la sémantique du cache, l’ISR, les règles d’invalidation ou les données renvoyées. La campagne vérifie avant les chronométrages les cookies, les paramètres, les mutations, la revalidation, le streaming et 10 000 rendus SSR pour 10 000 requêtes identiques. Les adaptations Flight/Actions de PRNext restent des protocoles propres à PRNext, comme dans les rapports de parité précédents ; ces modes ne certifient pas une compatibilité Next.js totale.

La [documentation Node](https://nodejs.org/download/release/v22.17.1/docs/api/cli.html#--max-semi-space-sizesize-in-mib) explique le compromis entre taille de semi-space, mémoire et débit. La jeune génération est plus grande qu’un seul semi-space. Les [limites des Worker threads](https://nodejs.org/download/release/v22.17.1/docs/api/worker_threads.html#new-workerfilename-options) restent subordonnées au réglage semi-space passé à Node ; les valeurs de la table ne sont pas des limites de RSS.
