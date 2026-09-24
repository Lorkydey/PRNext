# Next.js / Rustyx après reconstruction du runtime

Cette campagne mesure le Rustyx standard reconstruit, face à Next.js 16.3.5 / React 19.3.0 / Node 22.17.1. Rustyx utilise un worker JavaScript, l’allocateur système et un budget de files de réponse de 8 Mio par pool. L’admission adaptative, mimalloc et la PGO ne sont pas activés. Les empreintes du binaire et des sources figurent dans les données brutes.

[Rapport interactif](performance.html) · [Analyse](analysis.md) · [Médianes CSV](summary.csv) · [Mesures individuelles](measurements.csv) · [Compilations](builds.csv) · [Données brutes](results.json) · [Validation indépendante](validation.json).

## Projets et méthode

Six configurations issues de cinq projets de démonstration : boutique Edge et variante Node, journal Pages/i18n, dashboard PPR, portail SSR/asynchrone/proxy, documentation de 100 pages SSG. Les douze copies locales sont dans `projects/`. Les sources applicatives sont identiques entre moteurs et vérifiées par SHA-256. Les répertoires générés des exemples sont exclus lors de la copie pour mesurer des builds indépendants.

- 44 comparaisons fonctionnelles appariées : HTTP, navigateur, hydratation, actions, routage et images.
- 48 builds : initial, sans modification, après modification du titre, puis restauration, pour chaque moteur et configuration. Durée et pic RSS échantillonné ; une observation par variante. Next utilise `--webpack`.
- 216 passages par route ou parcours mixte : trois répétitions à quatre clients, cinq secondes par route et huit secondes par parcours mixte.
- 72 passages de concurrence : 1, 16, 64 et 128 clients ; trois répétitions aux points 16/64/128 du dashboard et du portail, un passage aux autres points.
- Six passages de 60 secondes à 64 clients, sur dashboard, portail et documentation. Quinze secondes de repos puis deux secondes de charge légère vérifient la récupération.
- Six passages supplémentaires sur l’API attendant 30 ms, à 512 clients : trois répétitions de cinq secondes par moteur, suivies d’une récupération. Le fichier `stress.json` conserve ces résultats séparément. Cette charge ne constitue une surcharge que si la capacité du moteur est dépassée ; les refus éventuels ne sont pas des réponses utiles.

Les serveurs sont lancés successivement, avec un nouveau processus par essai et un ordre alterné. Échauffement de 200 requêtes à quatre clients, sauf streaming (16) et API asynchrone (40). Les caches persistants Rustyx sont réinitialisés avant chaque passage, puis les routes chaudes sont préchauffées. Les caches du système d’exploitation ne sont pas purgés. Aucun build ou test navigateur ne tourne pendant les essais de charge.

Le CPU est le temps cumulé du serveur et de ses descendants. Le coût par réponse compare le travail d’un nombre égal de réponses valides ; un faible pourcentage CPU seul ne démontre pas une meilleure efficacité. La RAM est la somme des RSS, échantillonnée environ toutes les 150 ms, avec les workers Node et threads RSC inclus. Des pages partagées peuvent être comptées plusieurs fois et les pics entre sondages peuvent être manqués.

Le client de charge est exclu des compteurs serveur mais partage le Mac Apple M4 de 16 Gio. Il contrôle statuts, contenu, cookies et paramètres variables, compression et signatures binaires. La charge fonctionne en boucle fermée : une connexion émet la prochaine requête après la réponse précédente. Les routes très rapides peuvent être limitées par le client. Le CPU du client est conservé dans les données.

## Limites de l’interprétation

Les écarts modestes et les mesures uniques ne permettent pas de désigner un vainqueur fiable. Les refus et erreurs restent visibles et sont exclus du débit utile ; le CPU dépensé pour les refus reste compté. Les médianes du rapport portent sur les passages complets, sans erreur et avec compteurs CPU valides ; le nombre de passages exclus est affiché.

Cette comparaison ne mesure pas Turbopack, un export statique Next servi sans Node, CDN, TLS, réseau distant, base de données externe, quotas CPU de VPS, Linux, consommation électrique ou endurance sur plusieurs jours. Les délais de 30/80 ms sont synthétiques. Le proxy testé est le hook applicatif local. Les contrôles fonctionnels ne prouvent pas une compatibilité Next exhaustive.

## Reproduction

Définir une destination nouvelle et une installation Next contenant les dépendances indiquées, avec Sharp fonctionnel :

```sh
export RUSTYX_NEXT_REFERENCE=/chemin/vers/node_modules/next
export AUDIT_REPORT_DIR=reports/next-runtime-comparison-nouveau
export RUSTYX_ADAPTIVE_ADMISSION=0
export RUSTYX_RESPONSE_BUFFER_MIB=8
AUDIT_PHASE=prepare node scripts/audit-current-next.mjs
AUDIT_PHASE=load node scripts/audit-current-next.mjs
node scripts/stress-current-next.mjs
node scripts/report-current-next.mjs
python3 scripts/validate-current-next.py
```

`prepare` refuse d’écraser les copies existantes. `load` reprend uniquement les passages manquants et vérifie les empreintes. Le rapport lit l’interprétation dans `analysis.md`. Le validateur attend le protocole complet de 300 passages. Les dépendances des copies sont des liens locaux ; il faut réinstaller et reconstruire pour reproduire ailleurs.
