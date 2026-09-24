import Image, { getImageProps, type ImageLoader, type ImageConfig } from 'next/image';
import type { NextConfig } from '../../packages/rustyx/compat/index.js';
import photo from './photo.png';
const loader: ImageLoader = ({src, width, quality}) => `${src}?w=${width}&q=${quality}`;
const config: NextConfig = { images: { formats: ['image/avif', 'image/webp'], qualities: [50,75], remotePatterns: [new URL('https://example.test/**')], maximumDiskCacheSize: 1000 } satisfies ImageConfig };
const props = getImageProps({ src: photo, width: 400, alt: 'Photo' });
export default function Gallery() { return <><Image src={photo} alt="Photo" placeholder="blur" preload onLoad={event => { event.currentTarget.naturalWidth; }}/><Image src="/photo.png" alt="Photo" width="400" height="200" loader={loader}/><img {...props.props}/></>; }
void config;
