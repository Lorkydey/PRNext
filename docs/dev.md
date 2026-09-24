# Développement et Fast Refresh

`rustyx dev` reconstruit les sources puis met à jour les navigateurs ouverts. Le transform et le runtime officiels `react-refresh` enregistrent les composants et les signatures de leurs hooks. Les pages de production ne contiennent ni Fast Refresh, ni connexion de développement, ni overlay.

## Modifications prises en charge

- **Composants client Pages et App** : mise à jour du rendu et des handlers sans rechargement du document. L'état des hooks des composants nommés est conservé lorsque leur signature reste compatible.
- **Styles CSS, PostCSS, Tailwind et Sass** : chargement des nouvelles feuilles avant le retrait des anciennes. Les classes CSS Modules restent communes au serveur et au navigateur.
- **Données serveur** : nouvelle requête de données Pages ou nouveau Flight App, avec conservation de l'arbre client compatible. Les caches de préchargement du navigateur sont invalidés.
- **Erreur de compilation** : l'application issue du dernier build valide reste servie. Un overlay affiche l'erreur ; sa correction permet de reprendre les mises à jour sans rechargement manuel.
- **Erreur d'exécution navigateur** : overlay pour les erreurs d'événements et de rendu. Une correction relance le composant ; un échec de rendu peut provoquer son remontage et perdre son état.

Les fichiers exportant à la fois des composants et des valeurs ordinaires, les fonctions anonymes non reconnues comme frontières React et certaines modifications de configuration déclenchent un rechargement complet. Ce repli privilégie un état cohérent. Les classes React ne bénéficient pas de la conservation des hooks. La directive React `// @refresh reset` peut demander un remontage du composant modifié.

Les modules de données CommonJS (`module.exports` et `exports.*`) conservent leur format pendant l'instrumentation de développement. Une modification de ces modules déclenche un rechargement complet pour actualiser leurs consommateurs. Les chemins réels et les liens vers le dossier de l'application sont reconnus, notamment les deux chemins `/var` et `/private/var` des dossiers temporaires macOS.

## Strict Mode

`reactStrictMode` accepte `true` ou `false` dans `next.config.*` ou `rustyx.config.*`. Sans option, il est activé pour App et désactivé pour Pages, conformément aux défauts de Next. Les racines SSR et navigateur utilisent le même choix.

En développement, Strict Mode vérifie notamment les montages et nettoyages d'effets. Les effets doivent donc tolérer une exécution supplémentaire. Une modification de cette configuration recharge le document pour appliquer le nouveau mode à toute la racine.

## Transport et coûts

Le serveur Rust expose `GET <basePath>/_rustyx/dev` uniquement pour un build de développement. Le transport utilise Server-Sent Events, sans processus Node chargé de maintenir les connexions. Une seule tâche native surveille l'état publié par la CLI toutes les 150 ms ; chaque navigateur reçoit la dernière notification. Les messages sont limités à 64 Kio et les connexions simultanées à 64. Les réponses ont `Cache-Control: no-store`.

La CLI publie ses notifications atomiquement dans `.rustyx-dev.json`, à l'extérieur du dossier de build. Les erreurs n'effacent pas le dernier build valide. Un build réussi redémarre encore le serveur natif et ses workers pour recharger la configuration, les routes et les modules serveur ; les navigateurs se reconnectent automatiquement. Les connexions SSE sont fermées lors de cet arrêt, sans attendre le délai de terminaison forcée.

Les notifications de fichiers sont regroupées pendant 150 ms puis comparées par empreinte SHA-256. Un générateur qui réécrit les mêmes octets ne déclenche donc pas une nouvelle compilation. Le filtre conserve au plus 512 chemins/empreintes, avec un budget comptabilisé de 1 Mio ; il lit les fichiers par blocs de 64 Kio sans en garder le contenu. Une entrée inconnue, évincée ou illisible provoque une compilation par prudence. Les fichiers `.contentlayer/generated/` sont surveillés pour récupérer les sorties MDX asynchrones ; le cache interne `.contentlayer/cache/` reste exclu.

Avec webpack, le compilateur transmet aussi les empreintes des sources réellement lues : leurs notifications de génération ne demandent pas un deuxième build lorsqu'elles correspondent déjà au résultat publié. Cet instantané supplémentaire est limité à 512 entrées et 1 Mio de métadonnées comptabilisées par compilation ; les contenus ne sont pas conservés. Une modification après lecture, ou deux cibles ayant lu des versions différentes, provoque toujours une reconstruction. Pour `ContentlayerWebpackPlugin`, l'instantané inclut ses répertoires, types et index générés après le hook `beforeCompile`. Cela suppose que le plugin attend effectivement la génération initiale ; le correctif pour Contentlayer 0.5.8 est décrit dans [la validation du blog](contentlayer.md). Une modification de `contentlayer.config.*` recycle le processus du compilateur.

Le processus de compilation persiste et réutilise jusqu'à huit contextes esbuild applicatifs, deux auxiliaires et leurs caches de parsing. Fast Refresh et plusieurs transformations réutilisent aussi un cache commun borné. Les scans et certaines transformations restent recalculés ; voir les [limites et bornes mémoire](compiler.md). React, ses renderers et les contextes du framework sont partagés entre les versions de chunks chargées dans un même document, ce qui évite une seconde copie de React pendant une mise à jour.

## Vérifications et limites

Les tests Chromium modifient réellement des fichiers pendant l'exécution de la CLI : composants, CSS, données serveur, syntaxe invalide puis corrigée, erreurs d'événements et de rendu, et option Strict Mode. Ils vérifient le compteur React et l'identité du document. Des tests distincts vérifient l'absence des outils de développement dans le JavaScript de production.

La conservation d'état n'est pas garantie pour tous les graphes de modules : les side effects au niveau module, les contextes applicatifs recréés et les dépendances mêlant des exports React et des usages externes à React peuvent nécessiter un rechargement. Les sources situées hors du dossier surveillé demandent encore une reconstruction explicite. Le diagnostic présente le message et la trace de l'erreur ; il n'inclut pas encore un éditeur intégré ni une navigation complète des source maps.

Références : [Fast Refresh dans Next](https://nextjs.org/docs/architecture/fast-refresh), [cas de rechargement complet](https://nextjs.org/docs/messages/fast-refresh-reload), [implémentation officielle React Refresh](https://github.com/facebook/react/tree/main/packages/react-refresh).
