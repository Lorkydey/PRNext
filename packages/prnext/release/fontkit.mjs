import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const destination = fileURLToPath(new URL('../vendor/fontkit/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Validate the shipped inventory without loading fontkit or its build dependencies. */
export async function verifyVendoredFontkit(directory = destination) {
  const provenance = JSON.parse(await readFile(path.join(directory, 'upstream.json'), 'utf8'));
  if (provenance.schemaVersion !== 1 || provenance.name !== 'fontkit' || provenance.version !== '2.0.4'
      || provenance.tool?.name !== 'esbuild' || !provenance.files?.['index.mjs']
      || !provenance.files?.['NOTICE.txt'] || !provenance.files?.['SOURCE-NOTICES.txt']
      || !provenance.packages?.fontkit || !provenance.packages?.brotli) throw new Error('Incomplete fontkit provenance.');
  const actual = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name + '/');
      else if (!entry.isFile()) throw new Error('Vendored fontkit files must be regular files.');
      else if (name !== 'upstream.json') actual.push(name);
    }
  }
  await visit(directory);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(provenance.files).sort())) throw new Error('Vendored fontkit inventory changed.');
  for (const name of actual) {
    if (digest(await readFile(path.join(directory, name))) !== provenance.files[name]) throw new Error(`Vendored fontkit differs from its reviewed build: ${name}`);
  }
  return {version: provenance.version, files: actual.length, bytes: (await readFile(path.join(directory, 'index.mjs'))).length};
}
