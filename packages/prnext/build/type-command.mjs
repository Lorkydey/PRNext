import path from 'node:path';
import { createRequire } from 'node:module';
import { loadProjectConfig } from './config.mjs';
import { scanProject } from './scan.mjs';
import { writeTypedRoutes } from './typed-routes.mjs';
import { checkTypeScript, projectTsconfig } from './typescript.mjs';
import { snapshotEnvConfig } from '../runtime/env.mjs';

/** Generate/check from route discovery only; no bundler, native server or install. */
export async function runTypeCommand(directory, { check = false } = {}) {
  const root = path.resolve(directory);
  const report = { version: 1, root, command: check ? 'typecheck' : 'typegen', ok: false, typedRoutes: false,
    tsconfig: null, routes: 0, updated: [], configUpdates: [], notes: [], errors: [] };
  const restore = snapshotEnvConfig();
  try {
    const config = await loadProjectConfig(root);
    const tsconfig = await projectTsconfig(root, config);
    if (!tsconfig) throw new Error('Type commands require an existing tsconfig.json, or typescript.tsconfigPath pointing to an existing configuration.');
    const resolve = createRequire(path.join(root, 'package.json'));
    try { resolve.resolve('typescript'); }
    catch { throw new Error('Install typescript as a dev dependency in the application before running typegen or typecheck.'); }
    report.tsconfig = path.relative(root, tsconfig).replaceAll(path.sep, '/');
    // Explicit type commands opt into route generation unless the application
    // explicitly disables it. A clean checkout gets fresh declarations first.
    report.typedRoutes = config.typedRoutes !== false;
    const project = await scanProject(root, { basePath: config.basePath, pageExtensions: config.pageExtensions, i18n: config.i18n });
    report.routes = project.routes.filter(route => route.kind === 'page' && !route.internal && !route.errorStatus).length;
    const updates = await writeTypedRoutes(root, project, { ...config, typedRoutes: report.typedRoutes });
    report.updated = (updates || []).map(file => path.relative(root, file).replaceAll(path.sep, '/')).sort();
    report.configUpdates = report.updated.filter(file => file === report.tsconfig || file === 'prnext-env.d.ts');
    if (report.configUpdates.length) report.notes.push('Updated the selected tsconfig roots/Next type aliases and/or prnext-env.d.ts to include generated declarations. Existing JSONC comments and inherited settings are preserved.');
    if (!report.typedRoutes) report.notes.push('Route declarations are disabled by typedRoutes: false; application TypeScript is still checked by typecheck.');
    if (check) {
      await checkTypeScript(root, config, { tsconfig, force: true });
      if (config.typescript?.ignoreBuildErrors) report.notes.push('typecheck checks errors even when typescript.ignoreBuildErrors is enabled for builds.');
    }
    report.ok = true;
  } catch (error) { report.errors.push(error.message); }
  finally { restore(); }
  return report;
}
