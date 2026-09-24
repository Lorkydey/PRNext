import { access } from 'node:fs/promises';
import {readDirectory} from './directory-cache.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateAppConfig, mergeAppConfig } from './app-config.mjs';
import { scanMiddleware } from './middleware.mjs';
import { scanMetadataRoutes } from './metadata-routes.mjs';
import { scanAdvancedAppRoutes } from './app-routing.mjs';
import { pageExtensionPattern, validatePageSource } from './page-extensions.mjs';

const sourceExtension = /\.(?:[cm]?js|jsx|tsx?)$/;

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function walk(directory) {
  const files = [];
  for (const item of await readDirectory(directory)) {
    if (item.name.startsWith('.')) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(file));
    else if (item.isFile()) files.push(file);
  }
  return files.sort();
}

export function routePattern(relativeFile, extensionPattern = sourceExtension) {
  const segments = relativeFile.replaceAll(path.sep, '/').replace(extensionPattern, '').split('/');
  if (segments.at(-1) === 'index') segments.pop();
  return validatePattern(segments, relativeFile);
}

function validatePattern(segments, relativeFile) {
  const names = new Set();
  for (const [index, segment] of segments.entries()) {
    if (!segment.includes('[') && !segment.includes(']')) continue;
    const match = /^(?:\[([A-Za-z_$][\w$]*)\]|\[\.\.\.([A-Za-z_$][\w$]*)\]|\[\[\.\.\.([A-Za-z_$][\w$]*)\]\])$/.exec(segment);
    if (!match) throw new Error(`Unsupported route segment "${segment}" in ${relativeFile}. Use [id], [...slug], or [[...slug]].`);
    const name = match[1] || match[2] || match[3];
    if (names.has(name)) throw new Error(`Duplicate parameter "${name}" in ${relativeFile}.`);
    names.add(name);
    if ((match[2] || match[3]) && index !== segments.length - 1) {
      throw new Error(`Catch-all parameter must be the final segment in ${relativeFile}.`);
    }
  }
  const pattern = '/' + segments.join('/');
  if (pattern === '/_rustyx' || pattern.startsWith('/_rustyx/')) {
    throw new Error(`Route ${pattern} uses the reserved /_rustyx namespace.`);
  }
  return pattern;
}

export async function scanProject(projectRoot, { basePath = '', pageExtensions, i18n } = {}) {
  const sourceExtension = pageExtensionPattern(pageExtensions);
  const root = path.resolve(projectRoot);
  const middleware = await scanMiddleware(root, { basePath, pageExtensions, i18n });
  const roots = [];
  for (const name of ['pages', 'src/pages']) if (await exists(path.join(root, name))) roots.push(path.join(root, name));
  if (roots.length > 1) throw new Error('Both pages/ and src/pages/ exist. Keep exactly one Pages Router directory.');
  const appRoots = [];
  for (const name of ['app', 'src/app']) if (await exists(path.join(root, name))) appRoots.push(path.join(root, name));
  if (appRoots.length > 1) throw new Error('Both app/ and src/app/ exist. Keep exactly one App Router directory.');
  if (!roots.length && !appRoots.length) throw new Error('No pages/, src/pages/, app/, or src/app/ directory found. Create app/page.tsx or pages/index.tsx to start.');
  const pageRoot = roots[0];
  const files = (pageRoot ? await walk(pageRoot) : []).filter(file => sourceExtension.test(file) && !file.endsWith('.d.ts'));
  const routes = [];
  const patterns = new Map();
  const pagesErrors = {};
  let app;
  let document;
  for (const file of files) {
    validatePageSource(file);
    const relative = path.relative(pageRoot, file).replaceAll(path.sep, '/');
    const name = relative.replace(sourceExtension, '');
    if (name === '_app') {
      if (app) throw new Error('Multiple _app files found. Keep only one.');
      app = file;
      continue;
    }
    if (name === '_document') {
      if (document) throw new Error('Multiple _document files found. Keep only one.');
      document = file;
      continue;
    }
    const pattern = routePattern(relative, sourceExtension);
    const signature = pattern.replace(/\[\[\.\.\.[^\]]+\]\]/g, '[[...]]').replace(/\[\.\.\.[^\]]+\]/g, '[...]').replace(/\[[^\]]+\]/g, '[]');
    if (patterns.has(signature)) throw new Error(`Conflicting routes: ${patterns.get(signature)} and ${relative} both match ${pattern}.`);
    patterns.set(signature, relative);
    const kind = relative.startsWith('api/') ? 'api' : 'page';
    const id = `${kind}-${createHash('sha256').update(pattern).digest('hex').slice(0, 12)}`;
    const errorKind = name === '_error' ? 'error' : pattern === '/404' ? 'notFound' : pattern === '/500' ? 'serverError' : undefined;
    if (errorKind) pagesErrors[errorKind] = id;
    routes.push({ id, pattern, kind, file,
      ...(errorKind === 'error' ? { internal: true } : errorKind ? { errorStatus: pattern === '/404' ? 404 : 500 } : {}),
    });
  }
  const appRoot = appRoots[0];
  const { appNotFound, appGlobalError } = appRoot ? await scanAppRoutes({ root, appRoot, routes, patterns, sourceExtension }) : {};
  const metadataManifest = appRoot ? await scanMetadataRoutes({ root, appRoot, files: await walk(appRoot), routes, patterns, validatePattern, basePath, pageExtensions, appNotFound }) : undefined;
  if (metadataManifest) for (const route of routes) if (route.router === 'app' && route.kind === 'page') route.staticMetadata = { manifest: metadataManifest };
  if (!routes.length && !appNotFound) throw new Error('No page or API route found in the Pages Router or App Router directories.');
  return { root, pageRoot, appRoot, app, document, routes, ...(appNotFound ? { appNotFound } : {}), ...(appGlobalError ? { appGlobalError } : {}), ...(Object.keys(pagesErrors).length ? { pagesErrors } : {}), ...(middleware ? { middleware } : {}) };
}

