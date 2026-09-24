# Images

`next/image`, `next/image.js` et `rustyx/image` utilisent le même composant dans Pages et App Router. Les variantes `srcSet` pointent vers un optimiseur Rust réel, servi sous `/_rustyx/image` et son alias `/_next/image`, avec le `basePath` configuré. Les transformations et les réponses en cache ne démarrent aucun worker Node.

```tsx
import Image, { getImageProps } from 'next/image';
import landscape from './landscape.jpg';

export default function Gallery() {
  return <Image src={landscape} alt="Paysage" width={640}
    placeholder="blur" sizes="(max-width: 640px) 100vw, 640px" preload />;
}
```

Les imports PNG, JPEG, WebP, AVIF, GIF, SVG, ICO, BMP et TIFF produisent un objet `{src,width,height}`. Les images raster non animées reçoivent aussi un petit `blurDataURL` WebP calculé au build. Le compilateur traite au plus deux images simultanément et partage les résultats identiques. Les SVG doivent déclarer des dimensions ou un `viewBox`. `images.disableStaticImages:true` conserve les imports sous forme d’URL pour un autre chargeur.

Le composant gère les dimensions, `fill`, `sizes`, le chargement différé natif, `priority`/`preload`, `quality`, `overrideSrc`, `loader`, `unoptimized`, `placeholder`, les attributs HTML et les callbacks `onLoad`, `onError`, `onLoadingComplete`. Le fond flouté disparaît après décodage. `getImageProps` est disponible dans les Server Components et renvoie les attributs d’une balise `img` sans ajouter de hooks client.

## Configuration

```js
export default {
  basePath: '/docs',
  images: {
    formats: ['image/avif', 'image/webp'],
    qualities: [50, 75],
    deviceSizes: [640, 960, 1280, 1920],
    imageSizes: [32, 64, 128, 256],
    remotePatterns: [{protocol:'https', hostname:'media.example.com', pathname:'/photos/**', search:''}],
    minimumCacheTTL: 14400,
    maximumDiskCacheSize: 256 * 1024 * 1024,
  },
};
```

Les images distantes doivent correspondre à `remotePatterns` ou à l’ancienne liste `domains`. Les motifs acceptent `*` et `**`, ainsi que le protocole, le port et une recherche exacte. `localPatterns` permet de restreindre les chemins locaux. Par défaut, les sources locales avec une chaîne de recherche sont refusées ; un motif explicite peut les autoriser. Les imports statiques restent automatiquement autorisés. Un `assetPrefix` HTTP(S) autorise automatiquement son hôte, comme Next, pour les images importées servies par le CDN ; l’optimiseur reste sur l’origine de l’application. Les requêtes distantes ne transmettent pas les cookies ni l’autorisation du visiteur.

Les adresses privées, locales et réservées sont refusées après résolution DNS. La connexion utilise les adresses validées, et chaque redirection est vérifiée à nouveau. `dangerouslyAllowLocalIP:true` autorise explicitement une origine d’images privée. Les redirections sont limitées à trois par défaut (`maximumRedirects`), le corps source à 50 000 000 octets (`maximumResponseBody`). Une requête dispose de 30 secondes.

Les SVG sont laissés intacts par le composant par défaut. Leur passage explicite par l’optimiseur nécessite `dangerouslyAllowSVG:true`. Les réponses utilisent `Content-Disposition: attachment` et `Content-Security-Policy: script-src 'none'; frame-src 'none'; sandbox;`, configurables avec `contentDispositionType` et `contentSecurityPolicy`.

`images.loader:'custom'` avec `loaderFile` compile un chargeur JavaScript/TypeScript du projet. Un `loader` passé au composant convient aussi à un service externe. `images.unoptimized:true` sert directement les sources. Dans ces deux configurations globales, l’endpoint de transformation natif est désactivé. Les chargeurs historiques nommés `imgix`, `cloudinary` et `akamai` doivent être exprimés par une fonction personnalisée.

## Transformations et cache

Le serveur redimensionne sans agrandir la source, conserve le rapport d’aspect et la transparence, applique l’orientation disponible du décodeur, puis négocie WebP ou AVIF selon `Accept` et l’ordre configuré. Sans format négocié, il encode en PNG avec transparence ou en JPEG. Les GIF, PNG et WebP animés sont transmis dans leur format d’origine pour préserver l’animation. Le moteur est `image`/`ravif`, `libwebp` et `avif-decode`/`rav1d` ; il ne produit pas nécessairement les mêmes octets, couleurs ou taux de compression que Sharp/libvips.

Les variantes sont conservées dans `.rustyx-cache/images`, indépendamment des remplacements du build. La durée est le maximum de `minimumCacheTTL` et du `max-age`/`s-maxage` de l’origine. Les réponses exposent `Vary: Accept`, un ETag propre aux octets et `x-nextjs-cache: HIT|MISS`. `HEAD` et `If-None-Match` sont pris en charge. Une variante expirée est recalculée avant sa réponse ; les calculs concurrents d’une même variante sont regroupés dans un processus.

Le cache SQLite est ouvert à la première image et son pager est limité à environ 2 Mio. Les fichiers sont bornés à 256 Mio par défaut et 4 096 entrées avec éviction LRU ; cette limite couvre les images référencées, hors petit index SQLite et fichiers temporaires d’écriture. `maximumDiskCacheSize:0` désactive la persistance ; une variante plus grande que le budget est également envoyée sans persistance. Les fichiers déjà ouverts restent lisibles pendant une éviction. Les corps sont émis par blocs de 64 Kio et gardent leur admission jusqu’à leur fin ou abandon.

Au plus 16 réponses sont admises simultanément et deux transformations peuvent être actives, téléchargement compris. Les dépassements renvoient 503 avec `Retry-After: 1`. Les sources sont limitées à 40 mégapixels et 32 768 pixels par dimension, avec une allocation décodée de référence de 256 Mio pour les codecs `image` ; les encodeurs et les conversions utilisent également de la mémoire temporaire. Le serveur ne conserve pas de cache de pixels en mémoire.

Le build natif nécessite Rust 1.98 ou ultérieur. Les codecs sont embarqués ; `rav1d` utilise NASM pour ses optimisations x86/x86_64. Sur ARM, son décodeur est compilé en Rust sans outil système supplémentaire. Les tests vérifient les octets et dimensions produits, AVIF entrant et sortant, la transparence, les limites, la persistance, les imports des deux routeurs, le CDN et le décodage dans Chromium.

Références : [composant Image de Next](https://nextjs.org/docs/app/api-reference/components/image), [image](https://docs.rs/image/latest/image/), [avif-decode](https://docs.rs/avif-decode/latest/avif_decode/).
