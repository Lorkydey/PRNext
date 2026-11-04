// Build the Node create() entry only. Consumers do not install all of fontkit's
// browser/CJS/source distributions or its separate dependency tree.
import {build, version as esbuildVersion} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir, mkdir, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {isMainModule} from './main-module.mjs';
import {verifyVendoredFontkit} from '../packages/prnext/release/fontkit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'packages/prnext/vendor/fontkit');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(path.sep).join('/');
const expected = Object.freeze({
  '@swc/helpers': '0.5.23', 'base64-js': '1.5.1', brotli: '1.3.3', clone: '2.1.2',
  dfa: '1.2.0', 'fast-deep-equal': '3.1.3', fontkit: '2.0.4', restructure: '3.0.2',
  'tiny-inflate': '1.0.3', tslib: '2.8.1', 'unicode-properties': '1.4.1', 'unicode-trie': '2.0.0',
});
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')));

export async function prepareFontkit({check = false, reviewUpstream = false} = {}) {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const result = await build({absWorkingDir: root,
    stdin: {contents: "import {create} from 'fontkit'; export {create};", resolveDir: root, sourcefile: 'prnext-fontkit-entry.mjs'},
    outfile: 'fontkit.mjs', bundle: true, format: 'esm', platform: 'node', target: 'node22',
    minify: true, legalComments: 'inline', write: false, metafile: true,
  });
  if (result.warnings.length) throw new Error('Review fontkit bundle warnings before distributing it.');
  if (result.metafile.outputs['fontkit.mjs'].imports.some(item => !['fs', 'node:fs'].includes(item.path))) throw new Error('Unexpected fontkit runtime dependency.');
  const files = new Map([['index.mjs', result.outputFiles[0].contents]]);
  const inputs = {}, packages = {}, owners = new Map(), notices = new Set();
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    if (name === 'prnext-fontkit-entry.mjs') continue;
    const filename = path.resolve(root, name);
    const relative = slash(path.relative(root, filename));
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..')) throw new Error(`Unexpected fontkit source: ${name}`);
    const bytes = await readFile(filename);
    inputs[relative] = hash(bytes);
    for (const match of bytes.toString('utf8').matchAll(/\/\*[\s\S]*?\*\//g)) {
      if (/copyright|licensed under|@license|@preserve/i.test(match[0])) notices.add(match[0]);
    }
    let owner = path.dirname(filename);
    while (owner !== root) {
      try {
        const source = await readFile(path.join(owner, 'package.json'));
        const metadata = JSON.parse(source);
        if (metadata.name && metadata.version) {
          if (expected[metadata.name] !== metadata.version) throw new Error(`Review the fontkit dependency update before bundling: ${metadata.name}@${metadata.version}`);
          owners.set(owner, metadata);
          inputs[slash(path.relative(root, path.join(owner, 'package.json')))] = hash(source);
          break;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      owner = path.dirname(owner);
    }
    if (owner === root) throw new Error(`Missing fontkit source owner: ${name}`);
  }
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify([...owners.values()].map(value => value.name).sort())) throw new Error('The fontkit dependency set changed; review its licenses and update guard.');
  for (const [directory, metadata] of [...owners].sort(([, a], [, b]) => a.name.localeCompare(b.name, 'en'))) {
    const relative = slash(path.relative(root, directory));
    const record = lock.packages[relative];
    if (record?.version !== metadata.version || !/^sha512-/.test(record.integrity || '')) throw new Error(`Missing locked fontkit input integrity: ${metadata.name}`);
    const prefix = `licenses/${metadata.name.replaceAll('/', '__')}`;
    const names = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name));
    // Some upstream packages publish only their README's MIT declaration.
    // Preserve that declaration and metadata; do not invent copyright dates.
    if (!names.length) {
      const readme = (await readdir(directory)).find(name => /^readme(?:\.|$)/i.test(name));
      if (!readme) throw new Error(`No upstream license declaration found: ${metadata.name}`);
      names.push(readme);
    }
    for (const name of names.sort()) {
      const filename = path.join(directory, name);
      if (!(await lstat(filename)).isFile()) throw new Error(`Fontkit license is not a regular file: ${filename}`);
      const bytes = await readFile(filename);
      files.set(`${prefix}/${name}`, bytes);
      inputs[slash(path.relative(root, filename))] = hash(bytes);
    }
    packages[metadata.name] = {version: metadata.version, license: metadata.license, author: metadata.author,
      repository: metadata.repository, integrity: record.integrity};
  }
  files.set('SOURCE-NOTICES.txt', Buffer.from([...notices].sort().join('\n\n') + '\n'));
  files.set('NOTICE.txt', Buffer.from('Fontkit 2.0.4 Node create() bundle, generated by scripts/prepare-fontkit.mjs.\n' +
    'Upstream: https://github.com/foliojs/fontkit\n' +
    'The original code is bundled/minified without patches. Source copyright notices, dependency licenses, README license declarations and exact versions/integrities are retained alongside it.\n' +
    'fontkit, dfa and brotli declare MIT in their package metadata/README and publish no separate license file. brotli also contains Google Apache-2.0 source notices, retained in SOURCE-NOTICES.txt; the Apache-2.0 text is included with @swc/helpers.\n' +
    'Use upstream.json to audit/update this bundled dependency when security fixes are released.\n'));
  const provenance = {schemaVersion: 1, name: 'fontkit', version: expected.fontkit,
    tool: {name: 'esbuild', version: esbuildVersion}, packages: sorted(packages), inputs: sorted(inputs),
    files: sorted(Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])))};
  let previous;
  try { previous = JSON.parse(await readFile(path.join(destination, 'upstream.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!reviewUpstream && (!previous || JSON.stringify(previous.inputs) !== JSON.stringify(provenance.inputs)
      || JSON.stringify(previous.packages) !== JSON.stringify(provenance.packages)
      || JSON.stringify(previous.tool) !== JSON.stringify(provenance.tool))) throw new Error('Fontkit upstream inputs changed. Review the lockfile, licenses and security advisories, then use --review-upstream explicitly.');
  files.set('upstream.json', Buffer.from(JSON.stringify(provenance, null, 2) + '\n'));
  if (check) {
    await verifyVendoredFontkit();
    for (const [name, bytes] of files) {
      if (!(await readFile(path.join(destination, name))).equals(Buffer.from(bytes))) throw new Error(`Fontkit bundle is not reproducible: ${name}`);
    }
  } else {
    for (const [name, bytes] of files) { await mkdir(path.dirname(path.join(destination, name)), {recursive: true}); await writeFile(path.join(destination, name), bytes); }
    await verifyVendoredFontkit();
  }
  return {version: provenance.version, bytes: files.get('index.mjs').length, packages: owners.size, files: files.size};
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--review-upstream'].includes(arg))) throw new Error('Use prepare-fontkit.mjs [--check] [--review-upstream].');
  console.log(JSON.stringify(await prepareFontkit({check: args.includes('--check'), reviewUpstream: args.includes('--review-upstream')})));
}
