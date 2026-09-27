// Compare production policies on one rebuilt application and native binary.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import presets from '../packages/prnext/runtime/profiles.json' with { type: 'json' };
import { sha } from './dynamic-benchmark/harness.mjs';

const output = path.resolve(process.env.RESOURCE_BENCH_OUTPUT || 'reports/runtime-profiles');
const variants = Object.keys(presets).map(name => ({ name, engine: 'candidate', env: name === 'compact' ? { PRNEXT_MEMORY_PROFILE: name } : { PRNEXT_PROFILE: name } }));
async function execute(script, args = [], environment = {}) {
  const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env: { ...process.env, RESOURCE_BENCH_OUTPUT: output, ...environment } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, script + ' failed');
}
const mode = process.argv[2] || 'run';
if (mode === 'snapshot' || mode === 'build') await execute('scripts/bench-runtime-resources.mjs', [mode]);
else if (mode === 'validate') {
  for (const name of ['next', ...variants.map(v => v.name)]) await execute('scripts/validate-runtime-resources.mjs', [name]);
} else {
  assert.ok(['run', 'pilot'].includes(mode));
  const sources = ['scripts/bench-profiles.mjs', 'scripts/bench-runtime-resources.mjs', 'scripts/validate-runtime-resources.mjs', 'scripts/bench-next-comparison.mjs', ...['fixture', 'protocol', 'load', 'backend', 'harness', 'parity', 'runner'].map(s => 'scripts/dynamic-benchmark/' + s + '.mjs')];
  await writeFile(path.join(output, mode === 'pilot' ? 'pilot-method.json' : 'method.json'), JSON.stringify({ createdAt: new Date().toISOString(), presets, machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramGiB: os.totalmem() / 1024 ** 3, os: os.platform(), arch: os.arch(), node: process.version }, sources: Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await readFile(file))]))) }, null, 2) + '\n');
  await execute('scripts/bench-runtime-resources.mjs', [], {
    RESOURCE_VARIANTS: JSON.stringify(variants), RESOURCE_SCENARIOS: 'ssr,stream',
    RESOURCE_REPETITIONS: mode === 'pilot' ? '1' : '3', RESOURCE_REQUIRE_PARITY: '1', RESOURCE_STRICT_PARITY: '1',
    RESOURCE_RESULT: mode === 'pilot' ? 'pilot-results.json' : 'final-results.json',
    RESOURCE_LOAD_PROFILES: JSON.stringify(mode === 'pilot' ? [{ id: 'concurrency-128', concurrency: 128, durationMs: 3000 }] : [
      { id: 'fixed-250', ratePerSecond: 250, concurrency: 32, durationMs: 6000 },
      { id: 'concurrency-128', concurrency: 128, durationMs: 4000 },
    ]), RESOURCE_PROFILE: '',
  });
}
