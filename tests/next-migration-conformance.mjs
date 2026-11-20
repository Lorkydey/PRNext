import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { binary, repositoryRoot, startServer } from './support.mjs';
import { buildNextReference, linkNextReference, nextServer, referenceVersion } from './next-reference-support.mjs';

const framework = path.join(repositoryRoot, 'packages/prnext');
const cli = path.join(framework, 'cli.mjs');
const execute = promisify(execFile);

async function migrationFixture(name, t) {
  // Stay outside the framework workspace while using its Windows volume.
  const parent = path.dirname(repositoryRoot);
  const root = await mkdtemp(path.join(parent, 'migration-' + name + '-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await cp(path.join(repositoryRoot, 'examples/next-migration', name), root, {
    recursive: true,
    filter: file => !['node_modules', '.next', '.prnext'].includes(path.basename(file)),
  });
  const manifest = path.join(root, 'package.json');
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  pkg.dependencies.next = referenceVersion;
  const original = JSON.stringify(pkg, null, 2) + '\n';
  await writeFile(manifest, original);
  await mkdir(path.join(root, 'node_modules'));
  const reference = await linkNextReference(root);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  if (pkg.dependencies.clsx) {
    const clsx = path.join(repositoryRoot, 'node_modules/clsx');
    assert.equal(JSON.parse(await readFile(path.join(clsx, 'package.json'), 'utf8')).version, pkg.dependencies.clsx);
    await symlink(clsx, path.join(root, 'node_modules/clsx'), linkType);
  }
  const command = (...args) => execute(process.execPath, [cli, ...args], {
    cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 120000,
    env: { ...process.env, PRNEXT_BINARY: binary },
  });
  return {
    async upstream() {
      await buildNextReference(reference.cli, root);
      return nextServer(reference.cli, root);
    },
    async candidate() {
      const preview = JSON.parse((await command('migrate', '.', '--dry-run', '--no-install', '--json')).stdout);
      assert.equal(preview.status, 'preview');
      assert.deepEqual(preview.backups, []);
      assert.equal(await readFile(manifest, 'utf8'), original);
      const applied = JSON.parse((await command('migrate', '.', '--no-install', '--json')).stdout);
      assert.equal(applied.status, 'prepared');
      assert.equal(applied.installation.workspace, false);
      assert.equal(applied.backups.length, 1);
      assert.equal(await readFile(applied.backups[0], 'utf8'), original);
      const { dependencies, scripts } = JSON.parse(await readFile(manifest, 'utf8'));
      assert.equal(dependencies.next, referenceVersion);
      assert.ok(dependencies['@thomas.f/prnext']);
      assert.equal(dependencies['react-server-dom-webpack'], '19.3.1');
      assert.deepEqual([scripts.dev, scripts.build, scripts.start], ['prnext dev', 'prnext build', 'prnext start']);
      // Attach the exact candidate checkout without letting npm substitute the
      // published version. The independent SaaS drill verifies packed installs.
      await mkdir(path.join(root, 'node_modules/@thomas.f'));
      await symlink(framework, path.join(root, 'node_modules/@thomas.f/prnext'), linkType);
      await symlink(path.join(repositoryRoot, 'node_modules/react-server-dom-webpack'),
        path.join(root, 'node_modules/react-server-dom-webpack'), linkType);
      await command('check', '.');
      await command('build', '.');
      return startServer(root);
    },
  };
}

async function redirectContract(url, route, destination) {
  const response = await fetch(url + route, { redirect: 'manual' });
  await response.body?.cancel();
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get('location'), url).href, url + destination);
}

test('migration preserves a real App Router checkout action and cookie', { timeout: 180000 }, async t => {
  const fixture = await migrationFixture('boutique-node', t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const launch of [fixture.upstream, fixture.candidate]) {
    const { url, close } = await launch();
    const context = await browser.newContext();
    try {
      await redirectContract(url, '/ancien', '/produit/lampe');
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url + '/produit/lampe');
      await expect(page.getByRole('heading', { level: 1 })).toContainText(/lampe/i);
      await page.getByRole('button', { name: 'Réserver' }).click();
      await expect(page.getByRole('status')).toHaveText('Indiquez votre prénom');
      assert.equal((await context.cookies()).some(cookie => cookie.name === 'customer'), false);
      await page.getByLabel('Prénom', { exact: true }).fill('Camille');
      await page.getByRole('button', { name: 'Réserver' }).click();
      await expect(page.getByRole('status')).toHaveText('Merci Camille · nodejs');
      const customer = (await context.cookies(url)).find(cookie => cookie.name === 'customer');
      assert.ok(customer);
      assert.deepEqual({ value: customer.value, httpOnly: customer.httpOnly, path: customer.path }, {
        value: 'Camille', httpOnly: true, path: '/',
      });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await close();
    }
  }
});

test('migration preserves Pages Router cache reuse and on-demand ISR', { timeout: 180000 }, async t => {
  const fixture = await migrationFixture('documentation', t);
  for (const launch of [fixture.upstream, fixture.candidate]) {
    const { url, close } = await launch();
    try {
      const revision = async () => {
        const response = await fetch(url + '/revision');
        assert.equal(response.status, 200);
        const value = /data-testid="revision">([a-f\d-]+)<\/p>/.exec(await response.text())?.[1];
        assert.match(value || '', /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
        return value;
      };
      const original = await revision();
      assert.equal(await revision(), original);
      const invalid = await fetch(url + '/api/revalidate');
      assert.equal(invalid.status, 405);
      assert.deepEqual(await invalid.json(), { error: 'method' });
      assert.equal(await revision(), original);
      const refresh = await fetch(url + '/api/revalidate', { method: 'POST' });
      assert.equal(refresh.status, 200);
      assert.deepEqual(await refresh.json(), { revalidated: true });
      const updated = await revision();
      assert.notEqual(updated, original);
      assert.equal(await revision(), updated);
    } finally {
      await close();
    }
  }
});

test('migration preserves protected routes, proxy context and cookie isolation', { timeout: 180000 }, async t => {
  const fixture = await migrationFixture('portail', t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const launch of [fixture.upstream, fixture.candidate]) {
    const { url, close } = await launch();
    try {
      await redirectContract(url, '/prive', '/connexion');
      const visit = async name => {
        const context = await browser.newContext();
        try {
          await context.addCookies([{ name: 'access', value: 'yes', url }, { name: 'visitor', value: name, url }]);
          const page = await context.newPage();
          assert.equal((await page.goto(url + '/prive')).status(), 200);
          await expect(page.getByTestId('proxy-user')).toHaveText(name);
          assert.equal((await page.goto(url + '/stream')).status(), 200);
          await expect(page.getByTestId('stream-done')).toHaveText('Flux terminé ' + name);
        } finally {
          await context.close();
        }
      };
      await Promise.all([visit('Camille'), visit('Dominique')]);
      await redirectContract(url, '/prive', '/connexion');
    } finally {
      await close();
    }
  }
});
