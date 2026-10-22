import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const outputs = ['dist', 'build', 'out', '.output/public'];
async function file(root, name) {
  try { const entry = await lstat(path.join(root, name)); return entry.isFile() && !entry.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

/** Root imports deliberately publish browser assets only, never a project tree. */
export function plainStaticPath(file, directory = false) {
  const parts = file.split('/'), name = parts.at(-1);
  if (parts.some(part => part.startsWith('.') && part !== '.well-known' ||
      /^(?:node_modules|server|api|functions|config|src|app|pages|components|lib|packages|tests?|coverage|dist|build|out)$/i.test(part))) return false;
  if (directory) return true;
  if (/(?:^|[.-])(?:config|server|test|spec)(?:[.-]|$)/i.test(name)) return false;
  if (parts[0] === '.well-known') return /\.(?:txt|json)$/.test(name);
  return /\.(?:html?|css|js|mjs|wasm|webmanifest|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|pdf)$/i.test(name) || /^(?:robots|ads|security)\.txt$/i.test(name);
}

/** Inspect metadata only; never execute a framework config or build command. */
export async function detectBuildAdapter(root, { prepared = false } = {}) {
  let manifest = {};
  try {
    const contents = await readFile(path.join(root, 'package.json'));
    if (contents.length > 256 * 1024) throw new Error('package.json exceeds 256 KiB');
    manifest = JSON.parse(contents);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid package.json');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deps = { ...manifest.devDependencies, ...manifest.dependencies };
  if ('next' in deps) return { adapter: 'react' };
  // A Vite index.html is source, and must not be mistaken for a completed site.
  const builder = ['vite', 'astro', '@sveltejs/kit', 'nuxt', 'react-scripts', '@angular/core', '@tanstack/react-start', '@tanstack/solid-start'].some(name => name in deps);
  if (!builder) for (const name of ['app', 'pages', 'src/app', 'src/pages']) {
    try { if ((await lstat(path.join(root, name))).isDirectory()) return { adapter: 'react' }; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  const script = manifest.scripts?.build;
  if (!builder && (!script || /^(?:prnext|prn) build(?:\s|$)/.test(script)) && await file(root, 'index.html')) return { adapter: 'static', from: '.' };
  if (prepared) {
    const found = [];
    for (const from of outputs) if (await file(root, from + '/index.html')) found.push(from);
    if (found.length > 1) throw new Error('Multiple static outputs found. Select one with --adapter static --from <directory>.');
    if (found.length === 1) return { adapter: 'static', from: found[0] };
    throw new Error('No completed browser build found. Run your framework build, then use --adapter static --from <directory>. Plain HTML sites need index.html at the root.');
  }
  return { adapter: 'react' };
}
