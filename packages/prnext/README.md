# PRNext

Anciennement Rustyx. Serveur HTTP et caches en Rust, avec React et les modules npm exécutés sur Node.js.

> **Alpha très expérimentale — 0.1.0-alpha.1**
>
> Cette version est destinée aux essais et aux retours de développeurs, pas aux applications de production. La compatibilité avec Next.js est partielle. Des bugs, des fonctionnalités manquantes et des changements incompatibles sont à prévoir.

Le paquet s'appelle `prnext`. Il fournit les commandes `prnext` et `prn`.

Après publication de l'alpha et de ses paquets natifs, dans une application compatible :

```sh
npm install prnext@alpha
npx --no-install prn check
npx --no-install prn dev
```

Production : `npx --no-install prn build`, puis `npx --no-install prn start`.

La distribution utilise un paquet natif par plateforme : macOS arm64/x64 et Linux glibc arm64/x64. Garder les dépendances optionnelles activées. Node.js 22+ est requis ; Rust n'est pas nécessaire chez les utilisateurs. Alpine/musl et Windows natif n'ont pas encore de paquet précompilé. Utiliser WSL sur Windows. Les binaires Linux de la CI sont construits sur Ubuntu 22.04 (glibc 2.35).

React et React DOM doivent correspondre exactement à la version de `react-server-dom-webpack` utilisée par PRNext (voir `peerDependencies`). La migration `prn migrate --dry-run`, puis `prn migrate`, vérifie la configuration et prépare cet alignement. Cette pré-vérification ne garantit pas la compatibilité complète de l'application.

Pour contribuer au framework, depuis la racine du dépôt :

```sh
npm install
npm run build:native
node packages/prnext/cli.mjs build examples/app
node packages/prnext/cli.mjs start examples/app
```

`start` utilise le profil `balanced` par défaut. Les profils `speed`, `memory` et `classic` se sélectionnent avec `--profile`.

Le checkout utilise Rust stable pour compiler le serveur. La distribution npm utilise son binaire installé automatiquement, sans dépendre du checkout. Les commandes `--help` et `--version` restent utilisables si le paquet natif est absent ; le démarrage explique alors comment le réinstaller.

Les nouveaux builds utilisent `.prnext/`, les imports propres au framework utilisent `prnext/*`, et les variables de configuration commencent par `PRNEXT_`. Les imports compatibles `next/*` restent pris en charge. Après le renommage, reconstruire l'application avec `prn build`.
