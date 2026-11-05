import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareNativePprShells} from './native-ppr.mjs';
import {nativePprArtifact, partialShell} from '../runtime/native-ppr.mjs';

test('native PPR pins exact public build bytes and never trusts HTTP-like flags', async () => {
  const stage = await mkdtemp(path.join(tmpdir(), 'prnext-native-ppr-'));
  try {
    await mkdir(path.join(stage, 'static'));
    const artifact = {version: 1, shell: '<html><head></head><body>Public shell</body></html>', postponed: {state: 1}, flight: 'opaque-flight', generatedAt: Date.now(), revalidate: false};
    await writeFile(path.join(stage, 'static/partial.json'), JSON.stringify(artifact));
    const route = {id: 'page', kind: 'page', router: 'app', pattern: '/', ppr: {'/': 'static/partial.json'}, client: '/bundle.js'};
    const manifest = {config: {nativePprShell: true, cacheComponents: true}, routes: [route]};
    await prepareNativePprShells(stage, manifest);
    const [descriptor] = manifest.config.nativePprArtifacts;
    assert.ok(descriptor);
    assert.equal(await readFile(path.join(stage, descriptor.prefix), 'utf8'), partialShell(artifact, route).replace(/<\/body><\/html>$/i, ''));
    const options = {manifest, route, url: 'http://localhost/', distDir: stage};
    assert.equal(await nativePprArtifact({...options, headers: {'x-prnext-native-ppr': descriptor.artifactHash}}), null);
    const renderMode = `native-ppr:${descriptor.artifactHash}`;
    assert.deepEqual((await nativePprArtifact({...options, renderMode})).artifact, artifact);
    await assert.rejects(nativePprArtifact({...options, renderMode, url: 'http://localhost/?private=true'}), /match the route/);
    await writeFile(path.join(stage, descriptor.artifact), JSON.stringify({...artifact, shell: 'changed'}));
    await assert.rejects(nativePprArtifact({...options, renderMode}), /changed after publication/);
    for (const change of [{middleware: {}}, {dev: true}, {config: {...manifest.config, basePath: '/base'}}, {config: {...manifest.config, cacheHandlers: {default: 'external'}}}]) {
      const candidate = {...manifest, ...change, config: {...manifest.config, ...change.config}};
      await prepareNativePprShells(stage, candidate);
      assert.equal(candidate.config.nativePprArtifacts, undefined);
    }
  } finally { await rm(stage, {recursive: true, force: true}); }
});
