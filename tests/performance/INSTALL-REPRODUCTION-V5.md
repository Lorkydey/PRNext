# Reproduction isolée de l’installation

Le script est préparé, **pas encore exécuté**. Lancer uniquement après la fin des
mesures HTTP, avec l’accord du responsable de campagne :

```powershell
python tests/performance/install-reproduction-v5.py --cpus 4,5
```

Il réutilise Node 24.19.0 dans `artifacts/performance/node24/node.exe` et npm
11.12.1 déjà installé dans `C:/Program Files/nodejs/node_modules/npm`. Ces chemins
proviennent de `artifacts/performance/npm-ci-node24.19.json`. Le script vérifie
versions et empreintes avant installation ; il n’installe ni ne met à jour ces
outils. Python doit fournir `hashlib.file_digest` (Python 3.11 ou plus récent).

Le dossier `artifacts/performance-v5/install-reproduction` doit être absent.
Aucune suppression ni réutilisation d’un ancien essai n’est effectuée.
Le script vérifie les chemins absolus bornés, archive le commit exact
`63847087826f178de3a32f165231b20b6c66b92e` avec `git archive`, puis valide toutes
les entrées ZIP avant extraction. Il refuse traversées, chemins absolus,
collisions de casse, flux Windows alternatifs, liens et fichiers spéciaux.

Deux copies intégrales sont extraites dans `original` et `lock-fixed`. Le seul
fichier remplacé dans la seconde est le `package-lock.json` actuel. Les empreintes
de tous les fichiers archivés doivent confirmer cette unique différence.
Le `node_modules` du dépôt principal n’est jamais une cible d’installation.

Chaque copie reçoit la même commande :

```text
<Node 24.19.0> <npm-cli.js 11.12.1> ci --no-audit --no-fund --ignore-scripts=false --include=dev --include=optional
```

Les scripts d’installation sont explicitement actifs et les dépendances de
développement/optionnelles incluses. Les caches et fichiers de configuration npm
sont isolés dans le dossier d’essai. Le téléchargement des dépendances sera donc
possible **lors de l’exécution ultérieure**, jamais pendant cette préparation.
Les processus enfants héritent de l’affinité 4/5 et appartiennent à un Job Windows
fermé après chaque commande, y compris sur expiration du délai.

Les sorties stdout/stderr, commandes, versions, codes de sortie, dates,
empreintes d’archive/sources/lockfile/outils et versions effectivement installées
sont conservées. Un code de sortie original inattendu n’empêche pas l’essai de
la copie corrigée ; une erreur de lancement ou de nettoyage arrête la procédure.

L’hypothèse attendue est `EUSAGE` avec exactement les six paquets natifs manquants
pour l’original, puis une installation réussie pour la copie corrigée. Un résultat
différent est conservé : `complete` signifie que les deux essais ont terminé,
tandis que `expectedOutcomeMatched` indique séparément si l’hypothèse est vérifiée.
La procédure n’altère jamais le résultat pour le faire correspondre à l’attente.

Cette reproduction porte sur Windows x64 et ne prouve pas l’installation native
des cinq autres combinaisons OS/architecture.

## Intégration au rapport et à l’audit

`install-report-v5.py` fournit `collect(inputs)` / `render(data, base)` pour le
rapport et `verify(base)` pour l’audit. Les deux entrées utilisent les mêmes
vérifications : journaux et empreintes, commandes actives, versions, archive et
inventaires sources, six messages `Missing` exacts, installation corrigée et
versions effectivement présentes dans son `node_modules`.

Le rapport est déjà raccordé à ce module. Sans `result.json`, il annonce une
reproduction non exécutée ou indisponible ; avec une preuve incohérente, il
affiche les écarts sans confirmer la réussite.

Le raccordement à `audit-v5.py` a été ajouté après la fin de la campagne HTTP,
car son empreinte faisait partie de la provenance des essais actifs.
`verify(base)['verified']` est obligatoire pour l’audit final ; l’absence est
signalée comme attente en mode partiel. Un JSON présent ne suffit jamais à valider.
Une preuve présente mais incohérente est un échec, même en mode partiel.
L’audit conserve `inputSha256`, les `issues` et l’empreinte de l’analyseur, puis
vérifie que le lockfile courant correspond à celui installé avec succès.

Tests synthétiques préparés, à exécuter seulement au créneau autorisé :

```powershell
python -m unittest discover -s tests/performance -p test_install_report_v5.py -v
python -m unittest discover -s tests/performance -p test_report_v5.py -v
```

Ils n’exécutent ni npm, ni serveur, ni charge. Leur préparation n’est pas une
preuve qu’ils ont réussi.
