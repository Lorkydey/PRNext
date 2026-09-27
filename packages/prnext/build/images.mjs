import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { validateImagesConfig } from './images-config.mjs';
import { resolveNativeBinary } from '../native/resolve.mjs';
const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const imageExtension = /\.(?:png|jpe?g|webp|avif|gif|ico|bmp|tiff?|svg)$/i;
export async function createImages({ projectRoot, stage, assetBase, config: input }) {
  // Project configuration is already normalized, including generated static/CDN patterns.
  const config = input || validateImagesConfig();
  const cache = new Map();
  let active = 0;
  const waiting = [];
  async function bounded(operation) {
    if (active >= 2) await new Promise(resolve => waiting.push(resolve));
    active++;
    try { return await operation(); }
    finally { active--; waiting.shift()?.(); }
  }
  const configured = path.join(stage, 'compat', 'image-config.cjs');
  await mkdir(path.dirname(configured), { recursive: true });
  const clientConfig = { deviceSizes: config.deviceSizes, imageSizes: config.imageSizes, qualities: config.qualities, path: config.path, loader: config.loader, unoptimized: config.unoptimized, dangerouslyAllowSVG: config.dangerouslyAllowSVG, localPatterns: config.localPatterns, remotePatterns: config.remotePatterns, domains: config.domains };
  let loaderSource = '';
  if (config.loaderFile) {
    const file = await realpath(path.resolve(projectRoot, config.loaderFile));
    const root = await realpath(projectRoot);
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error('images.loaderFile must be inside the project');
    loaderSource = `\nconst custom=require(${JSON.stringify(file)});module.exports.customLoader=custom.default||custom;`;
  }
  await writeFile(configured, `'use strict';module.exports=${JSON.stringify(clientConfig)};${loaderSource}\n`);
  if (loaderSource) {
    const result = await bundle({ entryPoints: [configured], bundle: true, write: false, format: 'cjs', platform: 'neutral', target: 'es2022', logLevel: 'silent' });
    await writeFile(configured, result.outputFiles[0].contents);
  }
  const files = new Map();
  async function loadFile(filename) {
    const size = (await stat(filename)).size;
    if (size > 50_000_000) throw new Error(`Static image exceeds 50 MB: ${filename}`);
    const bytes = await readFile(filename);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
    const extension = path.extname(filename).toLowerCase();
    const key = hash + extension;
    if (!cache.has(key)) cache.set(key, (async () => {
      let info;
      if (extension === '.svg') {
        const source = bytes.toString('utf8');
        const svg = /<svg\b([^>]*)>/i.exec(source)?.[1] || '';
        const attribute = name => new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(svg)?.[1];
        const viewbox = (attribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        const dimension = name => /^\d+(?:\.\d+)?(?:px)?$/.test(attribute(name) || '') ? parseFloat(attribute(name)) : undefined;
        info = { width: dimension('width') || viewbox[2], height: dimension('height') || viewbox[3] };
        if (!info.width || !info.height) throw new Error(`Static SVG ${filename} requires dimensions or a viewBox`);
      } else {
        const binary = await resolveNativeBinary();
        const { stdout } = await execute(binary, ['image-info', filename], { timeout: 30_000, maxBuffer: 64 * 1024 });
        info = JSON.parse(stdout);
      }
      const name = `image-${hash}${extension}`;
      await mkdir(path.join(stage, 'assets'), { recursive: true });
      await writeFile(path.join(stage, 'assets', name), bytes);
      return { src: `${assetBase}/${name}`, ...info };
    })());
    return cache.get(key);
  }
  function load(filename) {
    if (!files.has(filename)) files.set(filename, bounded(() => loadFile(filename)));
    return files.get(filename);
  }
  return { plugin() { return { name: 'prnext-images', setup(build) {
    build.onResolve({ filter: /(?:^|\/)image-config\.cjs$/ }, args => args.importer && path.resolve(args.importer) === path.join(packageRoot, 'compat/image-shared.cjs') ? { path: configured } : undefined);
    if (config.disableStaticImages) return;
    build.onResolve({ filter: imageExtension }, async args => {
      if (args.kind !== 'import-statement' && args.kind !== 'require-call' && args.kind !== 'dynamic-import') return;
      if (args.pluginData?.prnextImageResolve) return;
      const result = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { ...args.pluginData, prnextImageResolve: true } });
      if (result.errors.length || result.external || !result.path) return;
      return { path: result.path, namespace: 'prnext-image' };
    });
    build.onLoad({ filter: /.*/, namespace: 'prnext-image' }, async args => ({ contents: `export default ${JSON.stringify(await load(args.path))};`, loader: 'js', watchFiles: [args.path] }));
  } }; } };
}
