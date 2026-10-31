import {compileInstrumentation} from './instrumentation.mjs';
import {prerenderPages as prerender} from './prerender-pages.mjs';
import {isolatedPrerender,prerenderProduction} from './production-builder.mjs';
import { rename } from '../runtime/fs.mjs';
import { writeRuntimeContract } from './runtime-contract.mjs';
import { writeBuildOutput } from './output-contract.mjs';
import { bundleRuntime } from './bundle-runtime.mjs';
import {withPersistentTransforms} from './transform-cache.mjs';
import {applicationEntry, frameworkImportName, frameworkRuntimeImportPattern} from './framework-imports.mjs';
import { expandLocales, localizedStaticPaths } from './i18n.mjs';
import { build as bundle, withCompilation, configureCompiler, compilerSource,buildAnalysisRecords,buildAnalysisRoutes,devDependencies,devStylePlans,devStyleDependencies,devModules,readCompilerFile,compilationGraphCacheReport } from './compiler.mjs';
import {retainDeploymentAssets} from './deployment-assets.mjs';
import {selectHtmlOnlyRoutes} from './html-only-config.mjs';
import {writeBuildAnalysis} from './analyze.mjs';
import {routeFiles} from './dev-discovery.mjs';
import {tryBuildLazyGraph,rememberLazyBuildContext,forgetLazyBuildContext} from './dev-lazy-build.mjs';
import {writeTypedRoutes} from './typed-routes.mjs';
import { mkdir, readFile, writeFile, rm, cp, copyFile, stat, readdir, realpath } from 'node:fs/promises';
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
import { withBuildLock } from './build-lock.mjs';
import { loadProjectConfig, defineEnvironment, generateBuildId, publicAssetBase } from './config.mjs';
import { compileCustomRoutes } from './custom-routes.mjs';
import { compileMiddleware } from './middleware.mjs';
import { prepareScriptWorkers } from './script-workers.mjs';
import { prepareMetadataRoutes } from './metadata-routes.mjs';
import { prepareImageResponse } from './og.mjs';
import { prepareCacheHandler, prepareCacheHandlers } from './cache-handlers.mjs';
import { npmPackagesPlugin } from './npm-packages.mjs';
import { createRefreshTransform, createSourceLocationTransform, devSingletonsPlugin, devClientFile } from './dev.mjs';
import { snapshotEnvConfig } from '../runtime/env.mjs';
import { validateStaticPaths } from '../runtime/pages-paths.mjs';
import { projectTsconfig, checkTypeScript } from './typescript.mjs';
import {createReactCompilerTransform} from './react-compiler.mjs';
import {writeReactCompilerReport,reactCompilerReport} from './react-compiler-report.mjs';
export { staticPath } from '../runtime/pages-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compatibleModules = new Set(['link', 'head', 'router', 'compat/router', 'next-router-context', 'next-app-router-context', 'image', 'cache', 'dynamic', 'error', 'document', 'app', 'script', 'og', 'offline', 'redis-cache']);
const extensions = { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts' };
const assetLoaders = Object.fromEntries(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'].map(ext => [ext, 'file']));

// These framework files have already been enumerated: copyFile avoids cp's
// recursive traversal/stat work for every file. Bound I/O on large installations.
async function copyRuntimeFiles(stage,{development=true}={}) {
  const files = (await Promise.all(['runtime', 'compat'].map(async directory => {
    await mkdir(path.join(stage, directory), { recursive: true });
    return (await readdir(path.join(packageRoot, directory)))
      .filter(name => directory === 'runtime' ? name === 'profiles.json' || development&&name.endsWith('.mjs') && !name.endsWith('.test.mjs') : name.endsWith('.cjs'))
      .map(name => path.join(directory, name));
  }))).flat();
  let next = 0;
  const copying = await Promise.allSettled(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++];
      await copyFile(path.join(packageRoot, file), path.join(stage, file));
    }
  }));
  // Let outstanding writes finish before the caller removes a failed stage.
  const failed = copying.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

