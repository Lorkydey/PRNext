# Métadonnées App Router

`metadata`, `generateMetadata`, `viewport` et `generateViewport` sont résolus dans l'ordre des layouts puis de la page. Les générateurs reçoivent des promesses pour les paramètres et un instantané du parent. Les titres, leurs templates, les liens canoniques et les URL relatives à `metadataBase` sont résolus au segment qui les déclare. Le chemin visible est utilisé pour les canonical relatifs, y compris avec une réécriture et `basePath`.

Le rendu couvre les vérifications de sites, Apple Web App, App Links, les alternates par langue/type/media, les icônes déclarées, les liens de pagination et d'archives, et les variantes article/livre/profil/musique/vidéo d'Open Graph et player/app de Twitter. Les balises suivent le HTML progressif, Flight, la navigation et les documents de récupération après erreur. Les types `Metadata`, `ResolvingMetadata`, `Viewport`, `ResolvingViewport` et `MetadataRoute` sont exportés par `rustyx`.

## Conventions de fichiers

| Fichier dans `app/` ou `src/app/` | Route |
| --- | --- |
| `robots.txt`, `robots.js`, `robots.ts`, à la racine | `/robots.txt` |
| `sitemap.xml`, `sitemap.js`, `sitemap.ts`, à tout segment | `<segment>/sitemap.xml` |
| `manifest.json`, `manifest.webmanifest`, à la racine | Le nom du fichier |
| `manifest.js`, `manifest.ts`, à la racine | `/manifest.webmanifest` |
| `favicon.ico`, à la racine | `/favicon.ico` |
| `icon`, `apple-icon`, `opengraph-image`, `twitter-image` avec extension image | Image servie au segment et balises ajoutées au head |
| Variantes JS/TS/JSX/TSX des fichiers images | Fonction renvoyant une `Response` ou `ImageResponse` |

Les variantes JS/TS exportent une fonction par défaut, éventuellement asynchrone. Les fonctions sitemap reçoivent les paramètres du segment sous `{ params }`. Les règles de robots, les langues alternatives, images et vidéos de sitemap sont sérialisées ; les valeurs XML sont échappées. Le manifeste est sérialisé en JSON et son lien est ajouté au head des pages App avec `basePath`.

Les fichiers et fonctions sans données de requête sont précompilés et servis par le cache natif Rust. `revalidate` permet leur renouvellement ; `headers()` ou `cookies()` provoquent le retour au rendu dynamique en mode automatique. Les générateurs peuvent utiliser `generateStaticParams`. GET, HEAD, OPTIONS, les règles HTTP et les conflits de routes suivent les handlers ordinaires. Une collision avec un fichier public est refusée au build.

Les images de fichiers fournissent automatiquement URL, dimensions, type et texte alternatif du fichier voisin `.alt.txt`. Les suffixes numériques permettent plusieurs images. Les balises suivent les segments ; une image de partage enfant remplace celle héritée. Les URL statiques portent une empreinte de contenu, et les routes appliquent `basePath`. `generateImageMetadata` peut produire plusieurs identifiants avec taille, type et texte alternatif ; l'identifiant du générateur d'image est une promesse. Les identifiants inconnus renvoient 404.

`ImageResponse` de `next/og` ou `rustyx/og` utilise Satori et le moteur resvg, avec les ressources WASM et la police embarquées dans le build. Le module de rendu n'est chargé que lorsqu'une image est générée ; les images précompilées sont servies par Rust. Le sous-ensemble CSS correspond à celui du moteur de génération, pas à un navigateur complet. `generateSitemaps` crée les routes `<segment>/sitemap/<id>.xml` ; les variantes sont précompilées lorsque possible.

La normalisation complète de l'objet parent Next et toutes ses valeurs par défaut ne sont pas encore reproduites. Les conventions de métadonnées à l'intérieur de branches interceptées et toutes les combinaisons de slots ne sont pas couvertes.

Références : [generateMetadata](https://nextjs.org/docs/app/api-reference/functions/generate-metadata), [robots](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots), [sitemap](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap), [manifest](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest).
