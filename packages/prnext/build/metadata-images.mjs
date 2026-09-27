import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveNativeBinary } from '../native/resolve.mjs';
import { validateAppConfig, mergeAppConfig } from './app-config.mjs';
import { metadataExportNames } from './metadata-routes.mjs';
import { pageExtensionPattern, validatePageSource } from './page-extensions.mjs';
const execute = promisify(execFile);
const contentTypes = { ico: 'image/x-icon', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', gif: 'image/gif' };
const imageTypes = { favicon: ['ico'], icon: ['ico', 'jpg', 'jpeg', 'png', 'svg'], 'apple-icon': ['jpg', 'jpeg', 'png'], 'opengraph-image': ['jpg', 'jpeg', 'png', 'gif'], 'twitter-image': ['jpg', 'jpeg', 'png', 'gif'] };
async function imageInfo(file, kind, extension) {
  const bytes = await readFile(file);
  const max = kind === 'opengraph-image' ? 8 : 5;
  if (bytes.length > max * 1024 * 1024) throw new Error(`${file} exceeds the ${max} MiB metadata image limit`);
  let dimensions = {};
  if (extension !== 'svg') {
    const binary = await resolveNativeBinary();
    const { stdout } = await execute(binary, ['image-info', file], { timeout: 30000, maxBuffer: 65536 });
    const info = JSON.parse(stdout);
    dimensions = { width: info.width, height: info.height };
  }
  let alt;
  try { alt = (await readFile(file.slice(0, -extension.length - 1) + '.alt.txt', 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...dimensions, type: contentTypes[extension], ...(alt ? { alt } : {}), hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16), ...(extension === 'svg' ? { sizes: 'any' } : {}) };
}
export async function scanMetadataImages({ root, appRoot, files, routes, patterns, validatePattern, basePath, pageExtensions, appNotFound }) {
  const metadataImages = [];
  const sourceExtension = pageExtensionPattern(pageExtensions);
  for (const file of files) {
    const relative = path.relative(appRoot, file).replaceAll(path.sep, '/');
    const parts = relative.split('/');
    const name = parts.pop();
    if (parts.some(part => part.startsWith('_'))) continue;
    const dynamic = sourceExtension.test(name);
    const match = dynamic ? /^(favicon|icon\d*|apple-icon\d*|opengraph-image\d*|twitter-image\d*)$/.exec(name.replace(sourceExtension, '')) : /^(favicon|icon\d*|apple-icon\d*|opengraph-image\d*|twitter-image\d*)\.(ico|jpg|jpeg|png|svg|gif)$/.exec(name);
    if (!match) continue;
    const [, stem, extension] = match;
    const kind = stem.replace(/\d+$/, '');
    if (dynamic) validatePageSource(file);
    if (!dynamic && !imageTypes[kind].includes(extension)) continue;
    if (kind === 'favicon' && (parts.length || dynamic)) continue;
    const names = dynamic ? metadataExportNames(await readFile(file, 'utf8'), file) : [];
    if (names.some(name => ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(name))) throw new Error(`${relative} must export a default metadata function, not HTTP methods.`);
    const multiple = names.includes('generateImageMetadata');
    const urlParts = parts.filter(part => !/^\([^()]+\)$/.test(part) && !part.startsWith('@')).map(part => part.replace(/^%5f/i, '_'));
    if (urlParts.some(part => /^\(\.{1,3}\)/.test(part))) continue;
    let suffix = '';
    if (parts.some(part => /^\([^()]+\)$/.test(part) || part.startsWith('@'))) {
      let hash = 5381;
      for (const character of '/' + parts.join('/')) hash = (hash * 33 + character.charCodeAt(0)) | 0;
      suffix = '-' + (hash >>> 0).toString(36).slice(0, 6);
    }
    const filename = stem + suffix + (dynamic ? '' : '.' + extension);
    const pattern = validatePattern([...urlParts, filename, ...(multiple ? ['[__metadata_id__]'] : [])], relative);
    const signature = pattern.replace(/\[[^\]]+\]/g, '[]');
    if (patterns.has(signature)) throw new Error(`Conflicting metadata route ${relative} and ${patterns.get(signature)} at ${pattern}.`);
    try { await access(path.join(root, 'public', pattern.slice(1))); throw new Error(`Metadata route ${pattern} conflicts with a file in public/.`); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    patterns.set(signature, relative);
    const handlerConfig = dynamic ? await validateAppConfig(file) : {};
    handlerConfig.revalidate ??= false;
    if (multiple) handlerConfig.generateStaticParams = true;
    routes.push({ id: `app-metadata-${createHash('sha256').update(pattern).digest('hex').slice(0, 12)}`, pattern, router: 'app', kind: 'api', file, handlerConfig,
      cacheConfig: mergeAppConfig([handlerConfig]), metadataFile: { kind, dynamic, image: true, multiple, contentType: contentTypes[extension] } });
    metadataImages.push({ path: parts.join('/'), kind, pattern: basePath + pattern, multiple, ...(dynamic ? { file, exports: names.filter(name => ['alt', 'size', 'contentType', 'generateImageMetadata'].includes(name)) } : { info: await imageInfo(file, kind, extension) }) });
  }
  for (const route of routes) if (route.kind === 'page' && route.router === 'app') route.metadataFiles = metadataImages.filter(image => route.segments.some(segment => segment.path === image.path));
  if (appNotFound) appNotFound.metadataFiles = metadataImages.filter(image => image.path === '');
}
