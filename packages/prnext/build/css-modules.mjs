import { build as bundle } from 'esbuild';
import { mkdir, writeFile, realpath, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { createStyleProcessor, resolveStandardBrowserTargets, stylesheetPattern, moduleStylesheetPattern } from './styles.mjs';
import {rename} from '../runtime/fs.mjs';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {cachedCompilation} from './compilation-cache.mjs';

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
export function createCssModules({ projectRoot, stage, assetBase = '/_prnext/assets', sassOptions, cssEngine, dev = false, config = {} }) {
  const cache = new Map();
  let targets;
  const browserTargets=()=>targets ??= Promise.resolve().then(()=>resolveStandardBrowserTargets(projectRoot));
  const processor = createStyleProcessor({ projectRoot, sassOptions, cssEngine, browserTargets });
  const hash = file => createHash('sha256').update(path.relative(projectRoot, file).replaceAll(path.sep, '/')).digest('hex').slice(0, 12);
  let eligibility;
  async function cacheEligible() {
    if (dev || cssEngine==='postcss' || config.webpack || Object.keys(config.turbopack?.rules || {}).length || process.env.BROWSERSLIST_CONFIG || process.env.BROWSERSLIST_STATS || /\b(?:extends|stats)\b/i.test(process.env.BROWSERSLIST || '')) return false;
    // A user PostCSS plugin can read arbitrary files, glob directories or use
    // network/time without declaring dependencies. Its output is never cached.
    const names = await readdir(projectRoot);
    if (names.some(name => /^(?:postcss\.config|\.postcssrc)(?:\.|$)/.test(name))) return false;
    try { if (JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).postcss !== undefined) return false; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    return true;
  }
  const validMapping = value => {try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.values(parsed).every(value=>typeof value==='string');}catch{return false;}};
  const validResult = value => value && typeof value.mapping === 'string' && value.mapping.length <= 16*1024*1024 && validMapping(value.mapping) && typeof value.css === 'string' && value.css.length <= 16*1024*1024
    && Array.isArray(value.watchFiles) && value.watchFiles.length <= 4096 && value.watchFiles.every(file => typeof file==='string' && path.isAbsolute(file) && !file.includes('\0') && !/\.s[ac]ss$/i.test(file))
    && Array.isArray(value.assets) && value.assets.length <= 4096 && value.assets.every(asset => asset && typeof asset.name === 'string'
      && asset.name && asset.name === path.basename(asset.name) && !/[\\/\0<>:"|?*#]/.test(asset.name) && asset.name !== '.' && asset.name !== '..'
      && typeof asset.data === 'string' && asset.data.length<=24*1024*1024 && asset.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(asset.data))
    && new Set(value.assets.map(asset=>asset.name)).size===value.assets.length && value.assets.reduce((sum,asset)=>sum+asset.data.length,0)<=48*1024*1024;

  async function compile(file) {
    const dependencies=new Set([file]);
    const result = await bundle({
      absWorkingDir: projectRoot,
      stdin: { contents: `import styles from ${JSON.stringify(file)}; export default styles;`, resolveDir: projectRoot, loader: 'js' },
      outfile: path.join(stage, '.cssmodules', hash(file) + '.js'),
      bundle: true,
      write: false,
      metafile:true,
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
            for(const file of transformed.watchFiles)dependencies.add(file);
            return { contents: transformed.css, loader: 'local-css', resolveDir: path.dirname(args.pluginData.source), watchFiles: transformed.watchFiles };
          });
          esbuild.onLoad({ filter: stylesheetPattern, namespace: 'file' }, async args => {
            const transformed = await processor.process(args.path);
            for(const file of transformed.watchFiles)dependencies.add(file);
            return { contents: transformed.css, loader: 'css', resolveDir: path.dirname(args.path), watchFiles: transformed.watchFiles };
          });
          esbuild.onResolve({ filter: /^\// }, args => args.kind === 'url-token' ? { path: args.path, external: true } : undefined);
        },
      }],
    });
    const javascript = result.outputFiles.find(output => output.path.endsWith('.js'));
    const stylesheet = result.outputFiles.find(output => output.path.endsWith('.css'));
    for(const name of Object.keys(result.metafile.inputs))if(name!=='<stdin>'&&(!name.includes(':')||path.isAbsolute(name)))dependencies.add(path.resolve(projectRoot,name));
    if (!javascript || !stylesheet) throw new Error(`Unable to compile CSS Module ${file}.`);
    // This is esbuild's generated export map, whose only inputs are CSS files.
    // The isolated context deliberately has no require, process, network, or filesystem.
    const module = { exports: {} };
    runInNewContext(javascript.text, { module }, { timeout: 1000, filename: 'prnext-css-exports.cjs' });
    const mapping = JSON.stringify({ ...module.exports.default, ...(await processor.process(file)).exports });
    const assets = [];
    for (const output of result.outputFiles) {
      if (output === javascript || output === stylesheet) continue;
      assets.push({name:path.basename(output.path),data:Buffer.from(output.contents).toString('base64')});
    }
    return { mapping, css: stylesheet.text,watchFiles:[...dependencies],assets };
  }

  function get(file) {
    if (!cache.has(file)) cache.set(file, (async () => {
      eligibility ??= cacheEligible();
      const enabled = await eligibility && /\.css$/i.test(file);
      const result = await cachedCompilation({root:projectRoot,kind:'css-modules',inputs:[file],excluded:[path.resolve(projectRoot,config.distDir || '.prnext'),...(config.output==='export'?[path.join(projectRoot,'out')]:[])],styleTargets:true,settings:{file,assetBase,cssEngine:cssEngine || 'auto',...(enabled?{browserTargets:await browserTargets()}:{})},
        enabled,reason:dev?'development':'custom-style-pipeline',validate:validResult,
        bytes:value=>Buffer.byteLength(value.mapping)+Buffer.byteLength(value.css)+value.assets.reduce((sum,asset)=>sum+Buffer.byteLength(asset.data,'base64'),0),
        produce:async()=>{const value=await compile(file);return {value,dependencies:value.watchFiles};}});
      await mkdir(path.join(stage,'assets'),{recursive:true});
      for (const asset of result.assets) {
        const target=path.join(stage,'assets',asset.name),temporary=target+'.'+randomUUID()+'.tmp';
        try{await writeFile(temporary,Buffer.from(asset.data,'base64'));await rename(temporary,target);}finally{await rm(temporary,{force:true});}
      }
      // Keep the original public result and release replay-only binary payloads.
      // The per-build mapping cache must not retain a base64 copy of every asset.
      return {mapping:result.mapping,css:result.css,watchFiles:result.watchFiles};
    })());
    return cache.get(file);
  }

  return {
    compile:get,
    async mappings(){return Promise.all([...cache].map(async([file,result])=>({file,mapping:(await result).mapping,watchFiles:(await result).watchFiles})));},
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