function compatibilityPlugin({ browser, pageFiles, projectRoot, documentFile, serverOnlyFiles, fonts, refresh, locations, reactCompiler }) {
  return {
    name: 'prnext-pages-compatibility',
    setup(esbuild) {
      applicationEntry(esbuild,readCompilerFile,{transformTypedHelpers:browser && !!reactCompiler});
      esbuild.onResolve({ filter: /\.(?:css|scss|sass)$/i }, args => args.importer === documentFile
        ? { errors: [{ text: 'CSS cannot be imported within pages/_document. Move global styles to pages/_app, or return collected styles from Document.getInitialProps.' }] } : undefined);
      esbuild.onResolve({ filter: frameworkRuntimeImportPattern }, args => {
        const name = frameworkImportName(args.path);
        if (!compatibleModules.has(name)) return { errors: [{ text: `PRNext does not implement ${args.path} yet (imported by ${args.importer}). Supported runtime imports: next/link, next/head, next/router, next/image, next/cache, next/dynamic, next/error, next/document, next/app, next/script.` }] };
        if (browser && name === 'document') return { errors: [{ text: `${args.path} is server-only. Import Document, Html, Head, Main and NextScript from pages/_document, not from a browser page or component.` }] };
        if (browser && ['cache', 'og', 'redis-cache'].includes(name)) return { errors: [{ text: `${args.path} is server-only and cannot be imported by a browser component.` }] };
        const file = name === 'compat/router' ? 'compat-router' : name;
        return browser ? { path: path.join(packageRoot, 'compat', file + '.cjs') } : { path: `../compat/${file}.cjs`, external: true };
      });
      if (browser) {
        const resolveFromProject = createRequire(path.join(projectRoot, 'package.json'));
        esbuild.onResolve({ filter: /^(?:react|react-dom)(?:\/|$)/ }, args => ({ path: resolveFromProject.resolve(args.path) }));
        esbuild.onResolve({ filter: /^server-only$/ }, () => ({ errors: [{ text: 'A server-only module is reachable from a browser component. Move its imports into getServerSideProps/getStaticProps dependencies.' }] }));
      } else {
        esbuild.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'prnext-empty' }));
        esbuild.onResolve({ filter: /\.(?:css|scss|sass)$/i }, args => {
          if (/\.module\.(?:css|scss|sass)$/i.test(args.path) || args.pluginData?.prnextResolvingCss) return;
          return { path: args.path, namespace: 'prnext-empty' };
        });
        esbuild.onLoad({ filter: /.*/, namespace: 'prnext-empty' }, () => ({ contents: '', loader: 'js' }));
      }
      esbuild.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/, namespace: 'file' }, async args => {
        if (browser && args.path === documentFile) return { errors: [{ text: 'pages/_document is server-only and cannot be imported by a browser page or component.' }] };
        const original=await readCompilerFile(args.path,args.prnextSource);
        // Pages shares a server graph with API handlers, Document and data
        // loaders. Keep that entire graph original: an uppercase JSX utility
        // may be called normally there, outside a React render. Browser render
        // graphs receive memoization before instrumentation and JSX lowering.
        const compiled=browser && reactCompiler && args.path!==documentFile && !serverOnlyFiles.has(args.path) ? await reactCompiler(original,args.path,{loaderOutput:args.prnextSource!==undefined}) : original;
        const source = await fonts.transform(locations?await locations(compiled,args.path):compiled, args.path);
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
    const pattern = status ? `/_prnext/errors/${status}` : '/_error';
    const id = `page-builtin-error-${status || 'fallback'}`;
    const file = path.join(stage, '.entries', `${id}.jsx`);
    await writeFile(file, status
      ? `import ErrorComponent from 'prnext/error';export default function BuiltinError(props){return <ErrorComponent {...props} statusCode={${status}}/>}`
      : `export {default} from 'prnext/error';`);
    project.routes.push({ id, pattern, kind: 'page', file, internal: true,
      ...(status ? { errorStatus: status } : {}),
    });
    project.pagesErrors[kind] = id;
  }
}


