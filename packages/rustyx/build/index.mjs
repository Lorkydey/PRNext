import {frameworkImportName} from './framework-imports.mjs';
import { expandLocales, localizedStaticPaths } from './i18n.mjs';
import { build as bundle, withCompilation, configureCompiler, compilerSource } from './compiler.mjs';
import { mkdir, readFile, writeFile, rename, rm, cp, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { prepareBuildDirectory, OUTPUT_POINTER } from '../runtime/build-directory.mjs';
import { moduleResolutionPlugin } from './module-resolution.mjs';
import { scanProject } from './scan.mjs';
import { stripServerCode, assertSupportedSource, rewriteServerChunks } from './transform.mjs';
import { transformDynamicImports } from './dynamic.mjs';
import { createCssModules } from './css-modules.mjs';
import { createFonts } from './fonts.mjs';
import { createImages } from './images.mjs';
import { compileApp } from './app.mjs';
import { prerenderApp } from './app-static.mjs';
import { precompressBuild } from './precompress.mjs';
import { loadProjectConfig, defineEnvironment, generateBuildId, publicAssetBase } from './config.mjs';
import { compileCustomRoutes } from './custom-routes.mjs';
import { compileMiddleware } from './middleware.mjs';
import { prepareScriptWorkers } from './script-workers.mjs';
import { prepareMetadataRoutes } from './metadata-routes.mjs';
import { prepareImageResponse } from './og.mjs';
import { prepareCacheHandler, prepareCacheHandlers } from './cache-handlers.mjs';
import { npmPackagesPlugin } from './npm-packages.mjs';
import { createRefreshTransform, devSingletonsPlugin, devClientFile } from './dev.mjs';
import { snapshotEnvConfig } from '../runtime/env.mjs';
import { validateStaticPaths } from '../runtime/pages-paths.mjs';
export { staticPath } from '../runtime/pages-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compatibleModules = new Set(['link', 'head', 'router', 'compat/router', 'next-router-context', 'next-app-router-context', 'image', 'cache', 'dynamic', 'error', 'document', 'app', 'script', 'og']);
const extensions = { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx', '.ts': 'ts', '.tsx': 'tsx' };
const assetLoaders = Object.fromEntries(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'].map(ext => [ext, 'file']));

function compatibilityPlugin({ browser, pageFiles, projectRoot, documentFile, fonts, refresh }) {
  return {
    name: 'rustyx-pages-compatibility',
    setup(esbuild) {
      esbuild.onResolve({ filter: /\.(?:css|scss|sass)$/i }, args => args.importer === documentFile
        ? { errors: [{ text: 'CSS cannot be imported within pages/_document. Move global styles to pages/_app, or return collected styles from Document.getInitialProps.' }] } : undefined);
      esbuild.onResolve({ filter: /^(?:next(?:\/|$)|rustyx\/)/ }, args => {
        const name = frameworkImportName(args.path);
        if (!compatibleModules.has(name)) return { errors: [{ text: `Rustyx does not implement ${args.path} yet (imported by ${args.importer}). Supported runtime imports: next/link, next/head, next/router, next/image, next/cache, next/dynamic, next/error, next/document, next/app, next/script.` }] };
        if (browser && name === 'document') return { errors: [{ text: `${args.path} is server-only. Import Document, Html, Head, Main and NextScript from pages/_document, not from a browser page or component.` }] };
        if (browser && ['cache', 'og'].includes(name)) return { errors: [{ text: `${args.path} is server-only and cannot be imported by a browser component.` }] };
        const file = name === 'compat/router' ? 'compat-router' : name;
        return browser ? { path: path.join(packageRoot, 'compat', file + '.cjs') } : { path: `../compat/${file}.cjs`, external: true };
      });
      if (browser) {
        const resolveFromProject = createRequire(path.join(projectRoot, 'package.json'));
        esbuild.onResolve({ filter: /^(?:react|react-dom)(?:\/|$)/ }, args => ({ path: resolveFromProject.resolve(args.path) }));
        esbuild.onResolve({ filter: /^server-only$/ }, () => ({ errors: [{ text: 'A server-only module is reachable from a browser component. Move its imports into getServerSideProps/getStaticProps dependencies.' }] }));
      } else {
        esbuild.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'rustyx-empty' }));
        esbuild.onResolve({ filter: /\.(?:css|scss|sass)$/i }, args => {
          if (/\.module\.(?:css|scss|sass)$/i.test(args.path) || args.pluginData?.rustyxResolvingCss) return;
          return { path: args.path, namespace: 'rustyx-empty' };
        });
        esbuild.onLoad({ filter: /.*/, namespace: 'rustyx-empty' }, () => ({ contents: '', loader: 'js' }));
      }
      esbuild.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?)$/, namespace: 'file' }, async args => {
        if (browser && args.path === documentFile) return { errors: [{ text: 'pages/_document is server-only and cannot be imported by a browser page or component.' }] };
        const source = await fonts.transform(args.rustyxSource ?? await readFile(args.path, 'utf8'), args.path);
        assertSupportedSource(source, args.path);
        const dynamicSource = transformDynamicImports(source, args.path, { projectRoot, mode: browser ? 'browser' : 'server' });
        let contents = browser && pageFiles.has(args.path) ? stripServerCode(dynamicSource, args.path) : dynamicSource;
        if (browser && refresh) contents = await refresh(contents, args.path);
        return { contents, loader: extensions[path.extname(args.path)] || 'jsx', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

function browserEntry(route, app, manifestUrl, paths, development) {
  return `${development ? `import ${JSON.stringify(devClientFile)};\n` : ''}import Page from ${JSON.stringify(route.file)};
${app ? `import App from ${JSON.stringify(app)};` : 'const App=undefined;'}
import {bootstrapPages} from ${JSON.stringify(path.join(packageRoot, 'runtime/pages-client.mjs'))};
export {Page,App};
bootstrapPages({Page,App,pattern:${JSON.stringify(route.pattern)},manifestUrl:${JSON.stringify(manifestUrl)},...${JSON.stringify(paths)}${development ? `,dev:${JSON.stringify(development)}` : ''}});
`;
}

function isDynamic(pattern) { return pattern.includes('['); }

async function addBuiltinPagesErrors(project, stage) {
  if (!project.pageRoot || project.pagesErrors?.error) return;
  project.pagesErrors ||= {};
  for (const [kind, status] of [['notFound', 404], ['serverError', 500], ['error', undefined]]) {
    if (project.pagesErrors[kind]) continue;
    // Internal artifacts must not occupy real App routes named /404 or /500.
    const pattern = status ? `/_rustyx/errors/${status}` : '/_error';
    const id = `page-builtin-error-${status || 'fallback'}`;
    const file = path.join(stage, '.entries', `${id}.jsx`);
    await writeFile(file, status
      ? `import ErrorComponent from 'rustyx/error';export default function BuiltinError(props){return <ErrorComponent {...props} statusCode={${status}}/>}`
      : `export {default} from 'rustyx/error';`);
    project.routes.push({ id, pattern, kind: 'page', file, internal: true,
      ...(status ? { errorStatus: status } : {}),
    });
    project.pagesErrors[kind] = id;
  }
}

async function prerender(stage, manifest, dev) {
  const { prerenderRoute, renderFallback } = await import(pathToFileURL(path.join(stage, 'runtime/render.mjs')).href);
  const paths = new Set();
  const seedsByRoute = new Map();
  const validatedDocuments = new Set();
  const staticListings = new Map();
  // Error page data is available when another static page returns notFound.
  const ordered = [...manifest.routes].sort((left, right) => Number(!!right.errorStatus) - Number(!!left.errorStatus));
  for (const route of ordered) {
    if (route.kind !== 'page' || route.router === 'app') continue;
    const modulePath = path.join(stage, route.module);
    const page = await import(pathToFileURL(modulePath).href);
    if (page.__rustyxDocument && !validatedDocuments.has(page.__rustyxDocument)) {
      for (const name of ['getStaticProps', 'getStaticPaths', 'getServerSideProps']) {
        if (Object.hasOwn(page.__rustyxDocument, name) || typeof page.Document?.[name] === 'function') throw new Error(`pages/_document does not support ${name}. Use Document.getInitialProps for server document rendering.`);
      }
      validatedDocuments.add(page.__rustyxDocument);
    }
    if (route.errorStatus && (page.getServerSideProps || page.default?.getInitialProps)) throw new Error(`pages${route.pattern} must be static and cannot use getServerSideProps or getInitialProps. Use getStaticProps instead.`);
    route.gip = typeof page.default?.getInitialProps === 'function';
    route.appGip = !!page.App && page.App.getInitialProps !== page.App.origGetInitialProps;
    if (route.internal && route.errorStatus && route.appGip) {
      // A custom App hook makes the built-in Error request-dependent. Select
      // its actual _error module so the default status props and visible URL
      // reach App.getInitialProps instead of a synthetic static wrapper.
      const kind = route.errorStatus === 404 ? 'notFound' : 'serverError';
      if (manifest.pagesErrors?.[kind] === route.id) delete manifest.pagesErrors[kind];
    }
    if (route.gip && (page.getStaticProps || page.getServerSideProps)) throw new Error(`Page ${route.pattern} cannot combine getInitialProps with getStaticProps or getServerSideProps.`);
    if (route.internal && !route.errorStatus) {
      if (page.getStaticProps || page.getServerSideProps || page.getStaticPaths) throw new Error('pages/_error does not support getStaticProps, getServerSideProps or getStaticPaths. Use ErrorComponent.getInitialProps instead.');
      continue;
    }
    if (page.getServerSideProps && page.getStaticProps) throw new Error(`Page ${route.pattern} exports both getServerSideProps and getStaticProps. Choose one.`);
    if (page.getStaticPaths && !page.getStaticProps) throw new Error(`Page ${route.pattern} exports getStaticPaths without getStaticProps.`);
    if (page.getServerSideProps) { route.ssp = true; continue; }
    if (page.getStaticProps) route.ssg = true;
    else if (route.gip || route.appGip) continue;
    let entries = [{ path: route.pattern, params: {} }];
    if (isDynamic(route.pattern)) {
      if (!page.getStaticProps) continue;
      if (!page.getStaticPaths) throw new Error(`Dynamic page ${route.pattern} with getStaticProps must export getStaticPaths.`);
      if (!staticListings.has(modulePath)) staticListings.set(modulePath, Promise.resolve().then(() => page.getStaticPaths(manifest.config.i18n ? {locales: manifest.config.i18n.locales, defaultLocale: manifest.config.i18n.defaultLocale} : {})));
      const result = localizedStaticPaths(route, await staticListings.get(modulePath), manifest.config.i18n);
      route.fallback = result.fallback;
      entries = result.paths;
    } else if (page.getStaticPaths) throw new Error(`getStaticPaths is only valid on dynamic pages (${route.pattern}).`);
    for (const entry of entries) {
      if (paths.has(entry.path)) throw new Error(`Multiple pages prerender the same path: ${entry.path}.`);
      paths.add(entry.path);
      const rendered = await prerenderRoute({ ...manifest.config, manifest, distDir: stage, route, modulePath, path: entry.path, params: entry.params, client: route.client, css: route.css, pattern: route.pattern, errorStatus: route.errorStatus, buildId: manifest.buildId, production: !dev });
      const file = `static/${createHash('sha256').update(entry.path).digest('hex').slice(0, 20)}.html`;
      await writeFile(path.join(stage, file), rendered.body);
      const seed = { routeId: route.id, path: entry.path, file, status: route.errorStatus || rendered.status || 200, headers: rendered.headers || {} };
      if (route.ssg) {
        seed.dataFile = file.replace(/\.html$/, '.json');
        seed.revalidate = rendered.revalidate ?? false;
        seed.generatedAt = rendered.generatedAt;
        await writeFile(path.join(stage, seed.dataFile), rendered.dataJSON);
      }
      manifest.prerendered.push(seed);
      if (!seedsByRoute.has(route.id)) seedsByRoute.set(route.id, []);
      seedsByRoute.get(route.id).push(seed);
    }
    if (route.fallback === true) {
      const rendered = await renderFallback({ ...manifest.config, modulePath, path: route.pattern, params: {}, client: route.client, css: route.css, pattern: route.pattern, buildId: manifest.buildId, production: !dev });
      route.fallbackFile = `static/fallback-${route.id}.html`;
      await writeFile(path.join(stage, route.fallbackFile), rendered.body);
    }
  }
  // Rendering errors first must not change the published route/seed ordering.
  manifest.prerendered = manifest.routes.flatMap(route => seedsByRoute.get(route.id) || []);
}

let buildQueue = Promise.resolve();
/** Isolate process.env between programmatic builds, including simultaneous calls. */
export function build(projectRoot, options = {}) {
  const task = buildQueue.then(async () => {
    const restore = snapshotEnvConfig();
    const envMode = options.envMode || (process.env.NODE_ENV === 'test' ? 'test' : options.dev ? 'development' : 'production');
    process.env.NODE_ENV = options.dev ? 'development' : 'production';
    try { return await withCompilation(() => buildProject(projectRoot, { ...options, envMode })); }
    finally { restore(); }
  });
  buildQueue = task.catch(() => {});
  return task;
}

/** Compile Pages Router and App Router projects. A failed build preserves .rustyx. */
async function buildProject(projectRoot, { dev = false, envMode, incremental = false, devInputs } = {}) {
  const started = performance.now();
  const config = await loadProjectConfig(projectRoot, { dev, envMode });
  const environment = defineEnvironment(config);
  const publicPaths = { trailingSlash: config.trailingSlash, skipTrailingSlashRedirect: config.skipTrailingSlashRedirect, basePath: config.basePath, assetPrefix: config.assetPrefix, assetBase: publicAssetBase(config) };
  const customRoutes = await compileCustomRoutes(config);
  const buildId = await generateBuildId(config, { dev });
  const project = await scanProject(projectRoot, { basePath: config.basePath, pageExtensions: config.pageExtensions, i18n: config.i18n });
  const stage = path.join(project.root, `.rustyx-build-${randomUUID()}`);
  const destination = await prepareBuildDirectory(project.root, config.distDir);
  const backup = path.join(project.root, `.rustyx-backup-${randomUUID()}`);
  await mkdir(path.join(stage, '.entries'), { recursive: true });
  await mkdir(path.join(stage, 'static'), { recursive: true });
  await addBuiltinPagesErrors(project, stage);
  const manifest = { version: 1, dev, buildId, cacheId: randomUUID(), previewModeId: randomUUID().replaceAll('-', ''), previewModeEncryptionKey: randomBytes(32).toString('hex'),
    config: { i18n: config.i18n, skipMiddlewareUrlNormalize: config.skipMiddlewareUrlNormalize, compress: config.compress, poweredByHeader: config.poweredByHeader, reactStrictMode: config.reactStrictMode, cacheComponents: config.cacheComponents, cacheLife: config.cacheLife, images: config.images, ...publicPaths }, customRoutes, routes: [], prerendered: [],
    ...(project.pagesErrors ? { pagesErrors: project.pagesErrors } : {}) };
  // Its build-unique name is known before bundling and avoids a hash cycle
  // between page entry URLs and the manifest that lists those entries.
  const pagesManifestUrl = `${publicPaths.assetBase}/pages-manifest-${manifest.cacheId}.json`;
  if (dev) manifest.devClient = `${publicPaths.assetBase}/dev-manifest-${manifest.cacheId}.json`;
  const development = dev ? { buildId, clientManifest: manifest.devClient } : undefined;
  const refresh = dev ? createRefreshTransform(project.root) : undefined;
  const fonts = createFonts({ projectRoot: project.root, stage, assetBase: publicPaths.assetBase });
  const cssModules = createCssModules({ projectRoot: project.root, stage, assetBase: publicPaths.assetBase, sassOptions: config.sassOptions });
  configureCompiler({config,root:project.root,stage,buildId,dev,incremental,devInputs,assetBase:publicPaths.assetBase});
  try {
    await mkdir(path.join(stage, 'runtime'), { recursive: true });
    await mkdir(path.join(stage, 'compat'), { recursive: true });
    for (const name of await readdir(path.join(packageRoot, 'runtime'))) {
      if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) await cp(path.join(packageRoot, 'runtime', name), path.join(stage, 'runtime', name));
    }
    // Runtime copies must work even when dotenv is nested beneath the Rustyx
    // package instead of hoisted beside the application's dependencies.
    await bundle({ entryPoints: [path.join(packageRoot, 'runtime/env.mjs')], outfile: path.join(stage, 'runtime/env.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', banner: { js: "import {createRequire as __rustyxCreateRequire} from 'node:module';const require=__rustyxCreateRequire(import.meta.url);" } });
    for (const name of await readdir(path.join(packageRoot, 'compat'))) {
      if (name.endsWith('.cjs')) await cp(path.join(packageRoot, 'compat', name), path.join(stage, 'compat', name));
    }
    await prepareImageResponse(stage);
    manifest.config.serverActions = config.experimental.serverActions;
    const cacheHandlers = await prepareCacheHandlers({ config, projectRoot: project.root, stage, environment });
    if (Object.keys(cacheHandlers).length) manifest.config.cacheHandlers = cacheHandlers;
    const cacheHandler = await prepareCacheHandler({ config, projectRoot: project.root, stage, environment });
    if (cacheHandler) manifest.config.cacheHandler = cacheHandler;
    if (config.cacheMaxMemorySize !== undefined) manifest.config.cacheMaxMemorySize = config.cacheMaxMemorySize;
    const images = await createImages({ projectRoot: project.root, stage, assetBase: publicPaths.assetBase, config: config.images });
    if (config.experimental.nextScriptWorkers) manifest.scriptWorkers = await prepareScriptWorkers({ projectRoot: project.root, stage, assetBase: publicPaths.assetBase });
    const serverEntries = {};
    const clientEntries = {};
    const pageFiles = new Set([...project.routes.filter(route => route.kind === 'page').map(route => route.file), ...(project.app ? [project.app] : [])]);
    for (const route of project.routes.filter(route => route.router !== 'app')) {
      const serverEntry = path.join(stage, '.entries', route.id + '.server.mjs');
      await writeFile(serverEntry, `export {default} from ${JSON.stringify(route.file)};\nexport * from ${JSON.stringify(route.file)};\n${route.kind === 'page' && project.app ? `export {default as App} from ${JSON.stringify(project.app)};` : ''}\n${route.kind === 'page' && project.document ? `export {default as Document} from ${JSON.stringify(project.document)};export * as __rustyxDocument from ${JSON.stringify(project.document)};` : ''}\n`);
      serverEntries[route.id] = serverEntry;
      if (route.kind === 'page') {
        const clientEntry = path.join(stage, '.entries', route.id + '.client.jsx');
        await writeFile(clientEntry, browserEntry(route, project.app, pagesManifestUrl, { ...publicPaths, strictMode: config.reactStrictMode === true }, development));
        clientEntries[route.id] = clientEntry;
      }
      manifest.routes.push({ id: route.id, pattern: route.pattern, kind: route.kind, module: `server/${route.id}.mjs`, css: [],
        ...(route.internal ? { internal: true } : {}), ...(route.errorStatus ? { errorStatus: route.errorStatus } : {}),
      });
    }
    const common = { absWorkingDir: project.root, bundle: true, logLevel: 'silent', jsx: 'automatic', loader: assetLoaders, assetNames: '[name]-[hash]', publicPath: publicPaths.assetBase, metafile: true, define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), ...environment } };
    if (Object.keys(serverEntries).length) {
      const server = await bundle({ ...common, entryPoints: serverEntries, outdir: path.join(stage, 'server'), outExtension: { '.js': '.mjs' }, platform: 'node', format: 'esm', splitting: true, chunkNames: 'chunk-[hash]', banner: { js: "import {createRequire as __rustyxCreateRequire} from 'node:module';const require=__rustyxCreateRequire(import.meta.url);" }, target: 'node22', sourcemap: dev, plugins: [moduleResolutionPlugin(config.turbopack, project.root), images.plugin(), fonts.plugin(), compatibilityPlugin({ browser: false, pageFiles, projectRoot: project.root, documentFile: project.document, fonts }), npmPackagesPlugin({ pages: true, projectRoot: project.root, transpilePackages: config.transpilePackages, serverExternalPackages: config.serverExternalPackages }), cssModules.plugin(false)] });
      fonts.record(server.metafile);
      const serverChunks = new Set(Object.keys(server.metafile.outputs).filter(file => file.endsWith('.mjs')).map(file => path.basename(file)));
      for (const [output, metadata] of Object.entries(server.metafile.outputs)) {
        if (!output.endsWith('.mjs') || !metadata.imports.some(item => !item.external)) continue;
        const file = path.resolve(project.root, output);
        await rewriteServerChunks(file, serverChunks, publicPaths.assetBase);
      }
      // Image/font imports must resolve to the same public URLs on both render paths.
      await mkdir(path.join(stage, 'assets'), { recursive: true });
      for (const [output, metadata] of Object.entries(server.metafile.outputs)) {
        if (!metadata.entryPoint && !output.endsWith('.map') && !output.endsWith('.mjs')) await cp(path.resolve(project.root, output), path.join(stage, 'assets', path.basename(output)));
      }
    }
    if (Object.keys(clientEntries).length) {
      const browser = await bundle({ ...common, entryPoints: clientEntries, outdir: path.join(stage, 'assets'), entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]', platform: 'browser', format: 'esm', target: ['es2022'], splitting: true, minify: !dev, sourcemap: dev || config.productionBrowserSourceMaps, define: { 'process.env': '{}', ...common.define }, plugins: [moduleResolutionPlugin(config.turbopack, project.root), ...(dev ? [devSingletonsPlugin()] : []), images.plugin(), fonts.plugin(), compatibilityPlugin({ browser: true, pageFiles, projectRoot: project.root, documentFile: project.document, fonts, refresh }), cssModules.plugin(true)] });
      fonts.record(browser.metafile);
      const byEntry = new Map(Object.entries(clientEntries).map(([id, file]) => [path.resolve(file), id]));
      for (const [output, metadata] of Object.entries(browser.metafile.outputs)) {
        if (!metadata.entryPoint || !output.endsWith('.js')) continue;
        const id = byEntry.get(path.resolve(project.root, metadata.entryPoint));
        const route = manifest.routes.find(route => route.id === id);
        // Dynamic import() chunks are also entry points in esbuild's metadata.
        // Their loaders retain those chunks; only route entries bootstrap pages.
        if (!route) continue;
        route.client = publicPaths.assetBase + '/' + path.basename(output);
        if (metadata.cssBundle) route.css.push(publicPaths.assetBase + '/' + path.basename(metadata.cssBundle));
      }
    }
    await compileMiddleware({ project, stage, manifest, dev, moduleResolution: config.turbopack, defineEnvironment: environment });
    await prepareMetadataRoutes(project, stage);
    await compileApp({ project, stage, manifest, moduleResolution: config.turbopack, cssModules, fonts, images, dev, defineEnvironment: environment, productionBrowserSourceMaps: config.productionBrowserSourceMaps, serverExternalPackages: config.serverExternalPackages });
    fonts.attach(manifest);
    expandLocales(manifest);
    await prerender(stage, manifest, dev);
    await prerenderApp(stage, manifest, dev);
    const pages = manifest.routes.filter(route => route.kind === 'page' && route.router !== 'app' && !route.internal);
    const publicPage = route => ({ ...(route.locale ? {locale:route.locale,originalPattern:route.originalPattern} : {}), id: route.id, pattern: route.pattern, client: route.client, css: route.css, ...(route.fonts ? { fonts: route.fonts } : {}), ssg: !!route.ssg, ssp: !!route.ssp, gip: !!route.gip, appGip: !!route.appGip });
    if (pages.length || manifest.pagesErrors) {
      const publicPages = {
        buildId: manifest.buildId,
        ...publicPaths,
        // Header rules cannot select a different page. Other server routing
        // stays authoritative, including middleware with conditional behavior.
        needsServerRouting: !!manifest.middleware || customRoutes.redirects.length > 0 ||
          Object.values(customRoutes.rewrites).some(rules => rules.length > 0),
        routes: pages.map(publicPage),
        ...(manifest.pagesErrors ? { errors: Object.fromEntries(Object.entries(manifest.pagesErrors).map(([kind, id]) => [kind, publicPage(manifest.routes.find(route => route.id === id))])) } : {}),
        ...(config.i18n && manifest.pagesErrors ? {localizedErrors:Object.fromEntries(config.i18n.locales.map(locale=>[locale,Object.fromEntries(Object.entries(manifest.pagesErrors).map(([kind,id])=>[kind,publicPage(manifest.routes.find(route=>route.id===(locale===config.i18n.defaultLocale?id:id+'-locale-'+locale)))]))]))} : {}),
        nonPagesRoutes: manifest.routes.filter(route => !route.internal && (route.kind !== 'page' || route.router === 'app'))
          .map(route => ({ pattern: route.pattern, kind: route.kind, router: route.router || 'pages' })),
      };
      await writeFile(path.join(stage, 'assets', path.basename(pagesManifestUrl)), JSON.stringify(publicPages));
      manifest.pagesManifest = pagesManifestUrl;
    }
    await rm(path.join(stage, '.entries'), { recursive: true });
    if (dev) {
      const appRoute = manifest.routes.find(route => route.router === 'app' && route.kind === 'page' && route.client);
      await writeFile(path.join(stage, 'assets', path.basename(manifest.devClient)), JSON.stringify({ buildId,
        pages: manifest.routes.filter(route => route.router !== 'app' && route.client).map(publicPage),
        ...(appRoute ? { app: { client: appRoute.client, css: appRoute.css } } : {}),
      }));
    }
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (config.compress) await precompressBuild(stage, manifest, {cacheDirectory:path.join(project.root,'.rustyx-cache/precompress-v1')});
    if (config.output === 'standalone' && !dev) await (await import('./standalone-runner.mjs')).prepareStandalone({ projectRoot: project.root, stage, manifest, config });
    const exporting = config.output === 'export' && !dev ? await import('./static-export.mjs') : null;
    const exportSource = exporting && await exporting.prepareStaticExport({ project, stage, manifest, config });
    let hadDestination = false;
    try { await stat(destination); hadDestination = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (hadDestination) await rename(destination, backup);
    const pointerTemporary = path.join(project.root, `.rustyx-output-${randomUUID()}.tmp`);
    let published = false;
    let exported;
    try {
      await writeFile(pointerTemporary, JSON.stringify({ distDir: config.distDir }) + '\n', { flag: 'wx' });
      if (exporting) exported = await exporting.publishStaticExport(exportSource, project.root);
      await rename(stage, destination);
      published = true;
      await rename(pointerTemporary, path.join(project.root, OUTPUT_POINTER));
    } catch (error) {
      if (published) await rename(destination, stage);
      await exported?.rollback();
      if (hadDestination) await rename(backup, destination);
      throw error;
    } finally { await rm(pointerTemporary, {force:true}); }
    await exported?.commit();
    if (hadDestination) await rm(backup, { recursive: true, force: true });
    return { ...manifest, outputDirectory: destination, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (error.errors) error.message = error.errors.map(item => `${item.location ? `${item.location.file}:${item.location.line}: ` : ''}${item.text}`).join('\n');
    throw error;
  }
}
