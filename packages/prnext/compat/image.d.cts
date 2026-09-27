/// <reference path="./image-imports.d.ts" />
import type { ImgHTMLAttributes, ForwardRefExoticComponent, RefAttributes } from 'react';
export interface ImageLoaderProps { src: string; width: number; quality?: number }
export type ImageLoader = (props: ImageLoaderProps) => string;
export interface RemotePattern { protocol?: 'http' | 'https'; hostname: string; port?: string; pathname?: string; search?: string }
export interface LocalPattern { pathname?: string; search?: string }
export interface ImageConfig {
  deviceSizes?: number[]; imageSizes?: number[]; qualities?: number[];
  loader?: 'default' | 'custom'; loaderFile?: string; path?: string;
  domains?: string[]; remotePatterns?: Array<RemotePattern | URL>; localPatterns?: LocalPattern[];
  formats?: Array<'image/avif' | 'image/webp'>; unoptimized?: boolean; disableStaticImages?: boolean;
  minimumCacheTTL?: number; maximumDiskCacheSize?: number; maximumRedirects?: number; maximumResponseBody?: number;
  dangerouslyAllowLocalIP?: boolean; dangerouslyAllowSVG?: boolean;
  contentSecurityPolicy?: string; contentDispositionType?: 'attachment' | 'inline';
}
export interface StaticImageData { src: string; width: number; height: number; blurDataURL?: string; blurWidth?: number; blurHeight?: number }
export interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'width' | 'height'> {
  src: string | StaticImageData | { default: StaticImageData };
  alt: string;
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  priority?: boolean;
  preload?: boolean;
  quality?: number | `${number}`;
  overrideSrc?: string;
  loader?: ImageLoader;
  unoptimized?: boolean;
  placeholder?: 'empty' | 'blur' | string;
  blurDataURL?: string;
  onLoadingComplete?: (image: HTMLImageElement) => void;
}
declare const Image: ForwardRefExoticComponent<ImageProps & RefAttributes<HTMLImageElement>>;
export function getImageProps(props: ImageProps): { props: ImgHTMLAttributes<HTMLImageElement> };
export default Image;
