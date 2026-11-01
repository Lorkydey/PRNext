import { readdir, readFile, realpath } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { analyzeSource } from './source-analysis.mjs';

const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);

/** Inspect only packages reached through imports and declared runtime dependencies. */
export function createNativeDiscovery({ projectRoot, isClientSource }) {
  const metadata = new Map();
  const packageRoots = new Map();
  const packageFiles = new Map();
  const dependencyRoots = new Map();
  const clientBoundaries = new Map();
  const sourceImports = new Map(), entryNative = new Map(), declaredNative = new Map();
  const resolvers = new Map();
  let sourceBytes = 0;
  const isApplication = directory => {
    const relative = path.relative(directory, projectRoot);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };

  function importsFor(file) {
    if (!sourceImports.has(file)) sourceImports.set(file, (async () => {
      if (!/\.(?:[cm]?[jt]s|jsx|tsx)$/.test(file) || /\.d\.[cm]?ts$/.test(file)) return { imports: [], computedRequire: false };
      const source = await readFile(file, 'utf8');
      const size = Buffer.byteLength(source);
      if (size > 8 * 1024 ** 2 || (sourceBytes += size) > 64 * 1024 ** 2) throw new Error('Native npm import analysis exceeds its 8 MiB file / 64 MiB source budget. Separate the native loader into a server-only package.');
      // The compiler accepts JSX in JavaScript npm entries, including .js.
      const { imports, computedRequire } = analyzeSource(source, /\.[cm]?js$/.test(file) ? file + '.jsx' : file);
      // Keep edges, not the AST, so the shared parser can bound its retained cache.
      return { imports, computedRequire };
    })());
    return sourceImports.get(file);
  }

  function readMetadata(directory) {
    if (!metadata.has(directory)) metadata.set(directory, readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }));
    return metadata.get(directory);
  }

  async function packageFor(file) {
    let directory = path.dirname(file);
    const visited = [];
    for (;;) {
      if (packageRoots.has(directory)) {
        const cached = packageRoots.get(directory);
        for (const current of visited) packageRoots.set(current, cached);
        return cached;
      }
      visited.push(directory);
      const info = await readMetadata(directory);
      if (typeof info?.name === 'string') {
        const result = { directory, name: info.name, metadata: info };
        for (const current of visited) packageRoots.set(current, result);
        return result;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  }

  function filesFor(directory) {
    if (!packageFiles.has(directory)) packageFiles.set(directory, (async () => {
      const result = { native: false, css: false, sources: [] };
      async function walk(current) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          const file = path.join(current, entry.name);
          // Follow declared dependencies independently; avoid walking symlinked
          // directories into another package or revisiting directory cycles.
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile() || entry.isSymbolicLink()) {
            if (entry.name.endsWith('.node')) result.native = true;
            if (/\.(?:css|scss|sass)$/i.test(entry.name)) result.css = true;
            if (/\.(?:[cm]?[jt]s|jsx|tsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) result.sources.push(file);
          }
        }
      }
      await walk(directory);
      return result;
    })());
    return packageFiles.get(directory);
  }

  async function resolveDependency(directory, name) {
    const key = directory + '\0' + name;
    if (!dependencyRoots.has(key)) dependencyRoots.set(key, (async () => {
      const require = createRequire(path.join(directory, 'package.json'));
      try {
        const file = require.resolve(name);
        if (path.isAbsolute(file)) return packageFor(file);
      } catch (error) {
        if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
      }
      // Packages with only conditional/subpath exports still have runtime
      // dependencies; locate their metadata without importing or evaluating them.
      for (const search of require.resolve.paths(name) || []) {
        const candidate = path.join(search, name);
        const info = await readMetadata(candidate);
        if (typeof info?.name === 'string') {
          const directory = await realpath(candidate);
          return { directory, name: info.name, metadata: info };
        }
      }
    })());
    return dependencyRoots.get(key);
  }

  async function nativeReachable(owner, visited = new Set()) {
    if (visited.has(owner.directory)) return false;
    visited.add(owner.directory);
    if ((await filesFor(owner.directory)).native) return true;
    const names = new Set([...Object.keys(owner.metadata.dependencies || {}), ...Object.keys(owner.metadata.optionalDependencies || {})]);
    for (const name of names) {
      const dependency = await resolveDependency(owner.directory, name);
      if (dependency && await nativeReachable(dependency, visited)) return true;
    }
    return false;
  }

  function declaredNativeFor(owner) {
    if (!declaredNative.has(owner.directory)) declaredNative.set(owner.directory, nativeReachable(owner));
    return declaredNative.get(owner.directory);
  }

  function nativeFromEntry(file, mode) {
    const key = mode + '\0' + file;
    if (!entryNative.has(key)) entryNative.set(key, (async () => {
      const pending = [file], visited = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        if (visited.size > 4096) throw new Error('Native npm import analysis exceeds 4096 reached modules. Separate the native loader into a server-only package.');
        const owner = await packageFor(current);
        if (!owner || isApplication(owner.directory)) continue;
        if ((await filesFor(owner.directory)).native) return true;
        const source = await importsFor(current);
        // A runtime loader may compute a declared package name. Preserve its
        // original npm boundary when that unknown name can reach an addon.
        if (source.computedRequire && await declaredNativeFor(owner)) return true;
        for (const dependency of source.imports) {
          if (builtins.has(dependency.path)) continue;
          const resolved = await resolvers.get(mode)(dependency.path, current, dependency.kind);
          if (!resolved.errors?.length && !resolved.external && resolved.namespace === 'file') pending.push(resolved.path);
        }
      }
      return false;
    })());
    return entryNative.get(key);
  }

  function hasClientBoundary(directory, sources) {
    if (!clientBoundaries.has(directory)) clientBoundaries.set(directory, (async () => {
      for (const file of sources) {
        const source = await readFile(file, 'utf8');
        if ((source.includes('use client') || source.includes('use server')) && isClientSource(source, file)) return true;
      }
      return false;
    })());
    return clientBoundaries.get(directory);
  }

  async function canExternalizeDirectory(directory, mode) {
    const ownFiles = await filesFor(directory);
    return !ownFiles.css && !await hasClientBoundary(directory, ownFiles.sources);
  }

  return {
    setResolver(mode, resolve) { resolvers.set(mode, resolve); },
    canExternalizeDirectory,
    async externalOwner(file, mode) {
      const owner = await packageFor(file);
      if (!owner) return;
      if (isApplication(owner.directory)) return;
      if (!await declaredNativeFor(owner)) return;
      // A package can declare build tools with native dependencies that its
      // runtime entry never imports (for example an i18n extractor). Follow
      // that entry's real compiler resolution before externalizing its parent.
      if (resolvers.has(mode) && !await nativeFromEntry(file, mode)) return;
      // Keep CSS extraction and Server Component client-reference transforms in
      // the compiler. A native dependency imported by this package is examined
      // separately when its own entry is resolved.
      if (!await canExternalizeDirectory(owner.directory, mode)) return;
      if (!/\.[cm]?js$/.test(file)) return;
      return { directory: owner.directory, name: owner.name };
    },
  };
}
