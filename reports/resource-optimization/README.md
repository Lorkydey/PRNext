# Comparaison des six pistes de réduction CPU / RAM

Les trois applications et leurs versions antérieures sont conservées. `baseline.json` identifie le binaire et l’archive des sources avant cette intervention. Les builds précédents se trouvent sous `../admission-ppr/projects` ; les références Next 16.3.5 / webpack sous `../current-comparison/projects/<site>/next`.

Les variantes utilisent les mêmes sources applicatives : ancien Rustyx, nouveau Rustyx par défaut, Next, nouveau Rustyx avec admission adaptative, avec mimalloc, et compilé avec PGO. Les trois dernières sont des variantes distinctes, pas une combinaison de toutes les options. La PGO a été entraînée séparément sur les trois applications locales.

- [Données brutes](results.json)
- [Mécanismes, limites et commandes](../../docs/resource-optimization.md)
- [Synthèse et graphiques](performance.html)
- [Statistiques CSV](summary.csv)
- [Analyse des gains et régressions](analysis.md)
- [Validation indépendante des chiffres](validation.json)
- [Suites de tests](checks.json)
- [Vérification des graphiques et de l’affichage mobile](ui-validation.json)

Deux répétitions de six secondes par scénario court, serveurs successifs et ordre inversé au second passage. Le serveur redémarre entre essais, avec 200 requêtes d’échauffement à concurrence 4. Les essais prolongés durent 30 secondes et ne sont observés qu’une fois ; ils vérifient ensuite la récupération pendant 2 secondes à concurrence 4. Ils restent séparés des essais courts.

CPU et RSS incluent les descendants du serveur, dont le thread RSC. Le client de charge partage le Mac Apple M4 de 16 Gio mais est exclu de ces compteurs. Il n’y a ni build, ni test, ni profileur pendant les mesures. Les caches OS ne sont pas purgés. Le RSS peut compter plusieurs fois des pages partagées. Les différences de quelques pourcents et les résultats des allocateurs sur macOS ne préjugent pas de Linux. Le débit et les latences portent sur les réponses valides ; toute erreur/refus reste comptabilisée.

Reproduction après construction des trois copies et des binaires concernés :

```sh
export RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next
RESOURCE_PHASE=prepare node scripts/bench-resource-optimization.mjs
RESOURCE_PHASE=load node scripts/bench-resource-optimization.mjs
RESOURCE_PHASE=sustained RESOURCE_ENGINES=before,rustyx,next node scripts/bench-resource-optimization.mjs
node scripts/report-resource-optimization.mjs
python3 scripts/validate-resource-optimization.py
```

La préparation remplace les résultats de cette campagne ; conserver une copie avant une nouvelle version. `RESOURCE_ENGINES` et `RESOURCE_SCENARIOS` sélectionnent des variantes et scénarios. Le chargement reprend les passages manquants et refuse de mélanger des empreintes de sources/binaires différentes. Les projets doivent être reconstruits pour incorporer les modules runtime actuels.

Le validateur indépendant attend la campagne complète : 90 passages, 22 comparaisons fonctionnelles et les six récupérations. Les résultats des entraînements PGO ne sont jamais utilisés dans les statistiques. Les variantes PGO et mimalloc correspondent à des binaires séparés ; le binaire standard garde l’allocateur système et n’active pas l’admission adaptative.
