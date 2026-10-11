# Diagnostic ETW statique v5

Préparation uniquement : aucune capture v5 n’est établie par la présence de ces
scripts. Exécuter après les mesures sans instrumentation, dans une fenêtre calme
réservée par le coordinateur. Ne pas lancer pendant le screening, l’endurance ou
les cycles de repos.

```powershell
python tests/performance/windows-etw-v5.py --execute
python tests/performance/analyze-etw-v5.py
```

Le premier programme exige `artifacts/performance-v5/configs/final-static.json`,
les deux variantes référence/finale, la référence gelée v4 et le build réussi
`candidates/final/build.json`. Il crée `artifacts/performance-v5/etw/static-final`
avec refus d’écrasement. Pour conserver un nouvel essai après un échec, fournir
un autre `--output-name`, puis le même dossier à l’analyseur via `--folder`.

Chaque serveur est fixé au CPU 10 avant sa reprise, son générateur aux CPU 8/9,
et le coordinateur/exporteur au CPU 0. Le port local de diagnostic est 32960.
Chaque variante sert le même HTML gzip de `/pages-static` à 32 connexions :
10 secondes d’échauffement, puis 10 secondes sous `CPU.light`, `FileIO.light` et
`Network.light`. Le générateur, la configuration, le binaire, le build, les
fichiers publics, les outils WPT et les exports sont hachés. Les commandes et
leurs sorties restent dans le dossier ; une erreur laisse `complete:false`.

WPR/xperf doivent déjà être installés et la session doit avoir les droits ETW.
Le script ne les installe pas et ne modifie ni service ni registre. Chaque
commande WPR porte un identifiant aléatoire propre, placé en dernier argument ;
l’arrêt et l’éventuelle annulation ciblent seulement cette instance, conformément
à la [documentation Microsoft](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options).
Les ETL contiennent des métadonnées système et restent locaux.

L’analyseur vérifie les empreintes, le couple référence/final et l’identité des
octets gzip, puis filtre les événements par les PID du Job serveur. Il expose :

- le poids des échantillons CPU par processus/module et le CPU du Job par réponse ;
- les événements FileIO par fichier et par réponse, dont les tailles demandées
  aux lectures (la lecture EOF supplémentaire doit rester observable) ;
- les opérations physiques disque, séparées des lectures logiques ;
- les pertes d’événements/buffers, qui invalident l’attribution quantitative.

Les rapports CSV WPT de cette machine sont décodés en `cp1252` explicitement ;
une autre installation doit fournir son encodage via `--csv-encoding`. Aucun
symbole n’est téléchargé. Les échantillons par module ne permettent pas une
attribution par fonction Rust et les tailles de `FileIoRead` sont des tailles
demandées, pas des octets physiques lus ni transmis sur le réseau. La trace
comprend le démarrage et le drainage du générateur : les comptes par réponse
sont une normalisation du diagnostic entier, pas un appariement exact de chaque
événement à une requête. Ses débits restent instrumentés, séparés des comparaisons
finales sans trace.

Les scripts sont importables sans effet de bord. Leur validation syntaxique et
l’exécution réelle restent à effectuer lors du créneau autorisé ; ce document
ne constitue pas un résultat de profilage.
