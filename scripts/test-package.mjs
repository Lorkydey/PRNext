// Install the exact archives through a temporary loopback npm registry. No
// npm link, NODE_PATH, workspace node_modules, PRNEXT_BINARY or Cargo fallback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { packNative } from './package-native.mjs';
import { repositoryRoot } from './cargo.mjs';
import { packageManifest, nativePlatform, platforms } from '../packages/prnext/native/resolve.mjs';
import { archiveFilename, readArchive } from './verify-npm-artifacts.mjs';

const execute = promisify(execFile);
const log = message => console.log(`[package] ${message}`);
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (/^(?:PRNEXT_|RUSTYX_|NODE_PATH$|NODE_OPTIONS$|NPM_TOKEN$|NODE_AUTH_TOKEN$|npm_config_|npm_execpath$|npm_lifecycle_|npm_package_|INIT_CWD$)/i.test(key)) delete cleanEnv[key];

// npm metadata may encode the scope separator, while tarball requests usually
// contain it literally. Decode first and retain both segments of scoped names.
export function registryPackageName(pathname) {
  const parts = decodeURIComponent(pathname).replace(/^\//, '').split('/');
  return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export async function publishedNative({ out, target = nativePlatform(), fetcher = fetch } = {}) {
  const registry = 'https://registry.npmjs.org/';
  const metadataURL = `${registry}${encodeURIComponent(target.package)}/${encodeURIComponent(packageManifest.version)}`;
  const response = await fetcher(metadataURL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Published native metadata unavailable: ${target.package}@${packageManifest.version} (HTTP ${response.status})`);
  const pkg = await response.json();
  assert.equal(pkg.name, target.package, 'Published native name mismatch');
  assert.equal(pkg.version, packageManifest.version, 'Published native version mismatch');
  assert.deepEqual(pkg.os, [target.os], 'Published native OS mismatch');
  assert.deepEqual(pkg.cpu, [target.cpu], 'Published native CPU mismatch');
  if (target.libc) assert.deepEqual(pkg.libc, [target.libc], 'Published native libc mismatch');
  assert.match(pkg.dist?.integrity || '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Published native requires sha512 integrity');
  const tarballURL = new URL(pkg.dist.tarball);
  assert.equal(tarballURL.origin, new URL(registry).origin, 'Published native tarball must come from the npm registry');
  const archiveResponse = await fetcher(tarballURL.href, { signal: AbortSignal.timeout(60000) });
  if (!archiveResponse.ok) throw new Error(`Published native tarball unavailable (HTTP ${archiveResponse.status})`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.equal(integrity, pkg.dist.integrity, 'Published native archive integrity mismatch');
  const shasum = createHash('sha1').update(bytes).digest('hex');
  if (pkg.dist.shasum) assert.equal(shasum, pkg.dist.shasum, 'Published native archive shasum mismatch');
  const entries = readArchive(bytes);
  const packedManifest = JSON.parse(entries.get('package/package.json').data);
  for (const key of ['name', 'version', 'os', 'cpu', 'libc']) assert.deepEqual(packedManifest[key], pkg[key], `Published native tarball ${key} mismatch`);
  const binary = entries.get('package/bin/prnext');
  assert.ok(binary && (binary.mode & 0o111), 'Published native executable is missing or not executable');
  const nativeInfo = JSON.parse(entries.get('package/native.json')?.data || 'null');
  assert.equal(nativeInfo?.id, target.id, 'Published native target mismatch');
  assert.equal(nativeInfo.version, packageManifest.version, 'Published native descriptor version mismatch');
  assert.equal(nativeInfo.sha256, createHash('sha256').update(binary.data).digest('hex'), 'Published native executable digest mismatch');
  const filename = archiveFilename(target.package);
  const tarball = path.join(path.resolve(out), filename);
  await mkdir(path.dirname(tarball), { recursive: true });
  // Never replace a published version with a locally repacked equivalent.
  try { assert.ok((await readFile(tarball)).equals(bytes), `Existing ${filename} differs from the exact published archive; choose a fresh --out directory`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(tarball, bytes, { flag: 'wx' }); }
  return { name: target.package, version: packageManifest.version, filename, size: bytes.length, integrity, shasum, tarball, target: target.id, published: { registry, tarball: tarballURL.href, integrity } };
}

async function port() {
  const server = createProbe();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function serve(cwd, args, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', failure;
  child.stdout.on('data', data => { output = (output + data).slice(-60000); });
  child.stderr.on('data', data => { output = (output + data).slice(-60000); });
  child.on('error', error => { failure = error; });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  };
  return { close, output: () => output, assertAlive() { if (failure || child.exitCode !== null || child.signalCode) throw new Error(`Server exited: ${failure || child.exitCode}\n${output}`); } };
}

async function waitFor(server, url, pattern) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    server.assertAlive();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const html = await response.text();
      if (response.status === 200 && pattern.test(html)) return html;
    } catch {}
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}\n${server.output()}`);
}

export async function testPackage({ out, binary, strategy = 'hoisted', reusePublishedNative = false } = {}) {
  if (!['hoisted', 'nested'].includes(strategy)) throw new Error(`Unknown install strategy ${strategy}`);
  if (binary && reusePublishedNative) throw new Error('A local binary cannot be combined with --published-native');
  out = path.resolve(out || path.join(repositoryRoot, reusePublishedNative ? 'artifacts/npm-scoped' : 'artifacts/npm'));
  const temporary = await mkdtemp(path.join(tmpdir(), 'prnext-npm-isolated-'));
  const app = path.join(temporary, 'app with spaces');
  const env = { ...cleanEnv, npm_config_userconfig: path.join(temporary, 'empty.npmrc'), npm_config_audit: 'false', npm_config_fund: 'false' };
  const checks = [];
  const passed = name => { checks.push(name); log(name); };
  let registry, server;
  try {
    await writeFile(env.npm_config_userconfig, '');
    await mkdir(app);
    const native = reusePublishedNative ? await publishedNative({ out }) : await packNative({ out, binary });
    const result = await execute('npm', ['pack', '--workspace', packageManifest.name, '--json', '--ignore-scripts', '--pack-destination', path.resolve(out)], { cwd: repositoryRoot, timeout: 60000, env });
    const main = JSON.parse(result.stdout)[0];
    assert.equal(main.name, packageManifest.name, 'Packed framework name mismatch');
    assert.equal(main.filename, archiveFilename(), 'Packed framework archive filename mismatch');
    main.tarball = path.join(path.resolve(out), main.filename);
    assert.ok(!main.files.some(file => /(?:\.test\.|node_modules\/|^tests\/|^reports\/|\.env(?:\.|$))/.test(file.path)), 'Archive includes development/test files');
    for (const file of ['native/resolve.mjs', 'native/platforms.json', 'runtime/profiles.json', 'build/font-data.json', 'compat/font-local.d.cts', 'README.md']) assert.ok(main.files.some(item => item.path === file), `Missing ${file}`);
    passed('Archive contents: runtime, types, assets and README present; no tests or local artifacts');
    const requested = [];
    const packages = new Map([
      [packageManifest.name, { manifest: packageManifest, packed: main }],
      [native.name, { manifest: { name: native.name, version: packageManifest.version, os: [nativePlatform().os], cpu: [nativePlatform().cpu], ...(nativePlatform().libc ? { libc: [nativePlatform().libc] } : {}) }, packed: native }]
    ]);
    registry = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const name = registryPackageName(pathname);
      const entry = packages.get(name);
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (entry) requested.push(name);
      if (entry && pathname.includes('/-/')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        createReadStream(entry.packed.tarball).pipe(res); return;
      }
      if (entry) {
        const manifest = { ...entry.manifest, dist: { tarball: `http://127.0.0.1:${registry.address().port}/${encodeURIComponent(name)}/-/${entry.packed.filename}`, integrity: entry.packed.integrity, shasum: entry.packed.shasum } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, 'dist-tags': { alpha: manifest.version }, versions: { [manifest.version]: manifest } })); return;
      }
      // Other target binaries are not fabricated: this run validates only the
      // host target. Each CI runner repeats the test with its own real binary.
      if (platforms.some(target => target.package === name)) { res.writeHead(404).end('{"error":"not built on this host"}'); return; }
      res.writeHead(302, { location: `https://registry.npmjs.org${req.url}` }).end();
    });
    await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
    await writeFile(path.join(app, 'package.json'), '{"name":"prnext-isolated-consumer","private":true,"type":"module"}\n');
    log(`Installing ${packageManifest.name}@alpha (${strategy}) through loopback registry into an empty consumer…`);
    await execute('npm', ['install', `${packageManifest.name}@alpha`, `--install-strategy=${strategy}`, '--include=optional', '--ignore-scripts', '--registry', `http://127.0.0.1:${registry.address().port}`, '--no-audit', '--no-fund'], { cwd: app, env, timeout: 180000, maxBuffer: 2 * 1024 ** 2 });
    // npm may reuse the exact tarball bytes cached by npm pack, checking their
    // integrity. Resolution must still use our registry for both packages.
    assert.ok(requested.includes(packageManifest.name));
    assert.ok(requested.includes(native.name), 'Native dependency was not resolved automatically');
    passed(`npm install ${packageManifest.name}@alpha automatically installs the matching native package, even with --ignore-scripts`);
    const installed = path.join(app, 'node_modules', packageManifest.name);
    assert.ok((await realpath(installed)).startsWith(await realpath(temporary)), 'Package is linked to the checkout');
    const cli = path.join(installed, 'cli.mjs');
    const nativeRoot = path.dirname(createRequire(path.join(installed, 'package.json')).resolve(`${native.name}/package.json`));
    const run = (...args) => execute(process.execPath, [cli, ...args], { cwd: app, env, timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
    for (const alias of ['prn', 'prnext']) {
      const executable = path.join(app, 'node_modules/.bin', alias);
      assert.equal((await execute(executable, ['--version'], { cwd: app, env })).stdout.trim(), packageManifest.version);
    }
    assert.match((await run('--help')).stdout, /prn migrate/);
    assert.match((await run('start', '--help')).stdout, /balanced/);
    passed('Both CLI aliases, JS version, help and native help work outside the repository');
    await execute(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(packageManifest.name)});if(typeof m.build!=="function")throw Error("Missing API")`], { cwd: app, env });
    const put = async (file, contents) => { await mkdir(path.dirname(path.join(app, file)), { recursive: true }); await writeFile(path.join(app, file), contents); };
    await put('next.config.mjs', 'export default {output:"standalone"};');
    await put('app/layout.jsx', 'import "./style.css";export default function Layout({children}){return <html><body>{children}</body></html>}');
    const page = marker => `import Image from 'next/image';import icon from './icon.png';import {cookies,headers} from 'next/headers';export const dynamic='force-dynamic';export default async function Page({searchParams}){const q=await searchParams;const c=await cookies();const h=await headers();return <main><h1>${marker}</h1><p>{q.q||'none'}:{c.get('session')?.value||'guest'}:{h.get('x-probe')||'none'}</p><Image src={icon} alt="package-image"/></main>}`;
    await put('app/page.jsx', page('Packed PRNext'));
    await put('app/style.css', 'h1 { color: rgb(12,34,56); }');
    // Fixed 2x2 PNG exercises both metadata and imported-image native tooling.
    await put('app/icon.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nGNgYKjYwshQ8Z+BgbFiCyNjxX8AKG4FS+MnTlwAAAAASUVORK5CYII=', 'base64'));
    await put('app/api/echo/route.js', `import {NextResponse} from 'next/server';export async function POST(request){const value=await request.json();const response=NextResponse.json({value,query:new URL(request.url).searchParams.get('q'),header:request.headers.get('x-probe')},{status:201});response.cookies.set('session','saved',{httpOnly:true,path:'/'});return response}`);
    await put('app/api/edge/route.js', `export const runtime='edge';export const dynamic='force-dynamic';export function GET(request){return Response.json({edge:new URL(request.url).searchParams.get('q')})}`);
    await put('pages/legacy.jsx', `export function getServerSideProps({query}){return {props:{value:query.q||'none'}}};export default function Page({value}){return <h1>Legacy {value}</h1>}`);
    await put('pages/api/legacy.js', `export default function handler(req,res){res.status(202).json({method:req.method,query:req.query.q})}`);
    const migration = JSON.parse((await run('migrate', '--dry-run', '--json')).stdout);
    assert.equal(migration.ok, true, JSON.stringify(migration));
    assert.ok(!migration.changes.some(change => change.field === `dependencies.${packageManifest.name}` && String(change.after).startsWith('file:')), 'Published migration refers to a checkout');
    passed('Published migration uses registry versions, with no file: dependency');
    const built = await run('build');
    assert.doesNotMatch(built.stderr, /Compiling native/);
    passed('Production build: App Router, Pages Router, Edge, CSS, imported image, metadata image and standalone');
    const exercise = async url => {
      const htmlResponse = await fetch(`${url}/?q=parameter`, { headers: { cookie: 'session=member', 'x-probe': 'header' } });
      assert.equal(htmlResponse.status, 200);
      assert.match(await htmlResponse.text(), /parameter.*member.*header/s);
      const flight = await fetch(`${url}/?q=flight`, { headers: { RSC: '1', cookie: 'session=rsc' } });
      assert.match(flight.headers.get('content-type'), /text\/x-component/);
      assert.match(await flight.text(), /flight.*rsc/s);
      const legacy = await fetch(`${url}/legacy?q=ssr`);
      assert.equal(legacy.status, 200); assert.match(await legacy.text(), /Legacy.*ssr/s);
      const api = await fetch(`${url}/api/echo?q=query`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-probe': 'header' }, body: JSON.stringify({ n: 42 }) });
      assert.equal(api.status, 201);
      assert.deepEqual(await api.json(), { value: { n: 42 }, query: 'query', header: 'header' });
      assert.match(api.headers.get('set-cookie'), /session=saved/);
      const pagesApi = await fetch(`${url}/api/legacy?q=pages`);
      assert.equal(pagesApi.status, 202); assert.deepEqual(await pagesApi.json(), { method: 'GET', query: 'pages' });
      const edge = await fetch(`${url}/api/edge?q=isolated`);
      assert.equal(edge.status, 200); assert.deepEqual(await edge.json(), { edge: 'isolated' });
      const icon = await fetch(`${url}/icon.png`);
      assert.equal(icon.status, 200); assert.match(icon.headers.get('content-type'), /image\/png/);
    };
    const startPort = await port();
    server = await serve(app, [cli, 'start', '--port', String(startPort)], { ...env, NODE_ENV: 'production' });
    await waitFor(server, `http://127.0.0.1:${startPort}`, /Packed PRNext/);
    await exercise(`http://127.0.0.1:${startPort}`);
    await server.close(); server = undefined;
    passed('Installed production server: SSR, cookies/headers/query, dynamic Flight, POST JSON, Pages API, Edge and metadata');
    const portable = path.join(temporary, 'portable');
    await cp(path.join(app, '.prnext/standalone'), portable, { recursive: true });
    // Hide the consumer installation while starting the standalone artifact.
    await rename(path.join(app, 'node_modules'), path.join(app, 'dependencies-offline'));
    const portablePort = await port();
    server = await serve(portable, [path.join(portable, 'server.js')], { ...env, NODE_ENV: 'production', PORT: String(portablePort), HOSTNAME: '127.0.0.1' });
    await waitFor(server, `http://127.0.0.1:${portablePort}`, /Packed PRNext/);
    await exercise(`http://127.0.0.1:${portablePort}`);
    await server.close(); server = undefined;
    await rename(path.join(app, 'dependencies-offline'), path.join(app, 'node_modules'));
    passed('Relocated standalone serves the same routes while the original node_modules is unavailable');
    const devPort = await port();
    server = await serve(app, [cli, 'dev', '--port', String(devPort)], { ...env, NODE_ENV: 'development' });
    await waitFor(server, `http://127.0.0.1:${devPort}`, /Packed PRNext/);
    await put('app/page.jsx', page('Packed PRNext updated'));
    await waitFor(server, `http://127.0.0.1:${devPort}`, /Packed PRNext updated/);
    await server.close(); server = undefined;
    passed('Installed dev server rebuilds after a source change');
    // No optional dependency should be needed just to print help/version, but
    // launch must fail clearly instead of invoking a compiler or downloading.
    await rm(nativeRoot, { recursive: true });
    assert.match((await run('--help')).stdout, /PRNext/);
    await assert.rejects(run('start', '--help'), error => /Missing PRNext native package/.test(error.stderr));
    passed('Missing optional native produces actionable error; help remains usable');
    const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
    const report = { package: packageManifest.name, version: packageManifest.version, platform: native.target, strategy, node: process.version, generatedAt: new Date().toISOString(), checks, ...(native.published ? { publishedNative: native.published } : {}), archives: [main, native].map(({ filename, size, integrity }) => ({ filename, size, integrity })) };
    report.sha256 = { [main.filename]: await sha256(main.tarball), [native.filename]: await sha256(native.tarball) };
    await writeFile(path.join(out, `verified-${native.target}${strategy === 'nested' ? '-nested' : ''}.json`), JSON.stringify(report, null, 2) + '\n');
    log(`All ${checks.length} checks passed. Archives and report: ${out}`);
    return report;
  } catch (error) {
    log(`FAILED: ${error.message}${error.stderr ? `\n${error.stderr}` : ''}`);
    if (server) log(server.output());
    throw error;
  } finally {
    await server?.close();
    if (registry) await new Promise(resolve => registry.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--nested') options.strategy = 'nested';
      else if (args[i] === '--published-native') options.reusePublishedNative = true;
      else if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) options.out = args[++i];
      else throw new Error('Usage: node scripts/test-package.mjs [--nested] [--published-native] [--out directory]');
    }
    testPackage(options).catch(() => { process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