let buildQueue = Promise.resolve();
let developmentModulesLoaded = false;
/** Disposing shared compiler contexts must not interrupt another queued build. */
export function disposeBuildSession(root){
  const task=buildQueue.then(async()=>{forgetLazyBuildContext(root);const {closeIncrementalCompiler}=await import('./incremental.mjs');await closeIncrementalCompiler(root);});
  buildQueue=task.catch(()=>{});return task;
}
/** Isolate process.env between programmatic builds, including simultaneous calls. */
export function build(projectRoot, options = {}) {
  const task = buildQueue.then(async () => {
    if (options.adapter === undefined || options.adapter === 'auto') {
      const { detectBuildAdapter } = await import('./static-input.mjs');
      const selected = await detectBuildAdapter(projectRoot, { prepared: options.adapter === 'auto' });
      if (selected.adapter === 'static') return (await import('./static-adapter.mjs')).buildStatic(projectRoot, { ...selected, ...options });
      if (options.adapter === 'auto') options = { ...options, adapter: 'react' };
    }
    if (options.adapter === 'static') return (await import('./static-adapter.mjs')).buildStatic(projectRoot, options);
    if (options.adapter !== undefined && options.adapter !== 'react') throw new Error(`Unknown PRNext adapter: ${options.adapter}`);
    if (options.from !== undefined || options.spa !== undefined) throw new Error('from and spa are only supported by the static adapter.');
    const restore = snapshotEnvConfig();
    const envMode = options.envMode || (process.env.NODE_ENV === 'test' ? 'test' : options.dev ? 'development' : 'production');
    process.env.NODE_ENV = options.dev ? 'development' : 'production';
    try { return await withBuildLock(projectRoot, async root => {
      const started=performance.now();
      const result=await withPersistentTransforms(root,{dev:!!options.dev},()=>withCompilation(() => buildProject(root, { ...options, envMode })));
      return {...result,durationMs:Math.round(performance.now()-started)};
    }); }
    finally { restore(); }
  });
  buildQueue = task.catch(() => {});
  return task;
}

