import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { loadEnvConfig, shouldWatchProjectFile } from './env.mjs';

async function fixture(files, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-env-'));
  try {
    for (const [name, value] of Object.entries(files)) await writeFile(path.join(root, name), value);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('env precedence, interpolation, quoting and process-owned values follow Next', async () => {
  await fixture({
    '.env': 'COMMON=base\nBASE_ONLY=yes\nEARLIER=$LATER\nLATER=expanded\nESCAPED=cost\\$5\nMULTI="one\\ntwo"\nSHELL=ignored\nURL=https://$HOST/$COMMON\n',
    '.env.production': 'COMMON=production\nPROD_ONLY=yes\n',
    '.env.local': 'COMMON=local\nLOCAL_ONLY=yes\n',
    '.env.production.local': 'COMMON=production-local\n',
  }, root => {
    const env = { NODE_ENV: 'production', HOST: 'example.test', SHELL: 'keep\\$literal' };
    const result = loadEnvConfig(root, { env });
    assert.equal(env.COMMON, 'production-local');
    assert.equal(env.URL, 'https://example.test/production-local');
    assert.equal(env.EARLIER, 'expanded');
    assert.equal(env.ESCAPED, 'cost$5');
    assert.equal(env.MULTI, 'one\ntwo');
    assert.equal(env.SHELL, 'keep\\$literal');
    assert.equal(env.BASE_ONLY, 'yes');
    assert.equal(env.PROD_ONLY, 'yes');
    assert.equal(env.LOCAL_ONLY, 'yes');
    assert.deepEqual(result.loadedEnvFiles, ['.env.production.local', '.env.local', '.env.production', '.env']);
  });
});

test('test mode skips .env.local and development/production files', async () => {
  await fixture({ '.env': 'BASE=yes', '.env.local': 'LOCAL=no', '.env.test': 'VALUE=test', '.env.test.local': 'VALUE=test-local', '.env.development': 'DEV=no', '.env.production': 'PROD=no' }, root => {
    const env = { NODE_ENV: 'test' };
    loadEnvConfig(root, { dev: true, env });
    assert.deepEqual(env, { NODE_ENV: 'test', VALUE: 'test-local', BASE: 'yes' });
  });
});

test('reload updates and removes file-owned values without removing caller overrides or leaking across projects', async () => {
  await fixture({ '.env': 'CHANGED=first\nREMOVED=old\nOVERRIDE=file\nSHELL=file' }, async first => {
    await fixture({ '.env': 'SECOND=yes' }, async second => {
      const env = { SHELL: 'caller', PRNEXT_CACHE_TOKEN: 'private' };
      loadEnvConfig(first, { env });
      env.OVERRIDE = 'caller-now';
      await writeFile(path.join(first, '.env'), 'CHANGED=second\nOVERRIDE=new-file');
      loadEnvConfig(first, { env });
      assert.equal(env.CHANGED, 'second');
      assert.equal(env.REMOVED, undefined);
      assert.equal(env.OVERRIDE, 'caller-now');
      loadEnvConfig(second, { env });
      assert.deepEqual(env, { SHELL: 'caller', PRNEXT_CACHE_TOKEN: 'private', OVERRIDE: 'caller-now', SECOND: 'yes' });
    });
  });
});

test('circular expansions fail explicitly and development watches root env files', async () => {
  await fixture({ '.env': 'ONE=$TWO\nTWO=$ONE' }, root => assert.throws(() => loadEnvConfig(root, { env: {} }), /circular references/));
  for (const filename of ['.env', '.env.local', '.env.development.local', '.env.test', 'next.config.ts', 'lib/config.js']) assert.equal(shouldWatchProjectFile(filename), true, filename);
  for (const filename of ['.prnext/manifest.json', '.prnext-config-123.mjs', 'node_modules/pkg/index.js', 'target/debug/build', '.git/config', 'nested/.env']) assert.equal(shouldWatchProjectFile(filename), false, filename);
});

test('worker chooses test env files before matching React mode to its built manifest', async () => {
  await fixture({ '.env.test': 'CONFIG_WORKER_PRIVATE=test-file', '.env.local': 'CONFIG_WORKER_PRIVATE=local-file', '.env.development.local': 'CONFIG_WORKER_PRIVATE=dev-file' }, async root => {
    await mkdir(path.join(root, '.prnext/runtime'), { recursive: true });
    await writeFile(path.join(root, '.prnext/runtime/api.mjs'), `const importedMode=process.env.NODE_ENV;export const runApi=async()=>({status:200,body:JSON.stringify({mode:importedMode,value:process.env.CONFIG_WORKER_PRIVATE})});`);
    await writeFile(path.join(root, '.prnext/runtime/http.mjs'), `export const errorResponse=()=>({status:500,body:'failed'});`);
    for (const [dev, nodeEnv, expected] of [[false, 'test', { mode: 'production', value: 'test-file' }], [true, 'production', { mode: 'development', value: 'dev-file' }]]) {
      await writeFile(path.join(root, '.prnext/manifest.json'), JSON.stringify({ dev, routes: [{ id: 'env', kind: 'api', module: 'server/api.mjs' }] }));
      const env = { ...process.env, NODE_ENV: nodeEnv };
      delete env.CONFIG_WORKER_PRIVATE;
      const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), root], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      worker.stdout.on('data', chunk => { stdout += chunk; });
      worker.stderr.on('data', chunk => { stderr += chunk; });
      worker.stdin.end(JSON.stringify({ id: 1, routeId: 'env', url: 'http://localhost/api' }) + '\n');
      const code = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
      assert.equal(code, 0, stderr);
      const response = JSON.parse(stdout);
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(Buffer.from(response.body, 'base64').toString()), expected);
    }
  });
});
