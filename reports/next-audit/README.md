# Audit Next.js → Rustyx

[Ouvrir le rapport interactif](performance.html) · [Tableaux Markdown](performance.md) · [Vérifications](validation.json).

Six configurations, 12 copies sources conservées, 44 contrôles fonctionnels équivalents, 250 passages comparatifs et deux diagnostics Rustyx à quatre workers. Les réponses invalides des essais de saturation restent dans les résultats.

## Projets

- [boutique : copies Next et Rustyx et commandes](projects/boutique/README.md)
- [boutique-node : copies Next et Rustyx et commandes](projects/boutique-node/README.md)
- [journal : copies Next et Rustyx et commandes](projects/journal/README.md)
- [dashboard : copies Next et Rustyx et commandes](projects/dashboard/README.md)
- [portail : copies Next et Rustyx et commandes](projects/portail/README.md)
- [documentation : copies Next et Rustyx et commandes](projects/documentation/README.md)

Les dossiers .next et .rustyx sont présents localement mais ignorés par Git. Les node_modules sont des liens vers les dépendances locales ; un déplacement sur une autre machine nécessite leur réinstallation.

## Données

- results.json : versions, empreintes, projets, mesures serveur et diagnostics navigateur.
- measurements.csv : 250 passages comparatifs et deux diagnostics, séparateur point-virgule, décimales françaises.
- summary.csv : médianes par route/moteur, uniquement passages sans erreur.
- initial-observations.json : archive avant réparation de Sharp et correction de la sonde Flight ; ne pas la mélanger aux mesures finales.
- validation.json : contrôle de la matrice, des empreintes, builds, contenus, liens et affichage.

[Protocole et commandes pour un nouvel audit](../../examples/next-migration/README.md). Les serveurs sont arrêtés à la fin des tests.
