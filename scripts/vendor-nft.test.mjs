import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {verifyVendoredNft} from './vendor-nft.mjs';

test('vendored tracer retains every upstream byte and resolves patched glob dependencies',async()=>{
  const result=await verifyVendoredNft();assert.ok(result.files>10);
  const require=createRequire(new URL('../packages/prnext/vendor/nft/out/index.js',import.meta.url));
  assert.equal(require('glob/package.json').version,'14.0.2');
  const globRequire=createRequire(require.resolve('glob'));
  assert.equal(globRequire('minimatch/package.json').version,'11.0.1');
  const manifest=JSON.parse(await readFile(new URL('../packages/prnext/package.json',import.meta.url)));
  assert.equal(manifest.dependencies['@vercel/nft'],undefined,'consumers must not reinstall the vulnerable transitive tree');
  assert.ok(manifest.files.includes('vendor/'));
});
