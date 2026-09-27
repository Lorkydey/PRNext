# Dépendances npm

Le code applicatif et les modules npm s'exécutent avec Node 22 pour conserver React et les API Node. Rust assure le serveur HTTP et ses caches. PRNext n'a pas besoin d'installer le package `next` pour ses imports compatibles.

Dans Pages, les paquets ordinaires restent externes. Le compilateur suit leurs imports ESM, réexports, `import()` littéraux et `require()` littéraux. Un graphe qui atteint `next/*` ou `prnext/*` est compilé pour appliquer les adaptateurs. Cela fonctionne aussi lorsqu'une dépendance intermédiaire importe une bibliothèque Next. Les modules React restent partagés avec le runtime.

```js
export default {
  transpilePackages: ['shared-ui'],
  serverExternalPackages: ['runtime-loader'],
};
```

`transpilePackages` demande la compilation des paquets concernés, notamment TypeScript, JSX et CSS Modules. App compile déjà ces graphes par défaut. `serverExternalPackages` conserve la résolution Node et les fichiers adjacents du paquet côté serveur ; le graphe navigateur continue à être compilé. Une bibliothèque qui nécessite les transformations Next ou une frontière React ne peut pas rester externe. Les deux listes ne peuvent pas contenir le même nom.

L'analyse lit uniquement les sources atteintes et mémorise leur liste d'importations pendant le build. Elle est limitée à 8 Mio par fichier, 64 Mio de sources par graphe de compilation et 4 096 fichiers par analyse d'entrée. Aucune analyse npm supplémentaire ne s'exécute à la requête. Lorsque deux versions d'un paquet se résolvent différemment depuis la bibliothèque et la racine de l'application, le compilateur conserve la version atteinte dans le bundle ; une externalisation explicite ambiguë est refusée.

Avec `output: 'standalone'`, le build trace et copie les dépendances externes et leurs fichiers utiles ; aucune installation npm n'est nécessaire sur la cible. Voir le [déploiement autonome](standalone.md), les inclusions explicites pour les lectures calculées et les contraintes de plateforme/ABI des addons. Sans cette option, ces dépendances doivent être installées sur la cible. Un paquet combinant des imports Next et son propre chargeur `require()` calculé ou natif demande encore une séparation de son chargeur. Les imports Next calculés à l'exécution et les internes privés de Next ne sont pas couverts. Les [hooks/loaders pris en charge](compiler.md) sont raccordés aux graphes ; les plugins de graphe utilisent le backend webpack ; les plugins dépendant des internes privés de Next restent hors contrat.

Les tests construisent des paquets ESM/CJS et TypeScript/CSS sans installer Next, retirent les paquets compilés avant de servir les artefacts, vérifient les versions imbriquées et les chargeurs externes, puis vérifient l'hydratation et la navigation dans Chromium.

Références : [transpilePackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages), [serverExternalPackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages).
