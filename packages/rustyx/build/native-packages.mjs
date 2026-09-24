import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createNativeDiscovery } from './native-discovery.mjs';

function contains(directory, file) {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function packageAt(directory) {
  try {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    return typeof metadata.name === 'string' ? { directory, name: metadata.name } : undefined;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
}

/** Keep npm native loaders and their adjacent files under Node's package resolution. */
export function createNativePackages(projectRoot, { isClientSource }) {
  const discovery = createNativeDiscovery({ projectRoot, isClientSource });
  const external = new Map();
  const references = new Map();

  async function ownerOf(file) {
    // Externalize the outer package for nested node_modules so a transitive addon
    // remains resolvable from its original npm parent after deployment.
    const parts = file.split(path.sep);
    for (let index = 0; index < parts.length - 1; index++) {
      if (parts[index] !== 'node_modules') continue;
      const end = index + (parts[index + 1]?.startsWith('@') ? 3 : 2);
      const candidate = await packageAt(parts.slice(0, end).join(path.sep));
      if (candidate && contains(candidate.directory, file)) return candidate;
    }
    // Workspace packages may resolve through symlinks outside node_modules.
    for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
      if (directory === projectRoot) break;
      const candidate = await packageAt(directory);
      if (candidate && [...references.keys()].some(entry => contains(directory, entry))) return candidate;
    }
  }

  async function discoverOwner(file, mode) {
    const discovered = await discovery.externalOwner(file, mode);
    if (!discovered) return;
    const outer = await ownerOf(file);
    if (!outer || outer.directory === discovered.directory) return discovered;
    if (!await discovery.canExternalizeDirectory(outer.directory, mode)) {
      throw new Error(`Native npm dependency ${discovered.name} is nested inside ${outer.name}, which contains CSS or Client Components. Install ${discovered.name} as a direct application dependency so it can remain external without bypassing ${outer.name}'s compilation.`);
    }
    return outer;
  }

  function ownerFor(file) { return [...external.values()].find(owner => contains(owner.directory, file)); }

  return {
    get version() { return external.size; },
    assertCompatibleCss(cssFiles) {
      for (const css of cssFiles) {
        const owner = ownerFor(css);
        if (owner) throw new Error(`Native npm package ${owner.name} also imports CSS (${css}). Rustyx cannot yet externalize this mixed package for App Router rendering. Move the native dependency into a separate server-only npm package or a Pages API route.`);
      }
    },
    plugin(mode) {
      return {
        name: `rustyx-native-packages-${mode}`,
        setup(esbuild) {
          esbuild.onResolve({ filter: /\.node$/ }, async args => {
            if (args.pluginData?.rustyxNativeResolving) return;
            if (mode === 'browser') return { errors: [{ text: `Native Node addon ${args.path} cannot run in a Client Component (${args.importer}). Keep the native dependency in a Server Component or route handler.` }] };
            const resolved = await esbuild.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, pluginData: { rustyxNativeResolving: true } });
            if (resolved.errors.length) return resolved;
            const owner = await ownerOf(resolved.path);
            if (!owner) return { errors: [{ text: `Local native addon ${args.path} in ${args.importer} cannot be relocated by the App Router compiler. Package the addon and its loader as an npm dependency, then import that package by name.` }] };
            external.set(owner.directory, owner);
            return { errors: [{ text: `Native npm package ${owner.name} requires an external server import.` }] };
          });
          if (mode === 'browser') return;
          esbuild.onResolve({ filter: /.*/ }, async args => {
            if (args.pluginData?.rustyxNativeResolving || args.namespace !== 'file') return;
            if (path.isAbsolute(args.path)) {
              const reference = references.get(args.path);
              const owner = ownerFor(args.path) || (reference && await discoverOwner(args.path, mode));
              if (!owner) return;
              external.set(owner.directory, owner);
              if (!reference) return { errors: [{ text: `Native npm package ${owner.name} is imported using a filesystem path (${args.path}). Import its public npm entry by name so the deployed build can resolve its native files.` }] };
              return { path: reference.specifier, external: true };
            }
            if (args.path.startsWith('.') || args.path.startsWith('#')) return;
            const resolved = await esbuild.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, pluginData: { rustyxNativeResolving: true } });
            if (resolved.errors.length || resolved.external || resolved.namespace !== 'file') return resolved;
            references.set(resolved.path, { specifier: args.path, importer: args.importer });
            const owner = ownerFor(resolved.path) || await discoverOwner(resolved.path, mode);
            if (owner) {
              external.set(owner.directory, owner);
              return { path: args.path, external: true };
            }
            return resolved;
          });
        },
      };
    },
  };
}
