import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadProjectConfig } from './config.mjs';
import { validateCompilerConfig } from './compiler.mjs';
import { scanProject } from './scan.mjs';
import { compileCustomRoutes } from './custom-routes.mjs';
import { validateReactVersions } from './app.mjs';
import { snapshotEnvConfig } from '../runtime/env.mjs';

/** Preflight an existing project without rewriting sources, dependencies or build output. */
export async function checkProject(directory, { dev = false, validateDependencies = true } = {}) {
  const root = path.resolve(directory);
  const report = { root, ok: false, routes: [], versions: {}, errors: [], notes: [
    'Preflight validates configuration, route conventions and installed React versions. A successful production build and browser tests are still required.',
    'Webpack plugin hooks are validated during compilation; preflight only validates plugin shape and translated configuration.',
    'Rust handles HTTP, routing, static files, images and persistent caches. React and npm JavaScript execute on Node/V8.',
  ] };
  const restore = snapshotEnvConfig();
  try {
    const config = await loadProjectConfig(root, {dev});
    if (config.onDemandEntries) report.notes.push('onDemandEntries is accepted for Next plugin compatibility. PRNext compiles all development routes and does not use Next\'s in-memory page eviction queue; these retention settings do not change its memory limits.');
    await compileCustomRoutes(config);
    const project = await scanProject(root, {basePath:config.basePath,pageExtensions:config.pageExtensions,i18n:config.i18n});
    await validateCompilerConfig(config,root,{dev,edge:project.middleware?.runtime==='edge'||project.routes.some(route=>route.cacheConfig?.runtime==='edge'||route.handlerConfig?.runtime==='edge')});
    report.routes = project.routes.filter(route=>!route.internal).map(({pattern,kind,router})=>({pattern,kind,router:router||'pages'}));
    const resolve = createRequire(path.join(root,'package.json'));
    for (const name of ['next','react','react-dom','react-server-dom-webpack']) {
      try { report.versions[name] = JSON.parse(await readFile(resolve.resolve(`${name}/package.json`),'utf8')).version; }
      catch { report.versions[name] = null; }
    }
    if (validateDependencies) {
      if (project.routes.some(route=>route.router==='app')) await validateReactVersions(resolve);
      else if (!report.versions.react || !report.versions['react-dom']) throw new Error('Install react and react-dom in the project before building Pages routes.');
    } else report.notes.push('Installed React versions have not been validated yet; migration checks them after dependency installation.');
    report.ok = true;
  } catch (error) { report.errors.push(error.message); }
  finally { restore(); }
  return report;
}
