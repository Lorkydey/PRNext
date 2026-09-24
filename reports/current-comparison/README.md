# Rustyx actuel / Next.js : campagne comparative

Ouvrir [performance.html](performance.html) pour les graphiques interactifs, les tableaux et le bilan. [analysis.md](analysis.md) contient l’interprétation ; [summary.csv](summary.csv) s’ouvre dans Excel ou LibreOffice. [measurements.csv](measurements.csv) conserve les passages individuels, [results.json](results.json) les mesures détaillées et [summary.json](summary.json) les médianes, dispersions et variations appariées par répétition.

## Périmètre

Six configurations issues de cinq projets de démonstration : boutique Edge et sa variante Node, journal Pages/i18n, dashboard PPR, portail SSR/asynchrone/proxy, documentation de 100 pages SSG. Les douze copies sont sous `projects/`. Leurs sources sont identiques entre moteurs et vérifiées par SHA-256. Ces fixtures ne sont pas un échantillon d’applications de production externes.

Référence installée : Next.js 16.3.5, React 19.3.0, Node 22.17.1. Rustyx utilise le binaire release et le runtime présents au début de cette campagne ; aucune optimisation du moteur n’est ajoutée pour le benchmark. Tous les projets sont reconstruits avec le runtime actuel. Les dépendances sont partagées par liens locaux.

## Protocole

- 44 comparaisons fonctionnelles appariées, avec navigateur, requêtes HTTP, captures et contrôles d’images.
- 48 compilations : initiale, inchangée, modification du titre, restauration ; par projet et par moteur. Chaque variante est une observation unique. Next utilise `--webpack` ; aucun comparatif de build Turbopack n’est effectué.
- 216 passages de charge par route ou parcours mixte : trois répétitions par moteur sur 36 scénarios. C4, cinq secondes par route et huit secondes par parcours mixte.
- 72 passages de capacité : C1/C16/C64/C128 sur les six configurations, avec trois répétitions à C16/C64/C128 pour le dashboard et le portail ; un passage pour les autres points. Six secondes par passage.
- Six passages continus de 60 secondes à C64 : dashboard, portail et documentation, chacun sur les deux moteurs. Quinze secondes de repos, puis deux secondes de charge légère vérifient la récupération. Ces réponses supplémentaires sont comptées séparément.
- Six passages complémentaires de surcharge volontaire à C512 sur l’API asynchrone du portail : trois répétitions de cinq secondes par moteur. Ils sont conservés séparément dans [stress.json](stress.json), suivis d’une vérification de récupération. Le client recommence immédiatement après un refus et ne respecte pas Retry-After ; ce n’est pas une simulation de clients bien régulés. Un refus reste une requête non satisfaite, même s’il protège la mémoire.

Les 294 passages principaux démarrent chacun un nouveau serveur. L’ordre des moteurs alterne. Préchauffage : 200 requêtes à C4, sauf streaming (16) et API asynchrone (40). Les essais chronométrés sont exécutés successivement, après arrêt des builds et des tests navigateur. Le cache persistant Rustyx est réinitialisé avant chaque passage ; les routes chaudes et les images sont préchauffées. Les caches du système d’exploitation ne sont pas purgés.

CPU = temps cumulé du serveur et de ses descendants pendant la charge, hors client ; 100 % représente un cœur. RSS = somme des processus, sondée environ toutes les 150 ms ; les pages partagées peuvent être comptées plusieurs fois. Les pics entre sondages peuvent être manqués. Les workers et threads RSC sont inclus.

Le générateur HTTP est un autre processus mais partage la machine. Il contrôle statuts, contenu, cookies/paramètres personnalisés, compression et signatures binaires selon le scénario. Les réponses en erreur ne sont jamais comptées comme débit utile. La charge est en boucle fermée : une connexion envoie la prochaine requête après la réponse précédente. Le client peut limiter les routes très rapides. Les relevés sont descriptifs ; trois répétitions ne justifient pas un intervalle de confiance solide.

Pas de CDN, TLS, réseau distant, vraie base de données externe, profilage CPU par fonction, mesure de consommation électrique, ni test d’endurance sur plusieurs heures. Un contrôle à 60 secondes ne démontre pas l’absence de fuite mémoire à long terme. Les délais applicatifs de 30/80 ms sont synthétiques. Le scénario « proxy » vérifie le hook applicatif et le SSR local, pas les performances d’un service amont distant.

## Reproduction

Utiliser une destination nouvelle et une installation Next contenant les versions et dépendances indiquées. Sharp doit être fonctionnel et identique dans les deux environnements. La phase de préparation refuse d’écraser des projets existants.

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next \
AUDIT_REPORT_DIR=reports/current-comparison-nouveau \
AUDIT_PHASE=prepare node scripts/audit-current-next.mjs
```

Après fermeture des autres tests/builds :

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next \
AUDIT_REPORT_DIR=reports/current-comparison-nouveau \
AUDIT_PHASE=load node scripts/audit-current-next.mjs
```

La phase `load` peut reprendre les passages manquants ; les empreintes empêchent de mélanger des versions de runtime ou de binaire. Le plan de chaque projet est enregistré dans `trialPlan`. Les logs de build sont locaux et ignorés par Git ; les statuts, durées et pics sont conservés dans le JSON. Les liens `node_modules` et les builds ne sont pas portables sans réinstallation/recompilation.

Après la fin complète de la campagne principale, mesurer la surcharge, sans autre charge concurrente :

```sh
RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next \
AUDIT_REPORT_DIR=reports/current-comparison-nouveau \
node scripts/stress-current-next.mjs
```

```sh
AUDIT_REPORT_DIR=reports/current-comparison-nouveau \
node scripts/report-current-next.mjs
```

Le générateur de rapport prend les conclusions éditoriales dans `analysis.md`. Il publie tous les essais, y compris les éventuelles erreurs. Les médianes ne portent que sur les essais sans erreur, sans plafond du client atteint et avec compteurs CPU valides ; le nombre d’essais exclus reste visible. Les statistiques incluent min/max, écart type échantillonnal et coefficient de variation lorsque plusieurs passages sont disponibles.

## Vérifications finales

[validation.json](validation.json) conserve la vérification indépendante des 300 essais, des sources, des compteurs et des statistiques. [ui-validation.json](ui-validation.json) décrit les contrôles des graphiques, filtres, liens et affichages desktop/mobile. Vérifier les données avec la bibliothèque standard Python :

```sh
python3 scripts/validate-current-next.py
```

Ce vérificateur attend le protocole complet par défaut : 294 passages principaux et six surcharges. Les CSV supplémentaires [builds.csv](builds.csv) et [overload.csv](overload.csv) couvrent les compilations et les refus sous surcharge.
