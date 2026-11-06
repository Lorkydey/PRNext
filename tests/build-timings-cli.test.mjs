import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {appFixture,repositoryRoot} from './support.mjs';

const execute=promisify(execFile);
const cli=path.join(repositoryRoot,'packages/prnext/cli.mjs');

test('CLI exposes private phase timings without putting them into the deployment manifest', {timeout:60000}, async t=>{
  const fixture=await appFixture();t.after(()=>fixture.remove());
  const {stdout}=await execute(process.execPath,[cli,'build',fixture.root,'--timings'],{timeout:45000,windowsHide:true,maxBuffer:1024*1024});
  assert.match(stdout,/Build timings \(milliseconds; nested phases are not additive\)/);
  assert.match(stdout,/configuration: \d+\.\d{2}/);
  assert.match(stdout,/runtime-bundle: \d+\.\d{2}/);
  assert.match(stdout,/total: \d+\.\d{2} \(excludes CLI module startup\)/);
  const manifest=JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
  assert.equal(Object.hasOwn(manifest,'buildTimings'),false);
});

test('CLI rejects ambiguous timing modes before building', async()=>{
  for(const[flags,pattern]of[
    [['--timings','--timings'],/Duplicate build option: --timings/],
    [['--timings','--watch'],/--timings reports one build/],
    [['--timings','--adapter','static'],/--timings requires the React build adapter/],
  ])await assert.rejects(execute(process.execPath,[cli,'build',repositoryRoot,...flags],{timeout:10000,windowsHide:true,maxBuffer:65536}),error=>pattern.test(error.stderr));
});
