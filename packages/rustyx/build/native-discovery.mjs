import { readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Inspect only packages reached through imports and declared runtime dependencies. */
export function createNativeDiscovery({ projectRoot, isClientSource }) {
  const metadata = new Map();
  const packageRoots = new Map();
  const packageFiles = new Map();
  const dependencyRoots = new Map();
  const clientBoundaries = new Map();

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
            if (/\.(?:[cm]?js|jsx|tsx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) result.sources.push(file);
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
    canExternalizeDirectory,
    async externalOwner(file, mode) {
      const owner = await packageFor(file);
      if (!owner) return;
      const application = path.relative(owner.directory, projectRoot);
      if (application === '' || (!application.startsWith('..' + path.sep) && application !== '..' && !path.isAbsolute(application))) return;
      if (!await nativeReachable(owner)) return;
      // Keep CSS extraction and Server Component client-reference transforms in
      // the compiler. A native dependency imported by this package is examined
      // separately when its own entry is resolved.
      if (!await canExternalizeDirectory(owner.directory, mode)) return;
      if (!/\.[cm]?js$/.test(file)) return;
      return { directory: owner.directory, name: owner.name };
    },
  };
}
