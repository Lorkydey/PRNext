import { build as bundle } from 'esbuild';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { createStyleProcessor, stylesheetPattern, moduleStylesheetPattern } from './styles.mjs';

const assetLoaders = Object.fromEntries(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'].map(ext => [ext, 'file']));

async function resolveCss(esbuild, args) {
  const result = await esbuild.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { prnextResolvingCss: true } });
  if (result.errors.length) return result;
  // Server packages are normally external, but a direct CSS import still needs compilation.
  if (result.external) {
    try { return { path: await realpath(createRequire(path.join(args.resolveDir, '__prnext_resolve.cjs')).resolve(args.path)) }; }
    catch (error) { return { errors: [{ text: error.message }] }; }
  }
  return { path: await realpath(result.path) };
}

/** One cached CSS compilation supplies identical class maps to the server and the browser. */
export function createCssModules({ projectRoot, stage, assetBase = '/_prnext/assets', sassOptions }) {
  const cache = new Map();
  const processor = createStyleProcessor({ projectRoot, sassOptions });
  const hash = file => createHash('sha256').update(path.relative(projectRoot, file).replaceAll(path.sep, '/')).digest('hex').slice(0, 12);

  async function compile(file) {
    const result = await bundle({
      absWorkingDir: projectRoot,
      stdin: { contents: `import styles from ${JSON.stringify(file)}; export default styles;`, resolveDir: projectRoot, loader: 'js' },
      outfile: path.join(stage, '.cssmodules', hash(file) + '.js'),
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      logLevel: 'silent',
      loader: assetLoaders,
      publicPath: assetBase,
      assetNames: '[name]-[hash]',
      // Preserve these identifiers; the final browser build may minify its JS freely.
      minifyIdentifiers: false,
      plugins: [{
        name: 'prnext-deterministic-css-identifiers',
        setup(esbuild) {
          esbuild.onResolve({ filter: moduleStylesheetPattern }, async args => {
            if (args.pluginData?.prnextResolvingCss || args.path.startsWith('prnext-css:')) return;
            const resolved = await resolveCss(esbuild, args);
            if (resolved.errors) return { errors: resolved.errors };
            const basename = path.basename(resolved.path).replace(/\.module\.(?:css|scss|sass)$/i, '').replace(/[^\w-]/g, '_');
            return { path: `r${hash(resolved.path)}_${basename}.module.css`, namespace: 'prnext-local-css', pluginData: { source: resolved.path } };
          });
          esbuild.onLoad({ filter: /.*/, namespace: 'prnext-local-css' }, async args => {
            const transformed = await processor.process(args.pluginData.source);
            return { contents: transformed.css, loader: 'local-css', resolveDir: path.dirname(args.pluginData.source), watchFiles: transformed.watchFiles };
          });
          esbuild.onLoad({ filter: stylesheetPattern, namespace: 'file' }, async args => {
            const transformed = await processor.process(args.path);
            return { contents: transformed.css, loader: 'css', resolveDir: path.dirname(args.path), watchFiles: transformed.watchFiles };
          });
          esbuild.onResolve({ filter: /^\// }, args => args.kind === 'url-token' ? { path: args.path, external: true } : undefined);
        },
      }],
    });
    const javascript = result.outputFiles.find(output => output.path.endsWith('.js'));
    const stylesheet = result.outputFiles.find(output => output.path.endsWith('.css'));
    if (!javascript || !stylesheet) throw new Error(`Unable to compile CSS Module ${file}.`);
    // This is esbuild's generated export map, whose only inputs are CSS files.
    // The isolated context deliberately has no require, process, network, or filesystem.
    const module = { exports: {} };
    runInNewContext(javascript.text, { module }, { timeout: 1000, filename: 'prnext-css-exports.cjs' });
    const mapping = JSON.stringify({ ...module.exports.default, ...(await processor.process(file)).exports });
    await mkdir(path.join(stage, 'assets'), { recursive: true });
    for (const output of result.outputFiles) {
      if (output === javascript || output === stylesheet) continue;
      await writeFile(path.join(stage, 'assets', path.basename(output.path)), output.contents);
    }
    return { mapping, css: stylesheet.text };
  }

  function get(file) {
    if (!cache.has(file)) cache.set(file, compile(file));
    return cache.get(file);
  }

  return {
    plugin(browser, { emitStyles = () => true } = {}) {
      return {
        name: 'prnext-shared-css-modules',
        setup(esbuild) {
          esbuild.onResolve({ filter: moduleStylesheetPattern }, async args => {
            if (args.pluginData?.prnextResolvingCss || args.path.startsWith('prnext-css:')) return;
            const resolved = await resolveCss(esbuild, args);
            if (resolved.errors) return { errors: resolved.errors };
            return { path: resolved.path, namespace: 'prnext-css-mapping' };
          });
          esbuild.onLoad({ filter: /.*/, namespace: 'prnext-css-mapping' }, async args => {
            const compiled = await get(args.path);
            return { contents: `${browser && emitStyles(args.path) ? `import ${JSON.stringify('prnext-css:' + args.path)};` : ''} export default ${compiled.mapping};`, loader: 'js' };
          });
          if (browser) {
            esbuild.onLoad({ filter: stylesheetPattern, namespace: 'file' }, async args => {
              const transformed = await processor.process(args.path);
              return { contents: transformed.css, loader: 'css', resolveDir: path.dirname(args.path), watchFiles: transformed.watchFiles };
            });
            esbuild.onResolve({ filter: /^prnext-css:/ }, args => ({ path: args.path.slice('prnext-css:'.length), namespace: 'prnext-compiled-css' }));
            esbuild.onLoad({ filter: /.*/, namespace: 'prnext-compiled-css' }, async args => ({ contents: (await get(args.path)).css, loader: 'css', resolveDir: path.dirname(args.path) }));
            esbuild.onResolve({ filter: /^\// }, args => args.kind === 'url-token' ? { path: args.path, external: true } : undefined);
          }
        },
      };
    },
  };
}
