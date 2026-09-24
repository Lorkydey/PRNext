# Rustyx face à Next.js : six configurations

2026-09-23T18:50:23.457Z · Apple M4 · darwin/arm64 · Node v22.17.1 · Next 16.3.5 · React 19.3.0.

44/44 contrôles fonctionnels équivalents. 9922374 réponses validées, 448637 erreurs de charge, 0 passages incomplets. Les tests à concurrence 4 ont 0 erreurs ; le stress de capacité en compte 448637.

## Parcours mixtes : Next → Rustyx

Médianes de trois passages de 10 s, concurrence 4. Plus bas est mieux pour CPU/RAM/latence.

| Projet | req/s | CPU ms/réponse | RSS Mio | p95 ms |
|---|---:|---:|---:|---:|
| Boutique · Edge | 2 167 → 8 962 (+313,6 %) | 0,576 → 0,213 | 332,5 → 281,6 | 5,51 → 1,04 |
| Boutique · Node | 7 343 → 25 990 (+253,9 %) | 0,161 → 0,106 | 259,1 → 163,9 | 0,95 → 0,23 |
| Journal · Pages / i18n | 6 875 → 25 565 (+271,8 %) | 0,180 → 0,085 | 247,2 → 227,4 | 1,49 → 0,25 |
| Dashboard · PPR | 1 795 → 2 193 (+22,1 %) | 0,727 → 0,701 | 285,8 → 260,7 | 5,89 → 2,83 |
| Portail · SSR / asynchrone | 461 → 112 (-75,8 %) | 1,058 → 1,841 | 195,3 → 158,1 | 31,40 → 39,15 |
| Documentation · 100 pages | 9 330 → 23 905 (+156,2 %) | 0,130 → 0,083 | 226,2 → 135,0 | 0,96 → 0,24 |

## Améliorations prioritaires

### 1. Permettre plusieurs requêtes asynchrones par worker

API avec 30 ms d’attente : 121 req/s avec Next contre 31 avec Rustyx. Streaming 80 ms : 47,5 contre 11,9 req/s.

La boucle du worker attend la réponse puis la fin du streaming avant de lire la demande suivante. Le pool Rust conserve le worker et son permis pendant ce temps. Un seul appel lent bloque les suivants, même si le CPU est libre.

Multiplexer un nombre borné de requêtes et de flux par worker, avec identifiants de trames, contextes isolés, annulation et pression de retour. Mesurer le RSS avant d’augmenter ce plafond ; multiplier les processus ferait aussi monter la RAM.

Code : packages/rustyx/runtime/worker.mjs:48 ; crates/rustyx/src/pool.rs:492.

### 2. Améliorer la capacité sans faire disparaître les limites mémoire

À concurrence 128, les essais enregistrent 448 637 réponses en erreur au total. Le tableau de capacité précise le moteur et le taux pour chaque projet.

Rustyx autorise quatre demandes actives et 64 attentes par worker, puis refuse avec HTTP 503. Cette borne protège la mémoire, mais limite les pointes de trafic dynamique. Des ECONNRESET sont aussi observés sur les stress les plus sévères ; leur cause exacte reste à isoler.

Traiter d’abord le blocage asynchrone, puis calibrer admission, équité et temporisation sous charge. Conserver une file bornée ; tester aussi des arrivées à débit imposé et des clients respectant Retry-After. Les journaux montrent une ligne par 503 : agréger ces messages réduirait aussi le travail sous saturation, à mesurer séparément.

Code : crates/rustyx/src/server/admission.rs:20.

### 3. Continuer à réduire le coût du PPR et de Flight

PPR HTML : 1,742 ms CPU/réponse chez Next, 1,798 chez Rustyx. Flight : 1,019 contre 1,373 ms CPU/réponse. Le passage de 60 s montre encore un autre équilibre.

Le rendu personnalisé traverse encore les couches React / Flight et le transport entre Rust et JavaScript. La réduction du nombre d’échanges de cache ne supprime pas ces passages.

Profiler les allocations et encodages du rendu vivant, puis supprimer les copies et conversions mesurées comme dominantes. Le profil de fonctions reste à mesurer ; les compteurs de cette campagne ne suffisent pas à attribuer un pourcentage CPU à une fonction.

Code : packages/rustyx/runtime/app-render.mjs ; packages/rustyx/runtime/rsc-worker.mjs.

### 4. Servir directement les routes réellement statiques du dashboard

