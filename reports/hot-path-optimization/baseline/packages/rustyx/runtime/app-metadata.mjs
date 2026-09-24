import React from 'react';
import { posix } from 'node:path';
import { paramsBySegment } from './app-segments.mjs';
import { validateMetadataVariants } from './metadata-route.mjs';
import { currentRequest, runRequestContext } from '../compat/headers.cjs';
import { staticParams, dynamicUsage } from '../compat/static-generation.cjs';

const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const object = value => value && typeof value === 'object' ? value : {};
const descriptor = value => typeof value === 'object' && !(value instanceof URL) ? value : { url: value };
const titleValue = value => typeof value === 'string' ? value : value?.absolute;
const socialArrays = ['emails', 'phoneNumbers', 'faxNumbers', 'alternateLocale', 'audio', 'videos', 'authors', 'tags', 'albums', 'songs', 'musicians', 'creators', 'actors', 'directors', 'writers'];
const robotKeys = ['noarchive', 'nosnippet', 'noimageindex', 'nocache', 'notranslate', 'indexifembedded', 'nositelinkssearchbox', 'unavailable_after', 'max-video-preview', 'max-image-preview', 'max-snippet'];

function strings(value) {
  if (value instanceof URL) return value.href;
  if (Array.isArray(value)) return value.map(strings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strings(item)]));
  return value;
}

function resolveTitle(value, template) {
  const own = object(value);
  const text = typeof value === 'string' ? value : own.default;
  return { absolute: own.absolute || (text ? template ? template.replace(/%s/g, text) : text : ''), template: own.template || null };
}

function metadataBase(value) {
  if (value == null) return null;
  try { return new URL(value).href; }
  catch { throw new TypeError(`metadataBase is not a valid URL: ${value}`); }
}

// Next composes paths under metadataBase, including leading slashes. Resolve
// at the exporting segment so a child's different base cannot alter its parent.
function resolveUrl(value, base) {
  if (value instanceof URL) return value.href;
  try { return new URL(value).href; } catch {}
  const origin = new URL(base || `http://localhost:${process.env.PORT || 3000}`);
  return new URL(posix.join(origin.pathname, value), origin).href;
}

function resolvePageUrl(value, base, pathname, trailingSlash, alternate = false) {
  if ((alternate && value instanceof URL) || (typeof value === 'string' && value.startsWith('./'))) {
    let request;
    try { request = currentRequest(); } catch { /* Direct metadata resolution. */ }
    if (request?.staticState && request.partialParams?.length) dynamicUsage('params for a path not supplied by generateStaticParams', request);
  }
  if (alternate && value instanceof URL) {
    const absolute = new URL(pathname, value);
    value.searchParams.forEach((item, key) => absolute.searchParams.set(key, item));
    value = absolute;
  }
  if (typeof value === 'string' && value.startsWith('./')) value = posix.resolve(pathname, value);
  let result = base ? resolveUrl(value, base) : value;
  if (result instanceof URL || (base && typeof result === 'string')) {
    const url = new URL(result);
    result = url.pathname === '/' && !url.search ? url.origin : url.href;
  }
  if (trailingSlash && typeof result === 'string' && !result.endsWith('/') && !result.includes('?')) {
    try {
      const url = new URL(result);
      if ((!base || url.origin === new URL(base).origin) && !/^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))(\/?|$)/i.test(url.pathname)) result += '/';
    } catch {}
  }
  return result;
}

