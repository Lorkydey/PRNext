const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function serializeMetadataRoute(kind, data) {
  if (kind === 'manifest') return JSON.stringify(data);
  if (kind === 'robots') {
    if (!data || !data.rules) throw new TypeError('robots() must return an object with rules.');
    let text = '';
    for (const rule of list(data.rules)) {
      for (const agent of list(rule.userAgent || '*')) text += `User-Agent: ${agent}\n`;
      for (const [field, label] of [['allow', 'Allow'], ['disallow', 'Disallow']]) for (const item of list(rule[field])) text += `${label}: ${item}\n`;
      if (rule.crawlDelay) text += `Crawl-delay: ${rule.crawlDelay}\n`;
      for (const [key, values] of Object.entries(rule.other || {})) for (const value of list(values)) text += `${key}: ${value}\n`;
      text += '\n';
    }
    if (data.host) text += `Host: ${data.host}\n`;
    for (const url of list(data.sitemap)) text += `Sitemap: ${url}\n`;
    return text;
  }
  if (kind !== 'sitemap' || !Array.isArray(data)) throw new TypeError('sitemap() must return an array.');
  const namespaces = { image: 'http://www.google.com/schemas/sitemap-image/1.1', video: 'http://www.google.com/schemas/sitemap-video/1.1', xhtml: 'http://www.w3.org/1999/xhtml' };
  const used = { image: data.some(item => item.images?.length), video: data.some(item => item.videos?.length), xhtml: data.some(item => Object.keys(item.alternates || {}).length) };
  let text = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  for (const [key, uri] of Object.entries(namespaces)) if (used[key]) text += ` xmlns:${key}="${uri}"`;
  text += '>\n';
  const tag = (name, value, attributes = '') => value == null ? '' : `<${name}${attributes}>${xml(value instanceof Date ? value.toISOString() : value)}</${name}>\n`;
  for (const item of data) {
    text += '<url>\n' + tag('loc', item.url);
    for (const [language, url] of Object.entries(item.alternates?.languages || {})) text += `<xhtml:link rel="alternate" hreflang="${xml(language)}" href="${xml(url)}" />\n`;
    for (const image of item.images || []) text += '<image:image>\n' + tag('image:loc', image) + '</image:image>\n';
    for (const video of item.videos || []) {
      text += '<video:video>\n';
      for (const field of ['title', 'thumbnail_loc', 'description', 'content_loc', 'player_loc', 'duration', 'view_count', 'tag', 'rating', 'expiration_date', 'publication_date', 'family_friendly', 'requires_subscription', 'live']) text += tag('video:' + field, video[field]);
      for (const field of ['restriction', 'platform', 'uploader']) if (video[field]) {
        const attribute = field === 'uploader' ? 'info' : 'relationship';
        text += tag('video:' + field, video[field].content, video[field][attribute] ? ` ${attribute}="${xml(video[field][attribute])}"` : '');
      }
      text += '</video:video>\n';
    }
    text += tag('lastmod', item.lastModified) + tag('changefreq', item.changeFrequency) + tag('priority', item.priority) + '</url>\n';
  }
  return text + '</urlset>\n';
}
export function validateMetadataVariants(rows, name) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new TypeError(`${name} must return an array with at most 10000 items`);
  const seen = new Set();
  for (const item of rows) {
    if (!item || !['string', 'number'].includes(typeof item.id) || !String(item.id) || /[/\\\x00-\x1f]/.test(String(item.id)) || ['.', '..'].includes(String(item.id))) throw new TypeError(`${name} requires a valid id for every item`);
    const id = String(item.id);
    if (seen.has(id)) throw new TypeError(`${name} returned duplicate id ${id}`);
    seen.add(id);
  }
  return rows;
}
export function metadataHandler(source, { kind, image, multiple, contentType }) {
  if (typeof source.default !== 'function') throw new TypeError(`${kind} metadata file must export a default function`);
  if (['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].some(name => name in source)) throw new Error('Metadata files must export a default metadata function, not HTTP methods');
  return async (_request, context) => {
    const { __metadata_id__: rawId, ...params } = await context.params;
    const id = kind === 'sitemap' ? typeof rawId === 'string' && rawId.endsWith('.xml') ? rawId.slice(0, -4) : undefined : rawId;
    if (multiple) {
      const name = image ? 'generateImageMetadata' : 'generateSitemaps';
      const rows = validateMetadataVariants(await source[name]({ params }), name);
      if (!rows.some(item => String(item.id) === id)) return new Response('Not Found', { status: 404 });
    }
    const result = await source.default({ params: Promise.resolve(params), ...(multiple ? { id: Promise.resolve(id) } : {}) });
    if (image) {
      if (!(result instanceof Response)) throw new TypeError(`${kind} must return a Response or ImageResponse`);
      return result;
    }
    return new Response(serializeMetadataRoute(kind, result), { headers: { 'content-type': contentType } });
  };
}
export async function metadataStaticParams(source, { kind, image }, { params = {} } = {}) {
  const parents = source.generateStaticParams ? await source.generateStaticParams({ params }) : [params];
  const result = [];
  const name = image ? 'generateImageMetadata' : 'generateSitemaps';
  for (const parent of parents) for (const item of validateMetadataVariants(await source[name]({ params: parent }), name)) {
    result.push({ ...parent, __metadata_id__: String(item.id) + (kind === 'sitemap' ? '.xml' : '') });
    if (result.length > 10000) throw new Error('Metadata path generation exceeds 10000 paths');
  }
  return result;
}