/projet/atlas : 0,155 ms CPU/réponse chez Next contre 0,225 chez Rustyx, et 8 156 contre 5 989 req/s.

La page possède un artefact pré-rendu, mais son entrée de manifeste Rustyx est marquée pprFallback et ne porte pas le drapeau ssg. Le serveur n’emprunte donc pas son chemin natif de page SSG et fait intervenir le worker JavaScript.

Reconnaître les chemins concrets entièrement statiques au sein des routes PPR, tout en conservant invalidations, route canonique et navigation interceptée. Ce cas constitue une cible précise de CPU et de RAM.

Code : reports/next-audit/projects/dashboard/rustyx/.rustyx/manifest.json ; crates/rustyx/src/server.rs:1184.

### 5. Réduire la mémoire du proxy associé au SSR

Proxy + SSR : 264,3 Mio chez Next, 337,9 Mio chez Rustyx, malgré un débit Rustyx de 2 707 contre 1 116 req/s.

Le budget mémoire des parcours combinant proxy et rendu mérite un traitement distinct des API seules. Les processus sont détaillés dans les données brutes.

Profiler les modules et contextes retenus dans le middleware et le rendu ; réduire les chargements et duplications inutiles sans partager les données des visiteurs.

Code : crates/rustyx/src/middleware.rs ; packages/rustyx/runtime/middleware.mjs.

### 6. Optimiser le transfert des réponses volumineuses

Avec gzip demandé : 138,5 Kio sur le réseau chez Next contre 6,6 Kio chez Rustyx. Sans compression : 0,558 contre 0,531 ms CPU/réponse.

Dans cet essai, Next retourne du JSON non compressé malgré Accept-Encoding: gzip ; Rustyx le compresse réellement. Le supplément CPU de la variante gzip finance donc aussi une économie réseau et ne s’interprète pas comme un défaut de vitesse pur.

Utiliser la variante identity pour isoler le coût de transport, puis profiler les trames et la compression. Comparer les niveaux de gzip en tenant compte du CPU, des octets et du temps sur un réseau limité.

Code : packages/rustyx/runtime/transport.mjs ; crates/rustyx/src/server.rs:293.

### 7. Étendre les gains aux gros projets et à la recompilation

Les builds froids, inchangés et avec une page modifiée figurent séparément ci-dessous. Le projet documentation contient 100 pages générées.

Sur les petits projets, la reconstruction Rustyx sans changement reste proche du build froid. Un build déjà rapide peut encore éviter des étapes inutiles.

Mesurer les étapes une à une et conserver uniquement les résultats dont les dépendances sont inchangées. Étendre les fixtures aux imports npm lourds, grands graphes, milliers de pages et changements de configuration.

Code : packages/rustyx/build/.

## Limites

Applications contrôlées, sources identiques, un worker Rustyx, serveurs successifs, client sur la même machine. Le CPU couvre le serveur et ses descendants, pas le navigateur ni la compilation. RSS additionné, échantillonné, pages partagées potentiellement comptées plusieurs fois. Les essais courts sont répétés trois fois ; builds, démarrage, capacité et charge de 60 s une seule fois. Aucun intervalle de confiance. Les hauts débits peuvent être limités par le générateur. Les réponses refusées déséquilibrent le mélange de succès : ne pas comparer leurs débits comme du travail équivalent. Ni preuve de compatibilité universelle, ni benchmark réseau distant ou base de données réelle.

Correction du banc : La copie native de Sharp 0.35.4 dans la référence Next était tronquée : Next renvoyait silencieusement le PNG original. La dépendance a été remplacée par le même Sharp 0.35.4 fonctionnel déjà installé dans le dépôt. Les parcours navigateur des deux boutiques et les mesures images des deux moteurs ont été rejoués avec validation stricte WebP. Les autres charges ne sollicitent pas Sharp. Voir [initial-observations.json](initial-observations.json).

Correction du banc : La première sonde Flight omettait le paramètre _rsc exigé par la référence Next, qui répondait 307. Les trois passages Flight de chaque moteur ont été rejoués avec le même endpoint /?_rsc= et le même cookie personnalisé. Les anciennes observations sont archivées. Voir [initial-observations.json](initial-observations.json).

[Rapport interactif complet](performance.html) · [Mesures CSV](measurements.csv) · [Synthèse CSV](summary.csv) · [Données JSON](results.json).
