import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('CLI dev rebuilds changed root env and config helpers before restarting its server', { timeout: 25_000 }, async () => {
  const root = await mkdtemp(fileURLToPath(new URL('../../../.prnext-dev-env-test-', import.meta.url)));
  let child;
  let output = '';
  try {
    await mkdir(path.join(root, 'pages'));
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, '.env.development.local'), 'NEXT_PUBLIC_DEV_ENV_TEST=first-env');
    await writeFile(path.join(root, 'config-helper.mjs'), `export default 'first-helper';`);
    await writeFile(path.join(root, 'next.config.mjs'), `import value from './config-helper.mjs';export default {env:{DEV_ENV_HELPER:value}};`);
    await writeFile(path.join(root, 'pages/index.jsx'), `export default function Page(){return <p>{process.env.NEXT_PUBLIC_DEV_ENV_TEST}:{process.env.DEV_ENV_HELPER}</p>}`);
    const executable = path.join(root, '.prnext-test-server.cjs');
    // The fixture observes launch/restart without binding sockets or depending
    // on the native compiler; the real CLI and production build pipeline run.
    await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(root, '.prnext-launches'))},process.pid+'\\n');process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>process.exit(1),22000);`, { mode: 0o755 });
    const env = { ...process.env, PRNEXT_BINARY: executable, NODE_ENV: 'development' };
    delete env.NEXT_PUBLIC_DEV_ENV_TEST;
    child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'dev', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    async function waitForBuild(count, expected) {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) assert.fail(`dev exited early: ${output}`);
        if (output.split('Source compiled.').length - 1 >= count) {
          const manifest = JSON.parse(await readFile(path.join(root, '.prnext/manifest.json'), 'utf8'));
          const html = await readFile(path.join(root, '.prnext', manifest.prerendered[0].file), 'utf8');
          if (expected.every(value => html.includes(value))) return manifest;
        }
        await delay(40);
      }
      assert.fail(`dev did not rebuild expected output ${expected.join(', ')}: ${output}`);
    }
    const first = await waitForBuild(1, ['first-env', 'first-helper']);
    await writeFile(path.join(root, '.env.development.local'), 'NEXT_PUBLIC_DEV_ENV_TEST=second-env');
    const second = await waitForBuild(2, ['second-env', 'first-helper']);
    assert.notEqual(second.buildId, first.buildId);
    await writeFile(path.join(root, 'config-helper.mjs'), `export default 'second-helper';`);
    await waitForBuild(3, ['second-env', 'second-helper']);
    // Launch occurs just before the CLI confirmation; allow the new process to
    // initialize its marker before checking that all three starts happened.
    for (let attempt = 0; attempt < 50; attempt++) {
      const launches = (await readFile(path.join(root, '.prnext-launches'), 'utf8')).trim().split('\n');
      if (launches.length >= 3) { assert.equal(new Set(launches).size, launches.length); return; }
      await delay(20);
    }
    assert.fail(`server did not restart after each rebuild: ${output}`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 6000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    await rm(root, { recursive: true, force: true });
  }
});
