import { mkdir, readdir, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { compileApp } from './app.mjs';
import { configureCompiler } from './compiler.mjs';
import { createCssModules } from './css-modules.mjs';
import { createFonts } from './fonts.mjs';
import { createImages } from './images.mjs';
import { discardLazyBuild } from '../runtime/dev-lazy-staging.mjs';
import { loadEnvConfig } from '../runtime/env.mjs';

// Only the latest successful ordinary generation per project is reusable.
// This private compiler-process registry is not part of browser metadata or IPC.
const contexts = new Map();
const CONTEXT_LIMIT = 8, FILE_LIMIT = 16384, BYTE_LIMIT = 128 * 1024 * 1024;
export function forgetLazyBuildContext(root) {
  if (root === undefined) contexts.clear(); else contexts.delete(root);
}
export function rememberLazyBuildContext(root, { manifest, config, environment, tsconfig, envMode }) {
  contexts.delete(root);
  if (!manifest.devLazy || !manifest.dev || !config.experimental.lazyDynamicImports) return;
  while (contexts.size >= CONTEXT_LIMIT) contexts.delete(contexts.keys().next().value);
  contexts.set(root, { config, environment, tsconfig, envMode, cacheId: manifest.cacheId,
    buildId: manifest.buildId, session: manifest.devSession,
    manifestConfig: structuredClone(manifest.config) });
}
/** Reuse the validated configuration of the running generation, not its routes. */
export async function tryBuildLazyGraph(root, { base, request, devInputs, devSession,
  devActionSecret, incremental = true } = {}) {
  if (!base || typeof base.cacheId !== 'string' || !request) throw Error('Invalid deferred build generation');
  const context = contexts.get(root);
  // Compiler recycling loses its private context. The caller retains the ordinary
  // build path for this recovery case; it must never guess another generation.
  if (!context || context.cacheId !== base.cacheId || context.session !== devSession) return;
  // Preserve the running generation's env-file mode for supported build-time
  // hooks. The enclosing build() scope restores the caller's env on every exit.
  loadEnvConfig(root,{dev:true,mode:context.envMode,inputs:devInputs});
  const { config, environment, tsconfig } = context;
  const stage = path.join(root, '.prnext-build-' + randomUUID());
  try {
    await mkdir(path.join(stage, '.entries'), { recursive: true });
    const manifest = { version: 1, dev: true, buildId: context.buildId,
      cacheId: context.cacheId, devSession, config: structuredClone(context.manifestConfig),
      routes: [], prerendered: [] };
    const project = { root, routes: [] };
    configureCompiler({ config, root, stage, buildId: context.buildId, dev: true,
      incremental, devInputs, tsconfig, assetBase: manifest.config.assetBase });
    const fonts = createFonts({ projectRoot: root, stage, assetBase: manifest.config.assetBase });
    const cssModules = createCssModules({ projectRoot: root, stage,
      assetBase: manifest.config.assetBase, sassOptions: config.sassOptions,
      cssEngine: config.cssEngine, dev: true, config });
    const images = await createImages({ projectRoot: root, stage,
      assetBase: manifest.config.assetBase, config: config.images });
    await compileApp({ project, stage, manifest, cssModules, fonts, images, dev: true,
      devActionSecret, reactCompiler: config.reactCompiler, defineEnvironment: environment,
      moduleResolution: config.turbopack, serverExternalPackages: config.serverExternalPackages,
      lazyDynamicImports: true, devLazyRequest: request, devLazyOnly: true });
    const files = [];
    let bytes = 0;
    // This unpublished stage contains only this deferred graph, never other
    // routes or a copied framework runtime. Publication uses this exact receipt.
    for (const entry of await readdir(path.join(stage, 'assets'), { withFileTypes: true })) {
      if (!entry.isFile() || files.length >= FILE_LIMIT) throw Error('Invalid or excessive deferred output assets');
      const info = await lstat(path.join(stage, 'assets', entry.name));
      bytes += info.size;
      if (!info.isFile() || bytes > BYTE_LIMIT) throw Error('Deferred output exceeds the 128 MiB generation budget');
      files.push({ name: entry.name, bytes: info.size });
    }
    files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { ...manifest, outputDirectory: stage, devLazyTemporary: true,
      devLazyAssets: { version: 1, baseCacheId: context.cacheId, files } };
  } catch (error) {
    try { await discardLazyBuild(root, { outputDirectory: stage, devLazyTemporary: true }); }
    catch (cleanupError) { error.cleanupError = cleanupError; error.message += '; deferred compiler staging cleanup also failed'; }
    throw error;
  }
}