/** Compile Pages Router and App Router projects. A failed build preserves .prnext. */
async function buildProject(projectRoot, { dev = false, envMode, incremental = false, devInputs, devRoutes, devSequence, devSession, devActionSecret, devTools,devForceRefresh=false,devAffectedModules,devLazyRequest,devLazyBase,devLazyActivated=[] } = {}) {
  const started = performance.now();
  if (dev && devLazyRequest && devLazyBase) {
    const deferred = await tryBuildLazyGraph(projectRoot,{base:devLazyBase,request:devLazyRequest,
      devInputs,devSession,devActionSecret,incremental});
    if (deferred) return deferred;
  }
  const config = await loadProjectConfig(projectRoot, { dev, envMode, devInputs });
  const tsconfig = config.typescript ? await projectTsconfig(projectRoot, config) : undefined;
  const environment = defineEnvironment(config);
  const publicPaths = { trailingSlash: config.trailingSlash, skipTrailingSlashRedirect: config.skipTrailingSlashRedirect, basePath: config.basePath, assetPrefix: config.assetPrefix, assetBase: publicAssetBase(config) };
  const customRoutes = await compileCustomRoutes(config);
  const buildId = await generateBuildId(config, { dev });
  const scanOptions={basePath:config.basePath,pageExtensions:config.pageExtensions,i18n:config.i18n};
  let project,deferredRoutes=[];
  if(dev && Array.isArray(devRoutes)) {
    const discovery=await scanProject(projectRoot,{...scanOptions,devAppFiles:new Set()});
    project=await scanProject(projectRoot,{...scanOptions,devAppFiles:routeFiles(discovery,devRoutes)});
    await writeTypedRoutes(projectRoot,discovery,config);
    deferredRoutes=discovery.routes.filter(route=>!devRoutes.includes(route.pattern)&&!route.internal&&!route.errorStatus);
    project.routes=project.routes.filter(route=>devRoutes.includes(route.pattern)||route.internal||route.errorStatus);
  } else project=await scanProject(projectRoot,scanOptions);
  if(dev&&config.experimental.lazyDynamicImports){
    if(project.routes.some(route=>route.router!=='app'&&!route.internal))throw Error('experimental.lazyDynamicImports currently requires an App Router-only application.');
    if(config.webpack||Object.keys(config.turbopack?.rules||{}).length)throw Error('experimental.lazyDynamicImports currently requires the native compiler without webpack hooks or custom loaders.');
    if(/^https?:\/\//.test(config.assetPrefix))throw Error('experimental.lazyDynamicImports requires same-origin development assets.');
  }
  if(!dev&&config.htmlOnly.length)selectHtmlOnlyRoutes(project.routes,config.htmlOnly,config);
  if(!dev || !Array.isArray(devRoutes))await writeTypedRoutes(projectRoot,project,config);
  const stage = path.join(project.root, `.prnext-build-${randomUUID()}`);
  const destination = await prepareBuildDirectory(project.root, config.distDir);
  const backup = path.join(project.root, `.prnext-backup-${randomUUID()}`);
  await mkdir(path.join(stage, '.entries'), { recursive: true });
  await mkdir(path.join(stage, 'static'), { recursive: true });
  await addBuiltinPagesErrors(project, stage);
  const manifest = { version: 1, dev, buildId, cacheId: randomUUID(), previewModeId: randomUUID().replaceAll('-', ''), previewModeEncryptionKey: randomBytes(32).toString('hex'),
    ...(dev && Array.isArray(devRoutes) ? {devOnDemand:true} : {}), ...(dev && devSession ? {devSequence,devSession} : {}), ...(dev ? {devForceRefresh,devAffectedModules,devIndicators:config.devIndicators,...(devTools?{devTools}:{})} : {}),
    config: { i18n: config.i18n, skipMiddlewareUrlNormalize: config.skipMiddlewareUrlNormalize, compress: config.compress, poweredByHeader: config.poweredByHeader, reactStrictMode: config.reactStrictMode, cacheComponents: config.cacheComponents, partialPrefetching: config.partialPrefetching, navigationCache: config.navigationCache, cacheLife: config.cacheLife, htmlOnly:config.htmlOnly, images: config.images, ...publicPaths }, customRoutes, routes: [], prerendered: [],
    ...(project.pagesErrors ? { pagesErrors: project.pagesErrors } : {}) };
  // Its build-unique name is known before bundling and avoids a hash cycle
  // between page entry URLs and the manifest that lists those entries.
  if(!dev)manifest.config.deploymentId=manifest.cacheId;
  const pagesManifestUrl = `${publicPaths.assetBase}/pages-manifest-${manifest.cacheId}.json`;
  if (dev) manifest.devClient = `${publicPaths.assetBase}/dev-manifest-${manifest.cacheId}.json`;
  const development = dev ? { buildId, clientManifest: manifest.devClient, onDemand:manifest.devOnDemand===true, sequence:devSequence, session:devSession, indicator:config.devIndicators,...(devTools?{tools:devTools}:{}) } : undefined;
  const refresh = dev ? createRefreshTransform(project.root, {generation:manifest.cacheId,forceGeneration:devForceRefresh,forceFiles:devAffectedModules}) : undefined;
  const locations = dev ? createSourceLocationTransform(project.root) : undefined;
  const reactCompiler = config.reactCompiler ? createReactCompilerTransform(project.root, config.reactCompiler, {dev}) : undefined;
  const serverOnlyFiles = new Set();
  if (reactCompiler) for (const file of [...project.routes.filter(route=>route.kind==='api').map(route=>route.file),...(project.document?[project.document]:[])]) {
    serverOnlyFiles.add(file);serverOnlyFiles.add(await realpath(file));
  }
  const fonts = createFonts({ projectRoot: project.root, stage, assetBase: publicPaths.assetBase });
  const cssModules = createCssModules({ projectRoot: project.root, stage, assetBase: publicPaths.assetBase, sassOptions: config.sassOptions, cssEngine:config.cssEngine,dev,config });
  configureCompiler({config,root:project.root,stage,buildId,dev,incremental,devInputs,tsconfig,assetBase:publicPaths.assetBase});
  try {
    await copyRuntimeFiles(stage,{development:dev});
    // Runtime copies must work even when dotenv is nested beneath the PRNext
    // package instead of hoisted beside the application's dependencies.
    await bundle({ entryPoints: [path.join(packageRoot, 'runtime/env.mjs')], outfile: path.join(stage, 'runtime/env.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', banner: { js: "import {createRequire as __prnextCreateRequire} from 'node:module';const require=__prnextCreateRequire(import.meta.url);" } });
    await prepareImageResponse(stage);
    manifest.config.serverActions = config.experimental.serverActions;
    if(config.workerMemory && !dev)manifest.config.workerMemory=config.workerMemory;
    if (config.workerRetirement) manifest.config.workerRetirement = config.workerRetirement;
    if(config.workerPreload&&!dev)manifest.config.workerPreload=config.workerPreload;
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
      await writeFile(serverEntry, `export {default} from ${JSON.stringify(route.file)};\nexport * from ${JSON.stringify(route.file)};\n${route.kind === 'page' && project.app ? `export {default as App} from ${JSON.stringify(project.app)};` : ''}\n${route.kind === 'page' && project.document ? `export {default as Document} from ${JSON.stringify(project.document)};export * as __prnextDocument from ${JSON.stringify(project.document)};` : ''}\n`);
      serverEntries[route.id] = serverEntry;
      if (route.kind === 'page') {
        const clientEntry = path.join(stage, '.entries', route.id + '.client.jsx');
        await writeFile(clientEntry, browserEntry(route, project.app, pagesManifestUrl, { ...publicPaths, deploymentId:dev?undefined:manifest.cacheId, strictMode: config.reactStrictMode === true }, development));
        clientEntries[route.id] = clientEntry;
      }
      manifest.routes.push({ id: route.id, pattern: route.pattern, kind: route.kind, module: `server/${route.id}.mjs`, css: [],
        ...(route.internal ? { internal: true } : {}), ...(route.errorStatus ? { errorStatus: route.errorStatus } : {}),
      });
    }
    const common = { absWorkingDir: project.root, bundle: true, logLevel: 'silent', jsx: 'automatic', loader: assetLoaders, assetNames: '[name]-[hash]', publicPath: publicPaths.assetBase, metafile: true, define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), ...environment } };
    if (Object.keys(serverEntries).length) {
      const server = await bundle({ ...common, entryPoints: serverEntries, outdir: path.join(stage, 'server'), outExtension: { '.js': '.mjs' }, platform: 'node', format: 'esm', splitting: true, chunkNames: 'chunk-[hash]', banner: { js: "import {createRequire as __prnextCreateRequire} from 'node:module';const require=__prnextCreateRequire(import.meta.url);" }, target: 'node22', sourcemap: dev, plugins: [moduleResolutionPlugin(config.turbopack, project.root), images.plugin(), fonts.plugin(), compatibilityPlugin({ browser: false, pageFiles, projectRoot: project.root, documentFile: project.document, serverOnlyFiles, fonts, locations, reactCompiler }), npmPackagesPlugin({ pages: true, projectRoot: project.root, transpilePackages: config.transpilePackages, serverExternalPackages: config.serverExternalPackages }), cssModules.plugin(false)] });
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
      const browser = await bundle({ ...common, entryPoints: clientEntries, outdir: path.join(stage, 'assets'), entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]', platform: 'browser', format: 'esm', target: ['es2022'], splitting: true, minify: !dev, sourcemap: dev || config.productionBrowserSourceMaps, define: { 'process.env': '{}', ...common.define }, plugins: [moduleResolutionPlugin(config.turbopack, project.root), ...(dev ? [devSingletonsPlugin()] : []), images.plugin(), fonts.plugin(), compatibilityPlugin({ browser: true, pageFiles, projectRoot: project.root, documentFile: project.document, serverOnlyFiles, fonts, refresh, locations, reactCompiler }), cssModules.plugin(true)] });
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
    if (manifest.middleware) manifest.middleware.bodySizeLimit = config.experimental.proxyClientMaxBodySize;
    await prepareMetadataRoutes(project, stage);
    await compileApp({ project, stage, manifest, reactCompiler: config.reactCompiler, moduleResolution: config.turbopack, cssModules, fonts, images, dev, devActionSecret:dev?devActionSecret:undefined, defineEnvironment: environment, productionBrowserSourceMaps: config.productionBrowserSourceMaps, serverExternalPackages: config.serverExternalPackages, lazyDynamicImports:dev&&config.experimental.lazyDynamicImports,devLazyRequest,devLazyActivated });
    if(manifest.devLazy){
      const css=Object.values(manifest.devLazy.outputs).flatMap(module=>module.css);
      for(const route of manifest.routes)if(route.router==='app'&&route.kind==='page'){
        route.css=[...new Set([...route.css,...css])];
        if(css.length&&Array.isArray(route.cssScopes)){
          const root=route.cssScopes.find(scope=>scope.kind==='layout'&&!scope.path);
          if(root)root.css=[...new Set([...root.css,...css])];
          else route.cssScopes.push({kind:'layout',path:'',css:[...new Set(css)]});
        }
      }
    }
    if(manifest.config.workerPreload)for(const pattern of config.workerPreload.routes){
      const selected=manifest.routes.find(route=>!route.internal&&route.pattern===pattern);
      if(!selected||selected.cacheConfig?.runtime==='edge'||selected.handlerConfig?.runtime==='edge')throw new Error(`workerPreload route ${pattern} must be an existing Node route.`);
    }
    await compileInstrumentation({root:project.root,stage,manifest,config,dev,environment});
    if(deferredRoutes.length){
      for(const route of deferredRoutes){
        const module=`server/dev-deferred-${route.id}.mjs`;await writeFile(path.join(stage,module),'export {};\n');
        manifest.routes.push({id:route.id,pattern:route.pattern,kind:route.kind,router:route.router,module,devDeferred:true,css:[],cacheConfig:{maxDuration:120}});
      }
    }
    await checkTypeScript(project.root, config, { dev, tsconfig });
    fonts.attach(manifest);
    expandLocales(manifest);
    // All runtime preparation must finish before its shared modules are built;
    // no staged renderer has been imported before this production-only point.
    if (!dev) await bundleRuntime(stage,{projectRoot:project.root,sourceDirectory:path.join(packageRoot,'runtime')});
    // Node caches CJS React by filename, not NODE_ENV. Once development metadata
    // imports load it, subsequent production renders need a clean process too.
    if(dev) developmentModulesLoaded = true;
    if(!dev) Object.assign(manifest,await (incremental || developmentModulesLoaded ? isolatedPrerender : prerenderProduction)(project.root,stage,manifest,{prerender:config.prerender}));
    else {await prerender(stage, manifest, dev);await prerenderApp(stage, manifest, dev);}
    const pages = manifest.routes.filter(route => route.kind === 'page' && route.router !== 'app' && !route.internal && !route.devDeferred);
    const publicPage = route => ({ ...(route.locale ? {locale:route.locale,originalPattern:route.originalPattern} : {}), id: route.id, pattern: route.pattern, client: route.client, css: route.css, ...(route.fonts ? { fonts: route.fonts } : {}), ssg: !!route.ssg, ssp: !!route.ssp, gip: !!route.gip, appGip: !!route.appGip });
    if (pages.length || manifest.pagesErrors) {
      const publicPages = {
        buildId: manifest.buildId,
        ...(manifest.config.deploymentId?{deploymentId:manifest.config.deploymentId}:{}),
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
      manifest.devStyles={bundles:devStylePlans(),dependencies:devStyleDependencies(),modules:await cssModules.mappings()};
      for(const [,files]of manifest.devStyles.dependencies)for(const module of manifest.devStyles.modules)if(files.includes(module.file))for(const file of module.watchFiles)if(!files.includes(file))files.push(file);
      manifest.devDependencies=devDependencies(project,manifest);
      manifest.devModules=devModules(project.root);
      manifest.devDependencyStatus={complete:!manifest.devDependencies.incomplete&&!manifest.devModules.incomplete,reason:manifest.devDependencies.incomplete||manifest.devModules.incomplete};
      for(const route of manifest.devDependencies)for(const module of manifest.devStyles.modules){
        if(route.files.includes(path.relative(project.root,module.file).replaceAll(path.sep,'/')))for(const file of module.watchFiles){
          const relative=path.relative(project.root,file).replaceAll(path.sep,'/');if(!relative.startsWith('../')&&!route.files.includes(relative))route.files.push(relative);
        }
      }
      const appRoute = manifest.routes.find(route => route.router === 'app' && route.kind === 'page' && route.client);
      await writeFile(path.join(stage, 'assets', path.basename(manifest.devClient)), JSON.stringify({ buildId,
        ...(manifest.devLazy?{lazy:Object.values(manifest.devLazy.outputs)}:{}),
        pages: manifest.routes.filter(route => route.router !== 'app' && route.client).map(publicPage),
        ...(appRoute ? { app: { client: appRoute.client, css: appRoute.css, routes: manifest.routes.filter(route=>route.router==='app'&&route.kind==='page'&&route.client).map(({id,pattern,css,cssScopes})=>({id,pattern,css,cssScopes:cssScopes||[]})) } } : {}),
      }));
    }
    // A report belongs to this successful staging generation, never to the
    // runtime manifest or public assets. Publishing the stage is atomic below.
    if(!dev)await retainDeploymentAssets({stage,destination,manifest,policy:config.deploymentRetention});
    const compilationCache=compilationGraphCacheReport();
    if(!dev)await writeFile(path.join(stage,'compilation-cache-report.json'),JSON.stringify(compilationCache,null,2)+'\n');
    const compilerReport=await writeReactCompilerReport(stage,reactCompilerReport());
    await writeRuntimeContract(stage,{deployment:!dev,htmlOnly:!dev&&manifest.routes.some(route=>route.htmlOnly),workerMemory:Boolean(manifest.config.workerMemory),incrementalCache:Boolean(manifest.config.cacheHandler)});
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeBuildOutput(stage, manifest);
    // Offline compression is a deployment optimization. Recompressing source
    // maps and every entry after a save stalls Fast Refresh for no local benefit.
    if (!dev && config.compress) await precompressBuild(stage, manifest, {cacheDirectory:path.join(project.root,'.prnext-cache/precompress-v1')});
    if(!dev)await writeBuildAnalysis({root:project.root,stage,destination,manifest,records:buildAnalysisRecords(),routeInputs:buildAnalysisRoutes(),precompressed:config.compress});
    if (config.output === 'standalone' && !dev) await (await import('./standalone-runner.mjs')).prepareStandalone({ projectRoot: project.root, stage, manifest, config });
    const exporting = config.output === 'export' && !dev ? await import('./static-export.mjs') : null;
    const exportSource = exporting && await exporting.prepareStaticExport({ project, stage, manifest, config });
    let hadDestination = false;
    try { await stat(destination); hadDestination = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (hadDestination) await rename(destination, backup);
    const pointerTemporary = path.join(project.root, `.prnext-output-${randomUUID()}.tmp`);
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
    if(dev&&!devLazyRequest)rememberLazyBuildContext(project.root,{manifest,config,environment,tsconfig,envMode});
    return { ...manifest, outputDirectory: destination, durationMs: Math.round(performance.now() - started),reactCompilerReport:compilerReport,compilationCache };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (error.errors) error.message = error.errors.map(item => `${item.location ? `${item.location.file}:${item.location.line}: ` : ''}${item.text}`).join('\n');
    throw error;
  }
}