const appConventions = new Map([
  ['page', 'page'], ['route', 'route'], ['layout', 'layout'], ['template', 'template'],
  ['loading', 'loading'], ['error', 'error'], ['not-found', 'notFound'], ['default', 'default'],
]);

async function scanAppRoutes({ root, appRoot, routes, patterns, sourceExtension }) {
  const directories = new Map();
  const configs = new Map();
  let appGlobalError;
  for (const file of await walk(appRoot)) {
    if (!sourceExtension.test(file) || file.endsWith('.d.ts')) continue;
    const relative = path.relative(appRoot, file).replaceAll(path.sep, '/');
    const parts = relative.split('/');
    const filename = parts.pop().replace(sourceExtension, '');
    if (parts.some(segment => segment.startsWith('_'))) continue;
    if (filename === 'global-error') {
      // This convention replaces the complete root document. A similarly named
      // file inside a route group or segment is not a nested error boundary.
      if (parts.length === 0) {
        if (appGlobalError) throw new Error('Multiple global-error files in the App Router root. Keep only one.');
        appGlobalError = file;
      }
      continue;
    }
    if (!appConventions.has(filename)) continue;
    validatePageSource(file);
    if (['page', 'layout', 'route'].includes(filename)) configs.set(file, await validateAppConfig(file));
    const directory = parts.join('/');
    const descriptor = directories.get(directory) || { directory, files: {} };
    const name = appConventions.get(filename);
    if (descriptor.files[name]) throw new Error(`Multiple ${filename} files in App Router directory ${directory || '/'}. Keep only one file for each convention.`);
    descriptor.files[name] = file;
    directories.set(directory, descriptor);
  }
  const advanced = [...directories.keys()].some(directory => directory.split('/').some(segment => segment.startsWith('@') || /^\(\.{1,3}\)/.test(segment)));
  if (advanced) scanAdvancedAppRoutes({ root, appRoot, directories, configs, routes, patterns, validatePattern });
  for (const { directory, files } of advanced ? [] : directories.values()) {
    if (!files.page && !files.route) continue;
    if (files.page && files.route) throw new Error(`Conflicting routes: App Router page and route handler both occupy ${directory || '/'}.`);
    const parts = directory ? directory.split('/') : [];
    const urlParts = parts.filter(segment => !/^\([^()]+\)$/.test(segment)).map(segment => segment.replace(/^%5f/i, '_'));
    const pattern = validatePattern(urlParts, path.relative(root, files.page || files.route));
    const signature = pattern.replace(/\[\[\.\.\.[^\]]+\]\]/g, '[[...]]').replace(/\[\.\.\.[^\]]+\]/g, '[...]').replace(/\[[^\]]+\]/g, '[]');
    const label = path.relative(root, files.page || files.route);
    if (patterns.has(signature)) throw new Error(`Conflicting routes: ${patterns.get(signature)} and ${label} both match ${pattern} (App Router).`);
    patterns.set(signature, label);
    const kind = files.page ? 'page' : 'api';
    const id = `app-${kind}-${createHash('sha256').update(pattern).digest('hex').slice(0, 12)}`;
    const segments = [];
    for (let index = 0; index <= parts.length; index++) {
      const directory = parts.slice(0, index).join('/');
      const descriptor = directories.get(directory);
      const { page, route, ...conventions } = descriptor?.files || {};
      segments.push({ segment: index ? parts[index - 1] : '', path: directory, ...conventions,
        ...(conventions.layout ? { staticConfig: configs.get(conventions.layout) || {} } : {}),
      });
    }
    if (kind === 'page' && !segments.some(segment => segment.layout)) throw new Error(`App Router page ${label} needs a root layout. Create app/layout.tsx with <html> and <body>.`);
    const configFiles = kind === 'page' ? [...segments.map(segment => segment.layout).filter(Boolean), files.page] : [files.route];
    const cacheConfig = mergeAppConfig(configFiles.map(file => configs.get(file) || {}));
    routes.push({ id, pattern, kind, router: 'app', file: files.page || files.route, cacheConfig,
      ...(kind === 'page' ? { segments, pageConfig: configs.get(files.page) || {} } : { handlerConfig: configs.get(files.route) || {} }),
    });
  }
  const rootDescriptor = directories.get('');
  if (rootDescriptor?.files.layout) {
    if (routes.some(route => route.pattern === '/_not-found')) throw new Error('/_not-found is reserved for the App Router not-found entry.');
    const { page, route, ...conventions } = rootDescriptor.files;
    return { appGlobalError, appNotFound: { segments: [{ segment: '', path: '', ...conventions, staticConfig: configs.get(conventions.layout) || {} }],
      cacheConfig: mergeAppConfig([configs.get(conventions.layout) || {}]), pageConfig: {} } };
  }
  return { appGlobalError };
}
