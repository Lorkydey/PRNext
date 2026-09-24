const defaults = {
  deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840], imageSizes: [32, 48, 64, 96, 128, 256, 384],
  loader: 'default', loaderFile: '', domains: [], disableStaticImages: false, minimumCacheTTL: 14400,
  formats: ['image/webp'], maximumDiskCacheSize: 256 * 1024 * 1024, maximumRedirects: 3, maximumResponseBody: 50_000_000,
  dangerouslyAllowLocalIP: false, dangerouslyAllowSVG: false, contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment', remotePatterns: [], qualities: [75], unoptimized: false,
};
const keys = new Set([...Object.keys(defaults), 'localPatterns', 'path']);
function patterns(values, remote) {
  if (!Array.isArray(values) || values.length > 50) throw new Error(`images.${remote ? 'remote' : 'local'}Patterns must be an array of at most 50 patterns`);
  return values.map(value => {
    if (value instanceof URL) value = { protocol: value.protocol.slice(0, -1), hostname: value.hostname, port: value.port, pathname: value.pathname, search: value.search };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Image patterns must be objects or URL instances');
    const allowed = remote ? ['protocol', 'hostname', 'port', 'pathname', 'search'] : ['pathname', 'search'];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported image pattern field ${key}`);
    const pattern = { ...value };
    for (const key of allowed) if (pattern[key] !== undefined && (typeof pattern[key] !== 'string' || pattern[key].length > 4096 || /[\u0000-\u001f\u007f\\]/.test(pattern[key]))) throw new Error(`Invalid image pattern ${key}`);
    if (remote && (!pattern.hostname || /[\s/:?#]/.test(pattern.hostname.replace(/^\[.*\]$/, 'ipv6')))) throw new Error('Image remotePatterns require a hostname');
    if (pattern.protocol !== undefined && !['http', 'https'].includes(pattern.protocol)) throw new Error('Image remotePatterns protocol must be http or https');
    if (pattern.port !== undefined && !/^(?:\d{1,5})?$/.test(pattern.port)) throw new Error('Invalid image remotePatterns port');
    if (pattern.pathname !== undefined && (!pattern.pathname.startsWith('/') && !pattern.pathname.startsWith('*') || /[{}[\]()!]/.test(pattern.pathname))) throw new Error('Image pattern pathname must start with / and use only * or ** wildcards');
    if (pattern.hostname && /[{}[\]()!]/.test(pattern.hostname) && !/^\[[a-f\d:]+\]$/i.test(pattern.hostname)) throw new Error('Image pattern hostname supports only * or ** wildcards');
    if (pattern.search !== undefined && pattern.search !== '' && !pattern.search.startsWith('?')) throw new Error('Image pattern search must be empty or start with ?');
    return pattern;
  });
}
export function validateImagesConfig(input = {}, { basePath = '', assetPrefix = '', trailingSlash = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('images must be a configuration object');
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error(`images.${key} is not supported`);
  const config = { ...defaults, path: `${basePath}/_rustyx/image`, ...Object.fromEntries(Object.entries(input).filter(([,value]) => value !== undefined)) };
  for (const key of ['deviceSizes', 'imageSizes', 'qualities']) {
    const value = config[key], max = key === 'qualities' ? 100 : 10000;
    if (!Array.isArray(value) || (key !== 'imageSizes' && !value.length) || value.length > 50 || value.some(item => !Number.isSafeInteger(item) || item < 1 || item > max)) throw new Error(`images.${key} must contain 1 to 50 integers between 1 and ${max}`);
    config[key] = [...new Set(value)].sort((a, b) => a - b);
  }
  if (!['default', 'custom'].includes(config.loader)) throw new Error('images.loader supports default or custom; pass a loader function for another image service');
  if (typeof config.loaderFile !== 'string') throw new Error('images.loaderFile must be a project-relative path');
  if (typeof config.path !== 'string' || !config.path.startsWith('/') || config.path.startsWith('//') || /[\s\\?#]/.test(config.path)) throw new Error('images.path must be a local URL pathname');
  for (const key of ['disableStaticImages', 'dangerouslyAllowLocalIP', 'dangerouslyAllowSVG', 'unoptimized']) if (typeof config[key] !== 'boolean') throw new Error(`images.${key} must be boolean`);
  for (const [key, max] of [['minimumCacheTTL', 31536000], ['maximumDiskCacheSize', 4 * 1024 ** 3], ['maximumRedirects', 20], ['maximumResponseBody', 100 * 1024 ** 2]]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === 'maximumResponseBody' ? 1 : 0) || config[key] > max) throw new Error(`images.${key} must be an integer from ${key === 'maximumResponseBody' ? 1 : 0} to ${max}`);
  }
  if (!Array.isArray(config.formats) || !config.formats.length || config.formats.length > 2 || config.formats.some(value => !['image/avif', 'image/webp'].includes(value))) throw new Error('images.formats must contain image/avif and/or image/webp');
  if (!['attachment', 'inline'].includes(config.contentDispositionType)) throw new Error('images.contentDispositionType must be attachment or inline');
  if (typeof config.contentSecurityPolicy !== 'string' || /[\r\n]/.test(config.contentSecurityPolicy)) throw new Error('images.contentSecurityPolicy must be a single-line string');
  if (!Array.isArray(config.domains) || config.domains.length > 50 || config.domains.some(value => typeof value !== 'string' || !value || /[\s/?#]/.test(value))) throw new Error('images.domains must be an array of hostnames');
  if (trailingSlash && !config.path.endsWith('/')) config.path += '/';
  config.remotePatterns = patterns(config.remotePatterns, true);
  if (/^https?:\/\//.test(assetPrefix)) {
    const url = new URL(assetPrefix);
    if (!config.remotePatterns.some(pattern => pattern.hostname === url.hostname && pattern.protocol === url.protocol.slice(0, -1) && pattern.port === url.port && pattern.pathname === undefined && pattern.search === undefined)) config.remotePatterns.push({ protocol: url.protocol.slice(0, -1), hostname: url.hostname, port: url.port });
  }
  if (config.localPatterns !== undefined) {
    config.localPatterns = patterns(config.localPatterns, false);
    if (!/^https?:\/\//.test(assetPrefix)) {
      const prefix = (assetPrefix || basePath).replace(/\/$/, '');
      const pathname = `${prefix}/_rustyx/assets/**`;
      if (!config.localPatterns.some(pattern => pattern.pathname === pathname && pattern.search === '')) config.localPatterns.push({ pathname, search: '' });
    }
  } else config.localPatterns = [{ pathname: '**', search: '' }];
  return config;
}
