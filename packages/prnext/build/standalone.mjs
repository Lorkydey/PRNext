import { nodeFileTrace } from '@vercel/nft';
import resolver from '@vercel/nft/out/resolve-dependency.js';
import picomatch from 'picomatch';
import { mkdir, readFile, writeFile, readdir, realpath, readlink, stat, lstat, copyFile, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { resolveNativeBinary } from '../native/resolve.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const slash = value => value.split(path.sep).join('/');
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const maxFiles = 100_000;
const maxBytes = 2 * 1024 ** 3;

function patternsFor(rules, route) {
  return Object.entries(rules || {}).flatMap(([key, values]) => picomatch(key, { dot: true })(route) ? values : []);
}

async function* walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else yield file;
  }
}

// Resolve each configured pattern from its literal prefix, not by traversing a
// monorepo's entire dependency tree. Symlink directories are handled by NFT.
async function includedFiles(root, tracingRoot, patterns) {
  const output = new Set();
  for (const pattern of patterns) {
    const absolute = path.resolve(root, pattern);
    const parts = absolute.split(path.sep);
    const wildcard = parts.findIndex(part => /[*?{[(!+@]/.test(part));
    const prefix = wildcard < 0 ? absolute : parts.slice(0, wildcard).join(path.sep) || path.parse(root).root;
    if (!within(tracingRoot, prefix)) throw new Error(`Tracing include ${pattern} leaves outputFileTracingRoot.`);
    let info;
    try { info = await stat(prefix); } catch (error) { if (missing(error)) continue; throw error; }
    const match = picomatch(slash(absolute), { dot: true });
    if (info.isDirectory()) {
      let scanned = 0;
      for await (const file of walk(prefix)) {
        if (++scanned > maxFiles) throw new Error('Standalone include traverses more than 100000 files. Narrow its glob.');
        if (match(slash(file))) output.add(file);
      }
    } else if (match(slash(prefix))) output.add(prefix);
  }
  return output;
}

export async function createStandalone({ projectRoot, stage, manifest, config }) {
  if (config.output !== 'standalone' || manifest.dev) return;
  projectRoot = await realpath(projectRoot);
  stage = await realpath(stage);
  const tracingRoot = await realpath(config.outputFileTracingRoot || projectRoot);
  if (!within(tracingRoot, projectRoot)) throw new Error('outputFileTracingRoot must contain the application directory.');
  const appRelative = path.relative(tracingRoot, projectRoot);
  const output = path.join(stage, 'standalone');
  const appOutput = path.join(output, 'app', appRelative);
  const traceFiles = new Set();
  const manualFiles = new Set();
  const bridges = new Map();
  const packageRoots = new Map();
  const warnings = new Set();
  let omittedWarnings = 0;
  const cache = {};
  let traceReads = 0;
  let traceBytes = 0;

  function relocated(file) {
    if (within(stage, file)) return path.join(appOutput, config.distDir, path.relative(stage, file));
    if (within(tracingRoot, file)) return path.join(output, 'app', path.relative(tracingRoot, file));
    const offset = file.indexOf(`${path.sep}node_modules${path.sep}`);
    if (offset >= 0) {
      const anchor = file.slice(0, offset);
      const key = createHash('sha256').update(anchor).digest('hex').slice(0, 16);
      return path.join(output, 'dependencies', key, file.slice(offset + 1));
    }
    throw new Error(`Standalone trace ${file} is outside outputFileTracingRoot. Set that option to the shared workspace root.`);
  }

  async function packageRoot(filename, name) {
    const key = filename + '\0' + name;
    if (!packageRoots.has(key)) packageRoots.set(key, (async () => {
      for (let dir = path.dirname(filename); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        try {
          const metadata = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
          if (metadata.name === name || dir.endsWith(path.sep + 'node_modules' + path.sep + name.split('/').join(path.sep))) return dir;
        }
        catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error; }
      }
    })());
    return packageRoots.get(key);
  }

  async function trace(entries, route) {
    const excluded = patternsFor(config.outputFileTracingExcludes, route).map(value => picomatch(slash(path.resolve(projectRoot, value)), { dot: true }));
    for (const conditions of [['node'], ['node', 'react-server']]) {
      const result = await nodeFileTrace(entries, {
        base: path.parse(projectRoot).root, processCwd: projectRoot, conditions, cache, fileIOConcurrency: 16,
        ignore(file) { const absolute = path.resolve(path.parse(projectRoot).root, file); return !within(stage, absolute) && (excluded.some(match => match(slash(absolute))) || /^\.env(?:\.|$)/.test(path.basename(absolute))); },
        async readFile(file) {
          let info;
          try { info = await stat(file); } catch (error) { if (missing(error)) return null; throw error; }
          if (!info.isFile()) return null;
          if (++traceReads > maxFiles || info.size > 32 * 1024 ** 2 || (traceBytes += info.size) > 512 * 1024 ** 2) throw new Error('Standalone tracing exceeded its 100000 reads / 32 MiB file / 512 MiB source budget. Narrow tracing inputs.');
          return readFile(file);
        },
        async resolve(specifier, parent, job, cjs) {
          const resolved = await resolver.default(specifier, parent, job, cjs);
          if (!specifier.startsWith('.') && !specifier.startsWith('#') && !path.isAbsolute(specifier) && !specifier.startsWith('node:')) {
            const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
            for (const file of Array.isArray(resolved) ? resolved : [resolved]) {
              if (file.startsWith('node:')) continue;
              const owner = await packageRoot(file, name);
              if (owner) bridges.set(path.join(path.dirname(parent), 'node_modules', name), owner);
            }
          }
          return resolved;
        },
      });
      for (const file of result.fileList) traceFiles.add(path.resolve(path.parse(projectRoot).root, file));
      for (const warning of result.warnings) {
        const message = warning.message.replaceAll(projectRoot, '<project>').slice(0, 2048);
        if (warnings.has(message)) continue;
        if (warnings.size < 128) warnings.add(message); else omittedWarnings++;
      }
      if (traceFiles.size > maxFiles) throw new Error('Standalone trace exceeds 100000 files.');
    }
    for (const file of await includedFiles(projectRoot, tracingRoot, patternsFor(config.outputFileTracingIncludes, route))) if (!excluded.some(match => match(slash(file)))) { traceFiles.add(file); manualFiles.add(file); }
  }

  // Runtime imports are lazy and routes/client references are selected from the
  // manifest. Give NFT all these roots explicitly, including both React modes.
  const names = new Set(['worker', 'http']);
  if (manifest.routes.some(route => route.router !== 'app' && route.kind === 'page')) names.add('render');
  if (manifest.routes.some(route => route.kind === 'api')) { names.add('api'); names.add('route-static'); }
  if (manifest.routes.some(route => route.router === 'app' && route.kind === 'page')) for (const name of ['app-render', 'app-static', 'rsc-worker']) names.add(name);
  if (manifest.middleware) names.add('middleware');
  if (manifest.config.cacheHandler) names.add('incremental-cache');
  const runtimeRoots = [...names].map(name => path.join(stage, 'runtime', name + '.mjs'));
  if (names.has('app-render')) {
    // flightDecoder selects the production/development CJS decoder at runtime
    // after require.resolve(). NFT cannot infer that computed filename.
    const require = createRequire(path.join(stage, 'runtime/app-render.mjs'));
    runtimeRoots.push(require.resolve('react-server-dom-webpack/client.node'));
  }
  await trace(runtimeRoots, '/*');
  const groups = new Map();
  for (const route of manifest.routes) {
    const key = JSON.stringify([patternsFor(config.outputFileTracingIncludes, route.pattern), patternsFor(config.outputFileTracingExcludes, route.pattern)]);
    if (!groups.has(key)) groups.set(key, { entries: [], pattern: route.pattern });
    groups.get(key).entries.push(path.join(stage, route.module));
  }
  for (const { entries, pattern } of groups.values()) await trace(entries, pattern);
  const dynamicRoots = [...Object.values(manifest.app?.clientModules || {}).map(value => value.ssrModule),
    ...Object.values(manifest.app?.actions || {}).map(value => value.module),
    manifest.middleware?.module, manifest.config.cacheHandler, ...Object.values(manifest.config.cacheHandlers || {})]
    .filter(Boolean).map(file => path.join(stage, file));
  if (dynamicRoots.length) await trace(dynamicRoots, '/*');

  // Copy immutable build assets and public files regardless of trace exclusions.
  // Exclusions tune dependencies, never silently remove the server itself.
  for await (const file of walk(stage)) traceFiles.add(file);
  try { for await (const file of walk(path.join(projectRoot, 'public'))) { traceFiles.add(file); manualFiles.add(file); } }
  catch (error) { if (!missing(error)) throw error; }
  // Materialize symlink targets, including explicit includes/public directories
  // which did not go through NFT. All output links point within the artifact.
  for (const source of manualFiles) {
    if (!(await lstat(source)).isSymbolicLink()) continue;
    const target = await realpath(source);
    relocated(target);
    if ((await stat(target)).isDirectory()) {
      for await (const file of walk(target)) {
        traceFiles.add(file);
        manualFiles.add(file);
        if (traceFiles.size > maxFiles) throw new Error('Standalone trace exceeds 100000 files.');
      }
    } else traceFiles.add(target);
  }
  await mkdir(output, { recursive: true });
  let copiedBytes = 0;
  let copiedFiles = 0;
  const pendingLinks = [];
  for (const source of traceFiles) {
    const target = relocated(source);
    const info = await lstat(source);
    if (++copiedFiles > maxFiles || (copiedBytes += info.size) > maxBytes) throw new Error('Standalone output exceeds 100000 files / 2 GiB. Narrow tracing includes.');
    if (info.isSymbolicLink()) {
      const destination = await realpath(source);
      pendingLinks.push([target, relocated(destination)]);
      continue;
    }
    if (!info.isFile()) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const owners = new Set(bridges.values());
  const includedOwners = new Set();
  for (const file of traceFiles) for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) if (owners.has(dir)) includedOwners.add(dir);
  for (const [source, owner] of bridges) {
    // An excluded optional dependency must not be brought back by a bridge.
    if (!includedOwners.has(owner)) continue;
    pendingLinks.push([relocated(source), relocated(owner)]);
  }
  for (const [link, target] of pendingLinks) {
    if (link === target) continue;
    await mkdir(path.dirname(link), { recursive: true });
    try {
      const current = await lstat(link);
      if (current.isDirectory()) continue;
      if (current.isSymbolicLink() && path.resolve(path.dirname(link), await readlink(link)) === target) continue;
      throw new Error(`Conflicting standalone dependency at ${path.relative(output, link)}.`);
    } catch (error) { if (!missing(error)) throw error; }
    await symlink(path.relative(path.dirname(link), target), link, (await stat(target)).isDirectory() ? 'dir' : 'file');
  }
  const binaryName = process.platform === 'win32' ? 'prnext.exe' : 'prnext';
  const binary = await resolveNativeBinary();
  await mkdir(path.join(output, 'bin'), { recursive: true });
  await copyFile(binary, path.join(output, 'bin', binaryName));
  await chmod(path.join(output, 'bin', binaryName), 0o755);
  await mkdir(appOutput, { recursive: true });
  await writeFile(path.join(appOutput, '.prnext-output.json'), JSON.stringify({ distDir: config.distDir }) + '\n');
  // Preserve package type, imports/exports, self references and application
  // reads of its package metadata. Package scripts are never executed here.
  let packageJson = '{"private":true}\n';
  try { packageJson = await readFile(path.join(projectRoot, 'package.json'), 'utf8'); } catch (error) { if (!missing(error)) throw error; }
  await writeFile(path.join(appOutput, 'package.json'), packageJson);
  const relativeApp = slash(path.relative(output, appOutput));
  await writeFile(path.join(output, 'package.json'), '{"private":true,"type":"commonjs"}\n');
  await writeFile(path.join(output, 'server.js'), `'use strict';\nconst path=require('node:path');const {spawn}=require('node:child_process');\nconst root=path.join(__dirname,${JSON.stringify(relativeApp)});\nconst child=spawn(path.join(__dirname,'bin',${JSON.stringify(binaryName)}),['start',root,'--hostname',process.env.HOSTNAME||'0.0.0.0','--port',process.env.PORT||'3000','--workers',process.env.PRNEXT_WORKERS||'1','--node',process.execPath],{cwd:root,stdio:'inherit',env:{...process.env,NODE_ENV:'production'}});\nfor(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));\nchild.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1);});\n`);
  if (process.platform !== 'win32') {
    const quotedApp = "'" + relativeApp.replaceAll("'", "'\\''") + "'";
    await writeFile(path.join(output, 'start'), `#!/bin/sh\nset -eu\nSELF=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\ncd "$SELF/"${quotedApp}\nexec "$SELF/bin/prnext" start . --hostname "\${HOSTNAME:-0.0.0.0}" --port "\${PORT:-3000}" --workers "\${PRNEXT_WORKERS:-1}" --node "\${PRNEXT_NODE:-node}" "$@"\n`);
    await chmod(path.join(output, 'start'), 0o755);
  }
  await writeFile(path.join(output, 'standalone.json'), JSON.stringify({ version: 1, app: relativeApp, distDir: config.distDir, platform: process.platform, arch: process.arch, node: process.versions.node, nodeModulesABI: process.versions.modules, files: copiedFiles, bytes: copiedBytes, warnings: [...warnings], ...(omittedWarnings ? { omittedWarnings } : {}) }, null, 2) + '\n');
}
