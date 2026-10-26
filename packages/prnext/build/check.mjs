import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadProjectConfig } from './config.mjs';
import { validateCompilerConfig } from './compiler.mjs';
import { scanProject } from './scan.mjs';
import { compileCustomRoutes } from './custom-routes.mjs';
import { validateReactVersions } from './app.mjs';
import { snapshotEnvConfig } from '../runtime/env.mjs';
import { environmentDiagnostics } from '../native/diagnostics.mjs';
import { packageManifest } from '../native/resolve.mjs';
import { projectTsconfig } from './typescript.mjs';

/** Preflight an existing project without rewriting sources, dependencies or build output. */
export async function checkProject(directory, { dev = false, validateDependencies = true, validateEnvironment = validateDependencies } = {}, services = {}) {
  const root = path.resolve(directory);
  const report = { root, ok: false, routes: [], versions: {}, errors: [], diagnostics: [], notes: [
    'Preflight validates configuration, route conventions and installed React versions. A successful production build and browser tests are still required.',
    'Webpack plugin hooks are validated during compilation; preflight only validates plugin shape and translated configuration.',
    'Rust handles HTTP, routing, static files, images and persistent caches. React and npm JavaScript execute on Node/V8.',
  ] };
  const diagnostic = (id, error, action) => {
    const item = { id, severity: 'error', message: error.message, action };
    report.diagnostics.push(item);
    report.errors.push(item.message);
  };
  const restore = snapshotEnvConfig();
  try {
    let config, project;
    try { config = await loadProjectConfig(root, {dev}); }
    catch (error) { diagnostic('config', error, 'Correct the project configuration and run check again.'); }
    if (config) {
    if (config.onDemandEntries) report.notes.push('Development compiles requested routes and retains open browser routes. onDemandEntries controls inactive route retention; middleware, rewrites and parallel/intercepting routing use the complete graph.');
    try { await compileCustomRoutes(config); }
    catch (error) { diagnostic('custom-routes', error, 'Correct redirects, headers or rewrites in the configuration.'); }
    try { project = await scanProject(root, {basePath:config.basePath,pageExtensions:config.pageExtensions,i18n:config.i18n}); }
    catch (error) { diagnostic('routes', error, 'Correct the conflicting route files or route conventions.'); }
    try { await validateCompilerConfig(config,root,{dev,edge:project?.middleware?.runtime==='edge'||project?.routes.some(route=>route.cacheConfig?.runtime==='edge'||route.handlerConfig?.runtime==='edge')}); }
    catch (error) { diagnostic('compiler', error, 'Correct the compiler options or install the required compiler plugins.'); }
    try {
      const tsconfig = await projectTsconfig(root, config);
      if (tsconfig) {
        let ts;
        try { ts = createRequire(path.join(root, 'package.json'))('typescript'); }
        catch {
          const required = config.typedRoutes || config.typescript && !config.typescript.ignoreBuildErrors;
          const item = { id: 'typescript', severity: required ? 'error' : 'warning', message: 'TypeScript configuration exists, but TypeScript is not installed in the application.', action: 'Install typescript as an application dev dependency.' };
          report.diagnostics.push(item); if (required) report.errors.push(item.message);
        }
        if (ts) {
          const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: value => { throw new Error(ts.flattenDiagnosticMessageText(value.messageText, '\n')); } });
          if (!parsed || parsed.errors.length) throw new Error(parsed ? ts.formatDiagnostics(parsed.errors, { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n' }) : 'TypeScript configuration could not be parsed.');
          report.versions.typescript = ts.version;
          report.diagnostics.push({ id: 'typescript', severity: 'info', message: `TypeScript ${ts.version} configuration is valid. Semantic errors require prnext typecheck.` });
        }
      } else if (config.typedRoutes || config.typescript && !config.typescript.ignoreBuildErrors) throw new Error('TypeScript is enabled, but tsconfig.json does not exist.');
    } catch (error) { diagnostic('typescript', error, 'Correct typescript.tsconfigPath or the selected TypeScript configuration.'); }
    }
    if (project) {
    report.routes = project.routes.filter(route=>!route.internal).map(({pattern,kind,router})=>({pattern,kind,router:router||'pages'}));
    }
    const resolve = createRequire(path.join(root,'package.json'));
    for (const name of ['next','react','react-dom','react-server-dom-webpack']) {
      try { report.versions[name] = JSON.parse(await readFile(resolve.resolve(`${name}/package.json`),'utf8')).version; }
      catch { report.versions[name] = null; }
    }
    if (validateDependencies) {
      try {
        if (project?.routes.some(route=>route.router==='app')) await validateReactVersions(resolve);
        else {
          const names = ['react', 'react-dom'];
          if (names.some(name => report.versions[name] !== packageManifest.peerDependencies[name])) throw new Error(`Pages routes require the declared React peer versions. Resolved ${names.map(name => `${name}@${report.versions[name] || 'missing'}`).join(', ')}. Install ${names.map(name => `${name}@${packageManifest.peerDependencies[name]}`).join(' ')} in the application.`);
        }
      } catch (error) { diagnostic('react', error, 'Install the matching React protocol packages shown in this error.'); }
    } else report.notes.push('Installed React versions have not been validated yet; migration checks them after dependency installation.');
    if (validateEnvironment) {
      const diagnostics = await (services.environmentDiagnostics || environmentDiagnostics)();
      report.diagnostics.push(...diagnostics);
      report.errors.push(...diagnostics.filter(item => item.severity === 'error').map(item => item.message));
    }
    report.ok = report.errors.length === 0;
  } catch (error) { diagnostic('preflight', error, 'Resolve the reported file or installation error and retry.'); }
  finally { restore(); }
  return report;
}
