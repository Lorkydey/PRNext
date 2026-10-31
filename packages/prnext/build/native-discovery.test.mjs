import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createNativeDiscovery } from './native-discovery.mjs';

test('native discovery keeps computed loaders in .cts and .mts in its conservative boundary', async () => {
  for (const extension of ['cjs', 'cts', 'mts']) {
    const root = await mkdtemp(path.join(tmpdir(), 'prnext-native-discovery-'));
    const put = async (file, source) => { const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source); };
    try {
      await put('package.json', '{"name":"application"}');
      await put('node_modules/wrapper/package.json', '{"name":"wrapper","main":"index.mjs","dependencies":{"native-leaf":"1.0.0"}}');
      await put('node_modules/wrapper/index.mjs', `import './loader.${extension}';export default 1;`);
      await put('node_modules/wrapper/loader.' + extension, extension === 'cjs'
        ? `const id=['native','leaf'].join('-');exports.load=()=>require(id);`
        : `const id:string=['native','leaf'].join('-');export const load=()=>require(id);`);
      await put('node_modules/wrapper/unused.d.' + (extension === 'cjs' ? 'ts' : extension), `'use client';declare const unused:string;`);
      await put('node_modules/native-leaf/package.json', '{"name":"native-leaf","main":"index.cjs"}');
      await put('node_modules/native-leaf/index.cjs', 'module.exports=require("./binding.node");');
      await put('node_modules/native-leaf/binding.node', 'not executed');
      const discovery = createNativeDiscovery({ projectRoot: root, isClientSource: source => source.includes('use client') });
      let owner;
      await build({ stdin: { contents: '', resolveDir: root }, bundle: true, write: false, platform: 'node', logLevel: 'silent', plugins: [{
        name: 'inspect-native-loader', setup(api) {
          discovery.setResolver('ssr', (name, importer, kind) => api.resolve(name, { importer, resolveDir: path.dirname(importer), kind }));
          api.onStart(async () => { owner = await discovery.externalOwner(path.join(root, 'node_modules/wrapper/index.mjs'), 'ssr'); });
        },
      }] });
      // This checks discovery, not Node's ability to execute TypeScript under
      // node_modules (which requires a separate package/runtime qualification).
      assert.equal(owner?.name, 'wrapper', extension);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
