# Polices compilées

`next/font/local`, `next/font/google` et leurs équivalents `prnext/font/*` sont transformés au build. Les appels doivent utiliser des options littérales et être affectés à une constante au niveau du module. Les objets exposent `className`, `style` et, avec l'option correspondante, `variable`.

```tsx
import localFont from 'next/font/local';
import { Inter } from 'next/font/google';

const body = localFont({ src: './body.woff2', variable: '--font-body' });
const heading = Inter({ subsets: ['latin'], display: 'swap' });

export default function Page() {
  return <main className={body.variable}>
    <h1 className={heading.className}>PRNext</h1>
    <p style={body.style}>Police locale</p>
  </main>;
}
```

Les chemins locaux sont relatifs au module qui appelle le chargeur. Plusieurs fichiers, poids et styles sont acceptés, ainsi que les déclarations CSS locales. Les polices Google sont téléchargées pendant la compilation et servies ensuite par PRNext. Un échec de téléchargement fait échouer le build tout en conservant le dernier build valide. Le catalogue livré contient 1 942 familles, issu des données Next 16.3.5 avec sa licence conservée ; de nouvelles familles nécessitent une mise à jour du catalogue.

Les assets sont nommés par leur contenu et partagés quand leurs octets sont identiques. Les graphes serveur et navigateur reçoivent les mêmes objets et classes CSS. Les préchargements suivent les dépendances des routes et les subsets demandés ; `preload:false` les désactive. `basePath`, `assetPrefix`, l'hydratation et la navigation Pages/App sont pris en charge. Les appels identiques à un même emplacement sont compilés une fois par build.

Le navigateur et le runtime SSR ne chargent ni le compilateur de fontes ni Google Fonts. Les téléchargements ont un délai de 15 secondes et une limite de taille ; une police locale est limitée à 16 Mio, avec 64 Mio par appel local. Les métriques de repli sont calculées à partir des fichiers avec `fontkit`. Leur résultat peut différer des tables de métriques préétablies de Next. Ce comportement ne garantit donc pas un rendu typographique identique au pixel.

Les tests utilisent une vraie police TTF pour vérifier les fichiers et les métriques, et une origine Google simulée pour rendre les builds reproductibles. Chromium charge réellement les fontes, vérifie les styles et la navigation, et bloque Google pour confirmer l'absence d'accès réseau à l'exécution. La disponibilité de toutes les familles sur le service Google n'est pas vérifiée par cette suite.

Référence : [API Font de Next](https://nextjs.org/docs/app/api-reference/components/font).