function imageBase(base) {
  if (base) return base;
  const preview = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  if (process.env.NODE_ENV === 'production' && process.env.VERCEL_ENV === 'preview' && preview) return `https://${preview}`;
  if (process.env.NODE_ENV !== 'development' && process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

function resolveSocial(value, base, pathname, trailingSlash, template, twitter = false) {
  if (!value) return null;
  const resolved = { ...strings(value), title: resolveTitle(value.title, template) };
  if (value.images != null) resolved.images = list(value.images).filter(item => item && descriptor(item).url).map(item => {
    const image = descriptor(item);
    return { ...strings(image), url: resolveUrl(image.url, imageBase(base)) };
  });
  if (twitter) {
    resolved.card = value.card || (resolved.images?.length ? 'summary_large_image' : 'summary');
    if (resolved.card === 'player') resolved.players = list(resolved.players);
    if (resolved.card === 'app') resolved.app ||= {};
  } else {
    resolved.url = value.url ? resolvePageUrl(value.url, base, pathname, trailingSlash) : null;
    for (const field of socialArrays) if (field in value) resolved[field] = value[field] == null ? null : list(strings(value[field]));
  }
  return resolved;
}

function normalize(own, previous, pathname, trailingSlash, templates) {
  if (!Object.keys(own).length) return own;
  const base = metadataBase(own.metadataBase !== undefined ? own.metadataBase : previous.metadataBase);
  const resolved = strings(own);
  if (Object.hasOwn(own, 'metadataBase')) resolved.metadataBase = base;
  if (own.other) resolved.other = { ...previous.other, ...strings(own.other) };
  else if (Object.hasOwn(own, 'other')) resolved.other = previous.other;
  const pageUrl = value => resolvePageUrl(value, base, pathname, trailingSlash, true);
  if (own.alternates) {
    resolved.alternates = { canonical: own.alternates.canonical ? { url: pageUrl(descriptor(own.alternates.canonical).url) } : null };
    for (const field of ['languages', 'media', 'types']) {
      resolved.alternates[field] = own.alternates[field] ? Object.fromEntries(Object.entries(own.alternates[field]).map(([key, values]) => [key,
        list(values).filter(Boolean).map(value => { const item = descriptor(value); return { url: pageUrl(item.url), title: item.title }; }),
      ])) : null;
    }
  }
  if (Object.hasOwn(own, 'openGraph')) resolved.openGraph = resolveSocial(own.openGraph, base, pathname, trailingSlash, templates.openGraph);
  if (Object.hasOwn(own, 'twitter')) resolved.twitter = resolveSocial(own.twitter, base, pathname, trailingSlash, templates.twitter, true);
  for (const field of ['authors', 'keywords', 'archives', 'assets', 'bookmarks']) if (own[field] != null) resolved[field] = list(strings(own[field]));
  if (own.verification) {
    resolved.verification = {};
    for (const field of ['google', 'yahoo', 'yandex', 'me']) if (own.verification[field]) resolved.verification[field] = list(strings(own.verification[field]));
    if (own.verification.other) resolved.verification.other = Object.fromEntries(Object.entries(own.verification.other).map(([key, value]) => [key, list(strings(value))]));
  }
  if (own.appleWebApp) resolved.appleWebApp = own.appleWebApp === true ? { capable: true } : {
    capable: 'capable' in own.appleWebApp ? !!own.appleWebApp.capable : true,
    title: own.appleWebApp.title || null,
    startupImage: own.appleWebApp.startupImage ? list(own.appleWebApp.startupImage).map(item => strings(descriptor(item))) : null,
    statusBarStyle: own.appleWebApp.statusBarStyle || 'default',
  };
  if (own.appLinks) resolved.appLinks = Object.fromEntries(Object.entries(own.appLinks).map(([key, value]) => [key, list(strings(value))]));
  if (own.facebook) resolved.facebook = { ...own.facebook, admins: own.facebook.admins == null ? undefined : list(own.facebook.admins) };
  if (own.itunes) resolved.itunes = { ...own.itunes, appArgument: own.itunes.appArgument ? pageUrl(own.itunes.appArgument) : undefined };
  if (own.pagination) resolved.pagination = Object.fromEntries(['previous', 'next'].map(key => [key, own.pagination[key] ? pageUrl(own.pagination[key]) : null]));
  if (own.robots) resolved.robots = { basic: robotContent(own.robots), googleBot: robotContent(object(own.robots).googleBot) };
  if (own.icons) {
    const icons = typeof own.icons === 'string' || own.icons instanceof URL || Array.isArray(own.icons) ? { icon: own.icons } : own.icons;
    resolved.icons = Object.fromEntries(Object.entries(icons).map(([key, value]) => [key, list(value).filter(Boolean).map(item => strings(descriptor(item)))]));
  }
  return resolved;
}

async function exported(module, field, generator, props, parent) {
  if (!module) return {};
  if (module[field] !== undefined && module[generator] !== undefined) throw new Error(`A route cannot export both ${field} and ${generator}`);
  // Generators receive their own snapshot: mutations cannot alter a shared export
  // or the metadata inherited by the page/request that follows them.
  const value = module[generator] === undefined ? module[field] : await module[generator](props, Promise.resolve(structuredClone(parent)));
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`${field} must be an object`);
  return value || {};
}

function routePath(segments, params) {
  const parts = [];
  for (const { segment } of segments) {
    if (!segment || segment.startsWith('(') || segment.startsWith('@')) continue;
    const dynamic = /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(segment);
    if (dynamic) parts.push(...list(params[dynamic[1]]).map(value => encodeURIComponent(value)));
    else parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

async function resolveMetadataFiles(files, params) {
  const result = {};
  for (const file of files) {
    const scoped = {};
    for (const match of file.path.matchAll(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g)) if (params[match[1]] !== undefined) scoped[match[1]] = params[match[1]];
    const variants = file.multiple ? validateMetadataVariants(await file.module.generateImageMetadata({ params: scoped }), 'generateImageMetadata') : [file.info || { ...file.module, ...file.module?.size, type: file.module?.contentType }];
    for (const item of variants) {
      let url = file.pattern.replace(/\[__metadata_id__\]/g, encodeURIComponent(String(item.id)));
      url = url.replace(/\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g, (_match, optional, catchall, single) => list(params[optional || catchall || single]).map(encodeURIComponent).join('/'));
      if (item.hash && file.kind !== 'favicon') url += '?' + item.hash;
      const width = item.width ?? item.size?.width;
      const height = item.height ?? item.size?.height;
      const descriptor = { url, ...(item.type || item.contentType ? { type: item.type || item.contentType } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}), ...(item.alt ? { alt: item.alt } : {}) };
      if (['favicon', 'icon', 'apple-icon'].includes(file.kind)) {
        const kind = file.kind === 'apple-icon' ? 'apple' : 'icon';
        result.icons ||= {};
        (result.icons[kind] ||= []).push({ url, type: descriptor.type, ...(item.sizes || width && height ? { sizes: item.sizes || `${width}x${height}` } : {}) });
      } else (result[file.kind === 'opengraph-image' ? 'openGraph' : 'twitter'] ||= []).push(descriptor);
    }
  }
  return result;
}

/** Resolve in segment order, with shallow inheritance like Next's Metadata API. */
export async function resolveMetadata(entry, { params, searchParams, pathname, trailingSlash = false }, notFoundIndex = -1) {
  let metadata = {};
  let viewport = { width: 'device-width', initialScale: 1 };
  let title = null;
  let templates = { title: null, openGraph: null, twitter: null };
  let leafTemplates = templates;
  const segments = notFoundIndex < 0 ? entry.segments || [] : (entry.segments || []).slice(0, notFoundIndex + 1);
  let request;
  try { request = currentRequest(); } catch { /* Metadata can also be resolved directly. */ }
  // Resolve a generator before awaiting its params: a generator which doesn't
  // read them may still expose uncached metadata that build validation must see.
  const values = request?.staticState && request.partialParams?.length ? request.params : await params;
  const scopedParams = paramsBySegment(segments, values);
  pathname ||= routePath(entry.segments || [], values || {});
  async function apply(module, props, activeTemplates, updateTemplate, filePath, fileValues = values) {
    const parent = { ...metadata, title };
    let own = await exported(module, 'metadata', 'generateMetadata', props, parent);
    if (filePath !== undefined) {
      const selected = (entry.metadataFiles || []).filter(item => item.path === filePath);
      let resolved = {};
      if (selected.length) {
        resolved = await fileValues || {};
        const required = Object.fromEntries(Object.entries(resolved).filter(([name]) => selected.some(item =>
          [...item.path.matchAll(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g)].some(match => match[1] === name))));
        await staticParams(required, request);
      }
      const files = await resolveMetadataFiles(selected, resolved);
      own = { ...own };
      for (const field of ['openGraph', 'twitter']) if (files[field] && !Object.hasOwn(own[field] || {}, 'images')) own[field] = { ...(own[field] || metadata[field]), images: files[field] };
      if (files.icons) own.icons = { ...metadata.icons, ...own.icons, ...files.icons };
    }
    metadata = { ...metadata, ...normalize(own, metadata, pathname, trailingSlash, activeTemplates) };
    if (Object.hasOwn(own, 'title')) title = resolveTitle(own.title, activeTemplates.title);
    if (updateTemplate) templates = {
      title: title?.template || null,
      openGraph: metadata.openGraph?.title?.template || null,
      twitter: metadata.twitter?.title?.template || null,
    };
    const ownViewport = await exported(module, 'viewport', 'generateViewport', props, viewport);
    viewport = { ...viewport, ...ownViewport };
  }
  if (entry.metadataItems && notFoundIndex < 0) {
    // App metadata is accumulated in loader-tree order, including parallel
    // branches. Each generator sees metadata resolved by preceding branches.
    for (const [index, item] of entry.metadataItems.entries()) {
      const resolve = async () => apply(item.module, { params: item.params, ...(item.searchParams ? { searchParams: item.searchParams } : {}) },
        templates, index < entry.metadataItems.length - 2, item.filePath, item.params);
      if (item.context) await runRequestContext({ ...currentRequest(), ...item.context, privateCache: undefined, privateCacheBytes: 0, draftProvider: undefined }, resolve);
      else await resolve();
    }
  } else {
    for (const [index, segment] of segments.entries()) {
      leafTemplates = templates;
      await apply(segment.layout, { params: staticParams(scopedParams.get(segment), request) }, templates, true, index < segments.length - 1 || notFoundIndex >= 0 ? segment.path : undefined);
    }
    // A layout's template applies below its segment, never to its sibling page.
    if (notFoundIndex < 0) await apply(entry.page, { params, searchParams }, leafTemplates, false, segments.at(-1)?.path);
    else metadata.robots = { basic: 'noindex' };
  }
  const favicon = (entry.metadataFiles || []).find(file => file.kind === 'favicon');
  if (favicon) {
    const fileIcons = (await resolveMetadataFiles([favicon], values || {})).icons.icon;
    metadata.icons = { ...metadata.icons, icon: [...fileIcons, ...list(metadata.icons?.icon).filter(item => descriptor(item).url !== fileIcons[0].url)] };
  }
  const og = metadata.openGraph;
  if (og) {
    const twitter = metadata.twitter;
    const fallback = resolveSocial({ title: titleValue(og.title) ? og.title : title, description: og.description || metadata.description, images: og.images }, metadata.metadataBase, pathname, trailingSlash, templates.twitter, true);
    metadata.twitter = twitter ? { ...twitter,
      ...!titleValue(twitter.title) && { title: fallback.title },
      ...!twitter.description && { description: fallback.description },
      ...!twitter.images && { images: fallback.images },
    } : fallback;
  }
  for (const social of [metadata.openGraph, metadata.twitter]) if (social) {
    if (!titleValue(social.title) && titleValue(title)) social.title = title;
    if (!social.description && metadata.description) social.description = metadata.description;
  }
  return { ...metadata, ...entry.staticMetadata, title: title?.absolute || null, viewport };
}

function robotContent(value) {
  if (typeof value === 'string') return value;
  const parts = [];
  for (const name of ['index', 'follow']) if (typeof value?.[name] === 'boolean') parts.push(value[name] ? name : `no${name}`);
  for (const name of robotKeys) {
    const option = value?.[name];
    if (option !== undefined && option !== false) parts.push(typeof option === 'boolean' ? name : `${name}:${option}`);
  }
  return parts.join(', ');
}

export function metadataElements(metadata) {
  const elements = [];
  let count = 0;
  const tag = (name, props, text) => elements.push(React.createElement(name, { ...props, key: `metadata-${count++}` }, text));
  const meta = (name, content, attributes = {}) => {
    if (content !== undefined && content !== null && content !== '') tag('meta', { name, content: String(content), ...attributes });
  };
  const property = (name, content) => {
    for (const value of list(content)) if (value != null && value !== '') tag('meta', { property: name, content: String(value) });
  };
  const properties = (prefix, value, fields) => {
    for (const [field, label] of Object.entries(fields)) property(`${prefix}:${label}`, value?.[field]);
  };
  // The base property of a descriptor omits the trailing colon.
  const media = (emit, prefix, values, fields) => {
    for (const value of list(values)) if (value) {
      const item = descriptor(value);
      if (item.url) emit(prefix, item.url);
      for (const [field, label] of Object.entries(fields)) if (item[field] != null && item[field] !== '') emit(`${prefix}:${label}`, item[field]);
    }
  };
  tag('meta', { charSet: 'utf-8' });
  const viewport = metadata.viewport || { width: 'device-width', initialScale: 1 };
  const fields = { width: 'width', height: 'height', initialScale: 'initial-scale', minimumScale: 'minimum-scale', maximumScale: 'maximum-scale', userScalable: 'user-scalable', viewportFit: 'viewport-fit', interactiveWidget: 'interactive-widget' };
  meta('viewport', Object.entries(fields).filter(([name]) => viewport[name] != null).map(([name, label]) => `${label}=${typeof viewport[name] === 'boolean' ? viewport[name] ? 'yes' : 'no' : viewport[name]}`).join(', '));
  for (const color of list(viewport.themeColor)) if (color) meta('theme-color', typeof color === 'string' ? color : color.color, color.media ? { media: color.media } : {});
  meta('color-scheme', viewport.colorScheme);
  if (titleValue(metadata.title)) tag('title', {}, titleValue(metadata.title));
  for (const [field, name] of Object.entries({ description: 'description', applicationName: 'application-name', generator: 'generator', referrer: 'referrer', creator: 'creator', publisher: 'publisher', category: 'category', abstract: 'abstract', classification: 'classification' })) meta(name, metadata[field]);
  meta('keywords', list(metadata.keywords).join(','));
  for (const author of list(metadata.authors)) if (author) {
    if (author.url) tag('link', { rel: 'author', href: String(author.url) });
    meta('author', typeof author === 'string' ? author : author.name);
  }
  if (metadata.manifest) tag('link', { rel: 'manifest', href: String(metadata.manifest) });
  for (const rel of ['archives', 'assets', 'bookmarks']) for (const url of list(metadata[rel])) if (url) tag('link', { rel, href: String(url) });
  for (const [field, rel] of [['previous', 'prev'], ['next', 'next']]) if (metadata.pagination?.[field]) tag('link', { rel, href: String(metadata.pagination[field]) });
  meta('robots', metadata.robots?.basic ?? robotContent(metadata.robots));
  meta('googlebot', typeof metadata.robots?.googleBot === 'string' ? metadata.robots.googleBot : robotContent(metadata.robots?.googleBot));
  if (metadata.formatDetection) meta('format-detection', ['telephone', 'date', 'address', 'email', 'url'].filter(name => metadata.formatDetection[name] === false).map(name => `${name}=no`).join(', '));
  const alternates = object(metadata.alternates);
  if (alternates.canonical) {
    const item = descriptor(alternates.canonical);
    if (item.url) tag('link', { rel: 'canonical', href: String(item.url), title: item.title });
  }
  for (const [field, attribute] of [['languages', 'hrefLang'], ['media', 'media'], ['types', 'type']]) {
    for (const [name, values] of Object.entries(alternates[field] || {})) for (const value of list(values)) if (value) {
      const item = descriptor(value);
      if (item.url) tag('link', { rel: 'alternate', [attribute]: name, href: String(item.url), title: item.title });
    }
  }
  const verification = object(metadata.verification);
  for (const [field, name] of Object.entries({ google: 'google-site-verification', yahoo: 'y_key', yandex: 'yandex-verification', me: 'me' })) for (const value of list(verification[field])) meta(name, value);
  for (const [name, values] of Object.entries(verification.other || {})) for (const value of list(values)) meta(name, value);
  if (metadata.appleWebApp) {
    const apple = metadata.appleWebApp === true ? { capable: true } : metadata.appleWebApp;
    if (apple.capable !== false) meta('mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-title', apple.title);
    for (const value of list(apple.startupImage)) if (value) {
      const image = descriptor(value);
      if (image.url) tag('link', { rel: 'apple-touch-startup-image', href: String(image.url), media: image.media });
    }
    meta('apple-mobile-web-app-status-bar-style', apple.statusBarStyle);
  }
  if (metadata.itunes) meta('apple-itunes-app', `app-id=${metadata.itunes.appId}${metadata.itunes.appArgument ? `, app-argument=${metadata.itunes.appArgument}` : ''}`);
  property('fb:app_id', metadata.facebook?.appId);
  property('fb:admins', metadata.facebook?.admins);
  property('pinterest-rich-pin', metadata.pinterest?.richPin);
  const icons = metadata.icons;
  for (const [name, rel] of Object.entries({ shortcut: 'shortcut icon', icon: 'icon', apple: 'apple-touch-icon', other: 'icon' })) {
    const items = typeof icons === 'string' || icons instanceof URL || Array.isArray(icons) ? name === 'icon' ? icons : [] : object(icons)[name];
    for (const item of list(items)) if (item) {
      const icon = descriptor(item);
      if (icon.url) tag('link', { rel: icon.rel || rel, href: String(icon.url), sizes: icon.sizes, type: icon.type, media: icon.media, color: icon.color, fetchPriority: icon.fetchPriority });
    }
  }
  const og = object(metadata.openGraph);
  property('og:title', titleValue(og.title));
  properties('og', og, { description: 'description', locale: 'locale', siteName: 'site_name', countryName: 'country_name', determiner: 'determiner', url: 'url', ttl: 'ttl', emails: 'email', phoneNumbers: 'phone_number', faxNumbers: 'fax_number', alternateLocale: 'locale:alternate' });
  const imageFields = { secureUrl: 'secure_url', type: 'type', width: 'width', height: 'height', alt: 'alt' };
  media(property, 'og:image', og.images, imageFields);
  media(property, 'og:video', og.videos, { secureUrl: 'secure_url', type: 'type', width: 'width', height: 'height' });
  media(property, 'og:audio', og.audio, { secureUrl: 'secure_url', type: 'type' });
  if (Object.hasOwn(og, 'type')) {
    property('og:type', og.type);
    switch (og.type) {
      case 'website': case 'video.tv_show': case 'video.other': break;
      case 'article':
        properties('article', og, { publishedTime: 'published_time', modifiedTime: 'modified_time', expirationTime: 'expiration_time', authors: 'author', section: 'section', tags: 'tag' }); break;
      case 'book':
        properties('book', og, { isbn: 'isbn', releaseDate: 'release_date', authors: 'author', tags: 'tag' }); break;
      case 'profile':
        properties('profile', og, { firstName: 'first_name', lastName: 'last_name', username: 'username', gender: 'gender' }); break;
      case 'music.song':
        property('music:duration', og.duration);
        media(property, 'music:album', og.albums, { disc: 'disc', track: 'track' });
        property('music:musician', og.musicians); break;
      case 'music.album': case 'music.playlist':
        media(property, 'music:song', og.songs, { disc: 'disc', track: 'track' });
        if (og.type === 'music.album') properties('music', og, { musicians: 'musician', releaseDate: 'release_date' });
        else property('music:creator', og.creators);
        break;
      case 'music.radio_station': property('music:creator', og.creators); break;
      case 'video.movie': case 'video.episode':
        media(property, 'video:actor', og.actors, { role: 'role' });
        properties('video', og, { directors: 'director', writers: 'writer', duration: 'duration', releaseDate: 'release_date', tags: 'tag' });
        if (og.type === 'video.episode') property('video:series', og.series);
        break;
      default: throw new Error(`Invalid OpenGraph type: ${og.type}`);
    }
  }
  const twitter = object(metadata.twitter);
  meta('twitter:title', titleValue(twitter.title));
  for (const field of ['card', 'description', 'site', 'siteId', 'creator', 'creatorId']) meta(`twitter:${field === 'siteId' ? 'site:id' : field === 'creatorId' ? 'creator:id' : field}`, twitter[field]);
  media(meta, 'twitter:image', twitter.images, imageFields);
  if (twitter.card === 'player') for (const player of list(twitter.players)) if (player) {
    for (const [field, name] of Object.entries({ playerUrl: 'player', streamUrl: 'player:stream', width: 'player:width', height: 'player:height' })) meta(`twitter:${name}`, player[field]);
  }
  if (twitter.card === 'app') for (const platform of ['iphone', 'ipad', 'googleplay']) {
    meta(`twitter:app:name:${platform}`, twitter.app?.name);
    meta(`twitter:app:id:${platform}`, twitter.app?.id?.[platform]);
    meta(`twitter:app:url:${platform}`, twitter.app?.url?.[platform]);
  }
  const appFields = {
    ios: ['url', 'app_store_id', 'app_name'], iphone: ['url', 'app_store_id', 'app_name'], ipad: ['url', 'app_store_id', 'app_name'],
    android: ['package', 'url', 'class', 'app_name'], windows_phone: ['url', 'app_id', 'app_name'], windows: ['url', 'app_id', 'app_name'],
    windows_universal: ['url', 'app_id', 'app_name'], web: ['url', 'should_fallback'],
  };
  for (const [platform, fields] of Object.entries(appFields)) for (const item of list(metadata.appLinks?.[platform])) for (const field of fields) property(`al:${platform}:${field}`, item?.[field]);
  for (const [name, values] of Object.entries(metadata.other || {})) for (const value of list(values)) meta(name, value);
  return elements;
}

export async function Metadata({ entry, params, searchParams, pathname, trailingSlash, notFoundIndex }) {
  const metadata = await resolveMetadata(entry, { params, searchParams, pathname, trailingSlash }, notFoundIndex);
  return React.createElement(React.Fragment, null, ...metadataElements(metadata));
}
