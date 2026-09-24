'use strict';
const config = require('./image-config.cjs');
const allSizes = [...new Set([...config.deviceSizes, ...config.imageSizes])].sort((a,b) => a-b);
function widths(width, sizes) {
  if (sizes) {
    const percent = [...sizes.matchAll(/(^|\s)(1?\d?\d)vw/g)].map(match => Number(match[2]));
    return { values: percent.length ? allSizes.filter(size => size >= config.deviceSizes[0] * Math.min(...percent) / 100) : allSizes, kind: 'w' };
  }
  if (!width) return { values: config.deviceSizes, kind: 'w' };
  return { values: [...new Set([width, width * 2].map(size => allSizes.find(value => value >= size) || allSizes.at(-1)))], kind: 'x' };
}
function defaultLoader({ src, width, quality }) {
  if (config.loader === 'custom') throw new Error(`Image with src "${src}" requires a loader prop or images.loaderFile`);
  const qualities = config.qualities || [75];
  quality = qualities.reduce((best, value) => Math.abs(value - (quality || 75)) < Math.abs(best - (quality || 75)) ? value : best);
  return `${config.path}?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
}
function integer(value) { return typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined; }
function imageProps(input) {
  const { src, alt, width, height, fill = false, priority, preload, quality, loader: inputLoader, unoptimized: rawUnoptimized, placeholder = 'empty', blurDataURL: inputBlur,
    blurWidth: _blurWidth, blurHeight: _blurHeight, onLoadingComplete, onLoad, onError, style, sizes: inputSizes, overrideSrc, layout, objectFit, objectPosition, lazyBoundary: _lazyBoundary, lazyRoot: _lazyRoot, ...rest } = input;
  const source = typeof src === 'object' && src !== null ? src.default || src : { src };
  if (!source || typeof source.src !== 'string') throw new Error('Image src must be a URL string or a static image import');
  let w = integer(width), h = integer(height);
  const isFill = fill || layout === 'fill';
  if (!isFill && source.width && source.height) {
    if (!w && !h) { w = source.width; h = source.height; }
    else if (w && !h) h = Math.round(source.height * w / source.width);
    else if (h && !w) w = Math.round(source.width * h / source.height);
  }
  if (!isFill && (!w || !h || w < 0 || h < 0)) throw new Error(`Image with src "${source.src}" requires positive width and height, or fill`);
  const unoptimized = rawUnoptimized || config.unoptimized || /^(?:data:|blob:)/.test(source.src) || (!config.dangerouslyAllowSVG && source.src.split('?')[0].endsWith('.svg'));
  const sizes = inputSizes || (isFill || layout === 'responsive' ? '100vw' : undefined);
  const loader = inputLoader || config.customLoader || defaultLoader;
  const qualityNumber = integer(quality);
  const candidates = widths(w, sizes);
  const attributes = unoptimized ? { src: source.src } : {
    sizes: sizes || (candidates.kind === 'w' ? '100vw' : undefined),
    srcSet: candidates.values.map((value, index) => `${loader({ src: source.src, width: value, quality: qualityNumber })} ${candidates.kind === 'w' ? value : index + 1}${candidates.kind}`).join(', '),
    src: loader({ src: source.src, width: candidates.values.at(-1), quality: qualityNumber }),
  };
  const blurDataURL = inputBlur || source.blurDataURL;
  if (placeholder === 'blur' && !blurDataURL) throw new Error(`Image with src "${source.src}" uses placeholder="blur" without blurDataURL`);
  const baseStyle = isFill ? { position: 'absolute', height: '100%', width: '100%', left: 0, top: 0, right: 0, bottom: 0, objectFit, objectPosition } : { objectFit, objectPosition };
  if (layout === 'responsive') Object.assign(baseStyle, { width: '100%', height: 'auto' });
  if (layout === 'intrinsic') Object.assign(baseStyle, { maxWidth: '100%', height: 'auto' });
  return { props: { ...rest, alt, width: isFill ? undefined : w, height: isFill ? undefined : h,
    loading: rest.loading || (priority || preload || /^(?:data:|blob:)/.test(source.src) ? undefined : 'lazy'), decoding: rest.decoding || 'async',
    'data-nimg': isFill ? 'fill' : '1', style: { color: 'transparent', ...baseStyle, ...style }, ...attributes, src: overrideSrc || attributes.src },
    placeholder, blurDataURL, priority: priority || preload, onLoad, onError, onLoadingComplete };
}
function getImageProps(input) {
  const result = imageProps(input);
  if (result.placeholder !== 'empty') Object.assign(result.props.style, placeholderStyle(result));
  return { props: Object.fromEntries(Object.entries(result.props).filter(([, value]) => value !== undefined)) };
}
function placeholderStyle(result) {
  if (result.placeholder === "empty") return {};
  const url = result.placeholder === 'blur' ? result.blurDataURL : result.placeholder;
  return url ? { backgroundSize: result.props.style.objectFit === 'contain' ? 'contain' : 'cover', backgroundPosition: result.props.style.objectPosition || '50% 50%', backgroundRepeat: 'no-repeat', backgroundImage: `url("${url.replaceAll('"', '%22')}")` } : {};
}
module.exports={imageProps,getImageProps,placeholderStyle};
