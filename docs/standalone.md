# Déploiement autonome

```js
export default {
  output: 'standalone',
  // distDir: 'build/server',
};
```

Le build produit `<distDir>/standalone` (`.prnext/standalone` par défaut). Copier **tout ce dossier en conservant ses liens symboliques**, puis lancer :

```sh
HOSTNAME=0.0.0.0 PORT=3000 ./start
```

Le script `start` remplace son processus par le serveur Rust. Il n'entretient pas de processus Node de supervision ; les workers de rendu restent démarrés à la demande. `PRNEXT_WORKERS` configure leur nombre et `PRNEXT_NODE` permet de choisir l'exécutable Node. L'alternative portable `node server.js` démarre le même binaire et transmet les signaux d'arrêt, avec un petit processus Node parent supplémentaire. Elle utilise le Node qui lance ce fichier.

Le dossier contient le binaire natif, les modules serveur compilés, le runtime, les seules dépendances npm tracées, les assets et `public`. Il fonctionne sans sources, sans configuration exécutée au démarrage, sans installation npm et sans le `node_modules` initial. Le pointeur `distDir` est inclus. Contrairement au serveur standalone Next, les assets et les fichiers publics sont copiés automatiquement.

Node 22 ou supérieur reste nécessaire pour React, les handlers et les paquets npm. Le binaire livré et les addons sont ceux de la plateforme de compilation : construire dans un environnement compatible avec l'OS, l'architecture, les bibliothèques système et l'ABI Node de la cible. Ce mode n'effectue pas de compilation croisée et n'embarque pas Node. Les liens relatifs sont nécessaires à la résolution des workspaces ; sous Windows, leur création exige les permissions de liens symboliques.

## Traces et monorepos

PRNext utilise `@vercel/nft` pour suivre les imports, `require`, fichiers lus et addons natifs. Il trace les conditions Node habituelles et `react-server`, les entrées sélectionnées dynamiquement par le manifeste et le décodeur Flight. Les versions npm imbriquées restent distinctes. Les paquets hoistés hors du projet sont relogés dans le paquet autonome, avec des liens relatifs ; aucun chemin de résolution ne dépend de leur ancien emplacement.

```js
import path from 'node:path';

export default {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/api/export': ['templates/**/*.html', '../../shared/data/*.json'],
  },
  outputFileTracingExcludes: {
    '/api/export': ['templates/drafts/**'],
  },
};
```

La racine de trace est le projet par défaut. Elle doit contenir le projet et les fichiers externes de workspace nécessaires. Les clés sont des motifs de routes sans `basePath`, et les motifs de fichiers sont relatifs au projet. Les caractères spéciaux d'une route dynamique peuvent être échappés, par exemple `'/api/\\[slug\\]'`. Les exclusions s'appliquent à la trace de la route concernée ; une dépendance utilisée par une autre route reste conservée. Les fichiers compilés indispensables, les assets et `public` ne sont pas supprimés par les exclusions. Les fichiers inclus explicitement sont soumis aux exclusions de la même route.

Les chargements entièrement calculés ne sont pas toujours déductibles. Déclarer alors les fichiers dans `outputFileTracingIncludes`, en évitant les motifs couvrant tout le dépôt. Les chemins absolus codés dans un module applicatif restent absolus : utiliser `process.cwd()`, `import.meta.url`, `__dirname` ou une configuration de déploiement relative. `standalone.json` indique la plateforme, l'ABI et les avertissements de trace ; ceux-ci peuvent concerner des dépendances optionnelles absentes. Les tests de déploiement restent nécessaires pour les branches propres à l'application.

Les fichiers `.env*` ne sont pas copiés implicitement. Fournir les variables au déploiement, ou inclure volontairement le fichier requis. Les valeurs explicitement publiques et les props prérendues gardent leur comportement de build habituel. Le `package.json` est conservé pour la résolution Node et les lectures de métadonnées applicatives ; ses scripts ne sont pas exécutés. La configuration source du projet n'est pas copiée implicitement.

Les limites de préparation sont de 100 000 fichiers et 2 Gio de contenu tracé et copié, avec 32 Mio par source analysée et 512 Mio cumulés de lectures de source. Les avertissements sont bornés à 128 messages de 2 048 caractères. Ces opérations ont lieu uniquement au build, dans un Worker isolé des globals du prérendu ; le mode standalone ne charge pas le traceur en production, et un build ordinaire ne l'importe pas. Un échec de préparation conserve le build et son pointeur actifs.

Validation : copie isolée après suppression du projet initial, Pages SSR/statique, App HTML/Flight, hydratation/navigation, CSS, fichiers publics, module npm lisant ses données adjacentes, versions imbriquées, workspace et vrai addon Sharp/libvips.

Références : [option `output` et file tracing Next](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [Node File Trace](https://github.com/vercel/nft).
