import { mkdir, readFile, writeFile, cp, readdir, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const marker = '.prnext-export.json';
function filename(root, url) {
  const parts = url.replace(/^\/+/, '').split('/').filter(Boolean).map(segment => {
    const value = decodeURIComponent(segment);
    if (value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new Error('Invalid static export pathname');
    return value;
  });
  return path.join(root, ...parts);
}
async function exists(file) { try { return await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }

/** Only browser files and public response bodies enter an export, never runtime secrets. */
export async function prepareStaticExport({ project, stage, manifest, config }) {
  const reject = reason => { throw new Error(`output: 'export': ${reason}`); };
  if (manifest.middleware) reject('middleware/proxy requires a server');
  if (manifest.customRoutes.redirects.length || manifest.customRoutes.headers.length || Object.values(manifest.customRoutes.rewrites).some(value => value.length)) reject('headers, redirects and rewrites require a server');
  if (Object.keys(manifest.app?.actions || {}).length) reject('Server Actions require a server');
  const folder = path.join(stage, 'export');
  await mkdir(folder);
  const written = new Set();
  async function put(url, contents, source) {
    const file = filename(folder, url);
    if (written.has(file) || await exists(file)) reject(`conflicting exported files at ${url}`);
    written.add(file); await mkdir(path.dirname(file), { recursive: true });
    if (source) await cp(source, file); else await writeFile(file, contents);
  }
  const mount = config.basePath || '';
  const publicDirectory = path.join(project.root, 'public');
  async function copyPublic(source, url) {
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (item.isSymbolicLink()) reject(`public symlink ${item.name} cannot be exported`);
      const next = url + '/' + item.name;
      if (item.isDirectory()) await copyPublic(path.join(source, item.name), next);
      else if (item.isFile()) await put(next, undefined, path.join(source, item.name));
    }
  }
  if (await exists(publicDirectory)) await copyPublic(publicDirectory, mount);
  const assets = /^https?:/.test(manifest.config.assetBase) ? '/_prnext/assets' : manifest.config.assetBase;
  await mkdir(path.dirname(filename(folder, assets)), { recursive: true });
  if (await exists(filename(folder, assets))) reject('public files overlap the framework assets');
  await cp(path.join(stage, 'assets'), filename(folder, assets), { recursive: true });
  for (const route of manifest.routes) {
    if (route.internal) continue;
    if (route.kind === 'api' && route.router !== 'app') reject(`Pages API ${route.pattern} requires a server`);
    if (route.ssp || route.ppr || route.pprGeneric || route.dynamicPaths?.length || route.cacheConfig?.runtime === 'edge') reject(`${route.pattern} requires request-time rendering`);
    if (route.pattern.includes('[') && (!route.ssg || route.router !== 'app' && route.fallback !== false)) reject(`${route.pattern} needs generated paths without fallback`);
    if (!route.pattern.includes('[') && !manifest.prerendered.some(item => item.path === route.pattern)) reject(`${route.pattern} was not fully prerendered`);
  }
  for (const entry of manifest.prerendered) {
    const route = manifest.routes.find(route => route.id === entry.routeId);
    if (!route) reject(`missing route identity for ${entry.path}`);
    if (route.errorStatus === 404 && manifest.appNotFound) continue;
    if (route?.internal && !route.errorStatus && route.id !== manifest.appNotFound) continue;
    if (entry.status >= 300 && ![404, 500].includes(entry.status)) reject(`redirect/error ${entry.path} cannot be a static response`);
    if (entry.revalidate !== undefined && entry.revalidate !== false) reject(`ISR ${entry.path} requires a server`);
    let pathname = entry.path.replace(/\/$/, '') || '/';
    if (route?.errorStatus) pathname = '/' + route.errorStatus;
    if (route?.id === manifest.appNotFound) pathname = '/404';
    const body = await readFile(path.join(stage, entry.file));
    if (route?.kind === 'api') { await put(mount + pathname, body); continue; }
    let html = body.toString();
    if (html.includes(config.images.path + '?')) reject(`optimized images in ${pathname} require images.unoptimized or a custom loader`);
    html = html.replace(/<head(?:\s[^>]*)?>/i, value => value + '<script>window.__PRNEXT_STATIC_EXPORT__=true;</script>');
    const output = pathname === '/' ? '/index.html' : config.trailingSlash && !['/404', '/500'].includes(pathname) ? pathname + '/index.html' : pathname + '.html';
    await put(mount + output, html);
    if (entry.dataFile) {
      const data = await readFile(path.join(stage, entry.dataFile));
      if (route?.router === 'app') await put(mount + '/_prnext/flight' + (pathname === '/' ? '' : pathname) + '/index.txt', data);
      else for (const prefix of ['/_prnext/data/', '/_next/data/']) await put(mount + prefix + manifest.buildId + (pathname === '/' ? '/index' : pathname) + '.json', data);
    }
  }
  await writeFile(path.join(folder, marker), JSON.stringify({ version: 1, buildId: manifest.buildId, basePath: mount, trailingSlash: config.trailingSlash }));
  return folder;
}

export async function publishStaticExport(source, root) {
  const destination = path.join(root, 'out'), backup = path.join(root, '.prnext-export-backup-' + randomUUID());
  const previous = await exists(destination);
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink() || !await exists(path.join(destination, marker))) throw new Error('Refusing to replace out/: it is not a PRNext static export');
    await rename(destination, backup);
  }
  try { await rename(source, destination); }
  catch (error) { if (previous) await rename(backup, destination); throw error; }
  return {
    async rollback() { await rename(destination, source); if (previous) await rename(backup, destination); },
    async commit() { if (previous) await rm(backup, { recursive: true, force: true }); },
  };
}
