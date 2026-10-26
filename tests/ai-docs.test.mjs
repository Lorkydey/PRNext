import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryRoot, startServer } from './support.mjs';
import { packageManifest } from '../packages/prnext/native/resolve.mjs';

const execute = promisify(execFile);
const cli = path.join(repositoryRoot, 'packages/prnext/cli.mjs');

test('bundled AI examples typecheck, build and serve routes, request data and a real form action', {timeout: 120_000}, async t => {
  const root = await mkdtemp(path.join(repositoryRoot, '.prnext-ai-examples-'));
  let server;
  t.after(async () => {
    await server?.close();
    await rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  });
  const put = async (file, content) => {
    assert.ok(!file.includes('..') && !path.isAbsolute(file));
    const target = path.join(root, file);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, content);
  };
  const files = new Set();
  for (const topic of ['quickstart', 'routing', 'data']) {
    const markdown = await readFile(path.join(repositoryRoot, `packages/prnext/docs/ai/${topic}.md`), 'utf8');
    if (topic === 'quickstart') {
      assert.ok(markdown.includes(`\`${packageManifest.engines.node}\``), 'Documented Node engines drifted.');
      for (const [name, version] of Object.entries(packageManifest.peerDependencies)) {
        assert.ok(markdown.includes(`${name}@${version}`), `Documented ${name} peer drifted.`);
      }
    }
    for (const [, file, content] of markdown.matchAll(/^### `([^`]+)`\r?\n\r?\n```\w+\r?\n([\s\S]*?)^```/gm)) {
      assert.ok(!files.has(file), `Duplicate documented file: ${file}`);
      files.add(file);
      await put(file, content);
    }
  }
  for (const file of ['package.json', 'tsconfig.json', 'prnext.config.mjs', 'app/layout.tsx', 'app/page.tsx',
    'app/products/[slug]/page.tsx', 'app/counter.tsx', 'lib/product-url.ts', 'app/api/health/route.ts',
    'app/preferences/actions.ts', 'app/preferences/page.tsx', 'lib/catalog.ts']) {
    assert.ok(files.has(file), `Missing executable documentation example: ${file}`);
  }
  // A tiny consumer composes the separately documented public-data/client examples.
  await put('app/examples/page.tsx', `import Counter from '../counter';import {readCatalog} from '../../lib/catalog';import {productUrl} from '../../lib/product-url';export default async function Examples(){const items=await readCatalog();return <main><Counter/><a href={productUrl}>{items[0].name}</a></main>}`);
  const run = args => execute(process.execPath, [cli, ...args, root, '--json'],
    {cwd: root, env: process.env, timeout: 60_000, maxBuffer: 4 * 1024 ** 2});
  assert.equal(JSON.parse((await run(['typecheck'])).stdout).ok, true);
  await execute(process.execPath, [cli, 'build', root], {cwd: root, env: process.env, timeout: 60_000, maxBuffer: 4 * 1024 ** 2});
  server = await startServer(root);
  const html = async (pathname, options) => {
    const response = await fetch(server.url + pathname, options);
    assert.equal(response.status, 200, await response.clone().text());
    return response.text();
  };
  assert.match(await html('/'), /Hello from PRNext/);
  const product = await html('/products/blue%20mug?ref=docs&ref=cli');
  assert.match(product, /blue mug/);
  assert.match(product, /docs, cli/);
  assert.deepEqual(await (await fetch(server.url + '/api/health')).json(), {ok: true});
  const examples = await html('/examples');
  assert.match(examples, /Demo product/);
  assert.match(examples, /href="\/products\/blue%20mug"/);
  assert.match(examples, /Count:/);
  const preferences = await html('/preferences');
  const actionId = /name="\$ACTION_ID_([^"]+)"/.exec(preferences)?.[1];
  assert.ok(actionId, 'SSR must emit an actionable progressive form.');
  const data = new URLSearchParams({[`$ACTION_ID_${actionId}`]: '', theme: 'dark'});
  const mutation = await fetch(server.url + '/preferences', {method: 'POST', headers: {origin: server.url}, body: data});
  assert.equal(mutation.status, 200, await mutation.clone().text());
  assert.match(mutation.headers.getSetCookie().join(';'), /theme=dark.*HttpOnly/i);
  await mutation.text();
  const saved = await html('/preferences', {headers: {cookie: 'theme=dark'}});
  assert.match(saved.replace(/<[^>]*>/g, ''), /Current theme:\s*dark/);
});
