# Optimisation async, concurrence, PPR et proxy

Ouvrir [performance.html](performance.html). Les données mesurées et les identifiants SHA-256 sont dans [results.json](results.json) ; [summary.csv](summary.csv) contient les médianes. Les sources optimisées de trois projets sont enregistrées sous `projects/` et correspondent aux copies conservées dans `../next-audit/projects/`.

Le rapport compare trois moteurs dans la même campagne : ancien binaire et ancien runtime Rustyx, Next.js 16.3.5, Rustyx optimisé. Les sources applicatives sont identiques. Les dépendances et builds locaux sont ignorés par Git. Les liens `node_modules` utilisent l’installation de l’audit précédent.

## Reproduction

Depuis la racine du dépôt, préparer une **nouvelle destination** :

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next \
ASYNC_BASELINE=/chemin/vers/sauvegarde-avant-modification \
ASYNC_REPORT=reports/async-nouveau \
ASYNC_PHASE=prepare node scripts/bench-async-concurrency.mjs
```

La sauvegarde doit contenir le binaire `rustyx` antérieur. La campagne enregistrée utilise `/tmp/rustyx-before-async/rustyx` ; les builds antérieurs complets se trouvent dans `reports/next-audit/projects/*/rustyx`. Ne pas les reconstruire avec le nouveau framework avant de rejouer la comparaison « avant ».

Après arrêt des autres tests et compilations, remplacer `ASYNC_PHASE=prepare` par `ASYNC_PHASE=load` en conservant la même destination et les mêmes binaires. Le runner vérifie les hashes et reprend les passages manquants. `ASYNC_SCENARIOS=api-async,stream,proxy` permet de sélectionner des scénarios ; une campagne partielle ne remplace pas la campagne complète. Les journaux des passages en erreur sont conservés localement.

Génération du rapport :

```sh
ASYNC_REPORT=reports/async-nouveau node scripts/report-async-concurrency.mjs
```

Le texte d’analyse est lu depuis `analysis.md` dans le dossier du rapport. Les fichiers HTML et CSV sont autonomes. La mesure du proxy concerne ici `proxy.js` suivi d’un rendu SSR ; les réécritures HTTP/HTTPS externes sont vérifiées séparément par les tests Rust et HTTP.
