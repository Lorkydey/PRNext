import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, realpath, rm, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryRoot, freePort, binary } from '../support.mjs';
import { packNative } from '../../scripts/package-native.mjs';
import { executeNpm } from '../../packages/prnext/native/npm.mjs';
import { startReferencePostgres } from './postgres.mjs';
import { spawnReferenceProcess, runReferenceCommand } from './process.mjs';
import { startReferenceHttpsProxy } from './https-proxy.mjs';

export async function referenceFixture({ oidc, candidateArchive, preparedRoot, preserveInstallation = false, artifactsDirectory, onProgress = () => {} } = {}) {
  const root = preparedRoot ? path.resolve(preparedRoot) : await mkdtemp(path.join(tmpdir(), 'prnext-saas-consumer-'));
  const canonical = await realpath(root), canonicalTemp = await realpath(tmpdir());
  if (path.dirname(canonical) !== canonicalTemp || !path.basename(canonical).startsWith('prnext-saas-consumer-') || (await lstat(root)).isSymbolicLink()) throw new Error('Unexpected prepared reference consumer.');
  const source = path.join(repositoryRoot, 'examples/saas-reference');
  const artifacts = path.resolve(artifactsDirectory || path.join(repositoryRoot, 'artifacts/alpha019/reference'));
  await mkdir(artifacts, { recursive: true });
  let postgres, server, deployed, proxy, starting, closing = false;
  const assertOpen = () => { if (closing) throw new Error('Reference fixture is closing; a server cannot be started.'); };
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:PRNEXT_|NODE_PATH$|NODE_OPTIONS$|DATABASE_URL$|BETTER_AUTH_|OIDC_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/i.test(name)) delete env[name];
  const port = await freePort(), backendOrigin = 'http://127.0.0.1:' + port;
  const secret = randomBytes(32).toString('hex');
  let password = '';
  const redact = value => String(value).replaceAll(secret, '<redacted>').replaceAll(password || '\0', '<redacted>').replaceAll(oidc?.clientSecret || '\0', '<redacted>').replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '<database>');
  const run = async (args, cwd = root, timeout = 180000) => {
    try { return await runReferenceCommand(process.execPath, args, { cwd, env, timeout, maxBuffer: 8e6 }); }
    catch (error) {
      const diagnostic = redact('Reference command failed: ' + error.message + '\nExit code: ' + String(error.code ?? 'none') + '\n' + String(error.stdout || '') + '\n' + String(error.stderr || ''));
      await writeFile(path.join(artifacts, 'last-command.log'), diagnostic);
      console.error('Reference command failed. Redacted diagnostic (last 8000 characters):\n' + diagnostic.slice(-8000));
      throw new Error('Reference command failed; inspect artifacts/alpha019/reference/last-command.log.', { cause: { code: error.code } });
    }
  };
  const close = async () => {
    closing = true;
    // A pending standalone copy must finish before its owned directory is
    // removed. assertOpen prevents that operation from spawning afterwards.
    await starting?.catch(() => {});
    await proxy?.close();
    await server?.close();
    await postgres?.close();
    for (const directory of [!preserveInstallation && root, deployed].filter(Boolean)) {
      const resolved = await realpath(directory).catch(() => null);
      if (!resolved) continue;
      if (path.dirname(resolved) !== canonicalTemp || !path.basename(resolved).startsWith('prnext-saas-')) throw new Error('Unexpected reference fixture cleanup target.');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
  try {
    proxy = await startReferenceHttpsProxy(backendOrigin);
    const origin = proxy.origin;
    if (!preparedRoot) await cp(source, root, { recursive: true, filter: filename => {
      const relative = path.relative(source, filename).split(path.sep);
      return !relative.some(part => ['node_modules', '.prnext', '.prnext-cache', '.git'].includes(part) || part.startsWith('.prnext-') || part.startsWith('.env') && part !== '.env.example');
    } });
    const archives = path.join(artifacts, 'archives');
    await mkdir(archives, { recursive: true });
    onProgress('Packing matching framework and native archives.');
    const native = await packNative({ binary, out: archives });
    if (!candidateArchive) {
      const packed = await executeNpm(['pack', './packages/prnext', '--json', '--ignore-scripts', '--pack-destination', archives], { cwd: repositoryRoot, env, timeout: 60000 });
      candidateArchive = path.join(archives, JSON.parse(packed.stdout)[0].filename);
    }
    if (!preparedRoot) {
      onProgress('Installing the independent locked application.');
      await executeNpm(['ci', '--workspaces=false', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env, timeout: 180000, maxBuffer: 2e6 });
      onProgress('Installing the exact candidate archives.');
      await executeNpm(['install', '--workspaces=false', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', path.resolve(candidateArchive), native.tarball], { cwd: root, env, timeout: 180000, maxBuffer: 2e6 });
    } else onProgress('Reusing an owned consumer for diagnosis; this is not a clean qualification.');
    const resolve = createRequire(path.join(root, 'package.json'));
    const manifestPath = resolve.resolve('@thomas.f/prnext/package.json');
    assert.equal((await lstat(path.dirname(manifestPath))).isSymbolicLink(), false);
    assert.ok((await realpath(manifestPath)).startsWith(canonical + path.sep));
    const cli = path.join(path.dirname(manifestPath), 'cli.mjs');
    const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
    const evidence = {
      framework: { archive: path.basename(candidateArchive), sha256: await digest(candidateArchive), packageVersion: JSON.parse(await readFile(manifestPath, 'utf8')).version },
      native: { archive: path.basename(native.tarball), sha256: await digest(native.tarball) },
      applicationLockSha256: await digest(path.join(root, 'package-lock.json')),
      reusedInstallation: !!preparedRoot,
    };
    // Exact source equality catches accidental workspace/registry fallback.
    for (const file of ['cli.mjs', 'runtime/app-client.mjs', 'build/migration-audit.mjs']) {
      assert.equal(createHash('sha256').update(await readFile(path.join(path.dirname(manifestPath), file))).digest('hex'), createHash('sha256').update(await readFile(path.join(repositoryRoot, 'packages/prnext', file))).digest('hex'), file);
    }
    onProgress('Starting isolated PostgreSQL.');
    postgres = await startReferencePostgres();
    password = new URL(postgres.url).password;
    Object.assign(env, { NODE_ENV: 'production', DATABASE_URL: postgres.url, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret });
    if (oidc) Object.assign(env, { OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: oidc.clientId, OIDC_CLIENT_SECRET: oidc.clientSecret });
    onProgress('Initializing the reference database schema.');
    await run(['scripts/setup.mjs']);
    return {
      root, env, run, origin, backendOrigin, cli, evidence, proxyRequests: proxy.metrics,
      async build() { onProgress('Building the independently installed candidate.'); const started = performance.now(); await run([cli, 'build', '.']); onProgress('Candidate build completed in ' + Math.round(performance.now() - started) + ' ms.'); },
      start({ standalone = false, workers = 2, removeSource = false } = {}) {
        assertOpen();
        if (starting) throw new Error('A reference server is already starting.');
        starting = (async () => {
        let args, cwd;
        if (standalone) {
          deployed = await mkdtemp(path.join(tmpdir(), 'prnext-saas-deployed-'));
          assertOpen();
          await cp(path.join(root, '.prnext/standalone'), deployed, { recursive: true, verbatimSymlinks: true });
          assertOpen();
          if (removeSource && preserveInstallation) onProgress('Diagnostic replay retains its source; a clean qualification must remove it.');
          if (removeSource && !preserveInstallation) {
            if (await realpath(root) !== canonical || path.dirname(canonical) !== canonicalTemp) throw new Error('Unexpected reference source cleanup target.');
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          }
          args = [path.join(deployed, 'server.js')]; cwd = deployed;
        } else { args = [cli, 'start', '.', '--hostname', '127.0.0.1', '--port', String(port), '--workers', String(workers)]; cwd = root; }
        assertOpen();
        const owned = spawnReferenceProcess(process.execPath, args, { cwd, env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1', PRNEXT_WORKERS: String(workers) }, stdio: ['ignore', 'pipe', 'pipe'] });
        const { child } = owned;
        let output = '', startupError;
        child.once('error', error => { startupError = error; });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-80000); });
        const stop = owned.stop;
        server = { close: stop, output: () => redact(output) };
        for (let attempt = 0; attempt < 200; attempt++) {
          assertOpen();
          if (startupError || child.exitCode !== null) {
            await writeFile(path.join(artifacts, 'last-server.log'), redact(output));
            await stop(); throw new Error('Reference server could not start; inspect its redacted log.');
          }
          try { if ((await fetch(backendOrigin + '/en', { signal: AbortSignal.timeout(1000) })).status === 200) return server; } catch {}
          await delay(100);
        }
        await writeFile(path.join(artifacts, 'last-server.log'), redact(output));
        await stop(); throw new Error('Reference server did not become ready.');
        })();
        return starting.finally(() => { starting = undefined; });
      },
      async stop() { await server?.close(); server = undefined; },
      async writeServerLog() { if (server) await writeFile(path.join(artifacts, 'last-server.log'), server.output()); },
      async pool({ max = 1 } = {}) {
        if (!Number.isInteger(max) || max < 1 || max > 4) throw new Error('Unexpected reference pool budget.');
        const { default: pg } = await import(pathToFileURL(resolve.resolve('pg')).href);
        return new pg.Pool({ connectionString: postgres.url, max, connectionTimeoutMillis: 3000, query_timeout: 5000 });
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
