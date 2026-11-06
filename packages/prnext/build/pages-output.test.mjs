import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {standaloneFixture} from '../../../tests/support.mjs';
import {build, disposeBuildSession} from './index.mjs';

test('Pages first-write chunk rewriting keeps shared imports, asset URLs and usable external maps', async () => {
  const fixture = await standaloneFixture('prnext-pages-buffer-output-');
  try {
    await writeFile(path.join(fixture.root, 'prnext.config.mjs'), "export default {basePath:'/docs',generateBuildId:()=> 'pages-buffer-test'};");
    await writeFile(path.join(fixture.root, 'shared.js'), "export const shared='SHARED_PAGES_VALUE';export const element=(value)=>value+'-shared';");
    await writeFile(path.join(fixture.root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    for (const name of ['a', 'b']) await writeFile(path.join(fixture.root, 'pages', name + '.jsx'), `import {shared,element} from '../shared.js';import image from '../logo.svg';export async function getServerSideProps(){return {props:{value:element(shared),image:image.src}};}export default function Page({value}){return <p>{value}</p>;}`);
    const result = await build(fixture.root, {dev: true});
    const written = JSON.parse(await readFile(path.join(result.outputDirectory, 'manifest.json'), 'utf8'));
    assert.equal(written.buildTimings, undefined, 'timings are programmatic diagnostics, never runtime manifest fields');
    assert.equal(result.buildTimings.scope, 'build-wall-time-excluding-module-startup');
    assert.equal(result.buildTimings.phases['pages-server'].calls, 1);
    const routes = result.routes.filter(route => ['/a', '/b'].includes(route.pattern));
    assert.equal(routes.length, 2);
    for (const route of routes) {
      const file = path.join(result.outputDirectory, route.module), source = await readFile(file, 'utf8');
      assert.ok(!/(?:from\s*|import\s*\()["']\/docs\/_prnext\/assets\/chunk-/.test(source), 'Node chunks cannot import an HTTP asset URL');
      const module = await import(pathToFileURL(file).href), props = await module.getServerSideProps();
      assert.equal(props.props.value, 'SHARED_PAGES_VALUE-shared');
      assert.match(props.props.image, /^\/docs\/_prnext\/assets\/.*\.svg$/);
      const map = JSON.parse(await readFile(file + '.map', 'utf8'));
      assert.equal(map.version, 3); assert.ok(map.sources.length); assert.ok(typeof map.mappings === 'string' && map.mappings.length);
    }
    const files = await readdir(path.join(result.outputDirectory, 'server'));
    assert.ok(files.some(file => file.startsWith('chunk-') && file.endsWith('.mjs')));
  } finally {await disposeBuildSession(fixture.root); await fixture.remove();}
});

test('failed configuration carries bounded build phase diagnostics without publishing output', async () => {
  const fixture = await standaloneFixture('prnext-build-phase-failure-');
  try {
    await mkdir(path.join(fixture.root, '.prnext'), {recursive: true});
    await writeFile(path.join(fixture.root, '.prnext/untouched.txt'), 'previous valid output');
    await writeFile(path.join(fixture.root, 'prnext.config.mjs'), 'export default {basePath:123};');
    await assert.rejects(build(fixture.root), error => {
      assert.match(error.message, /basePath/);
      assert.equal(error.buildTimings.phases.configuration.failedCalls, 1);
      assert.ok(Object.keys(error.buildTimings.phases).every(name => !name.includes(fixture.root)));
      return true;
    });
    assert.equal(await readFile(path.join(fixture.root, '.prnext/untouched.txt'), 'utf8'), 'previous valid output');
  } finally {await disposeBuildSession(fixture.root); await fixture.remove();}
});
