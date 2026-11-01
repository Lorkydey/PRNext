import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, readdir, realpath, lstat, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, cpus, totalmem, release, platform, arch } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { readArchive } from '../../scripts/verify-npm-artifacts.mjs';
import { nativePlatform } from '../../packages/prnext/native/resolve.mjs';
import { productionFixtureFiles } from './production-fixture.mjs';
import { checkReleaseRegression, releaseRoutes, validateReleaseBudgets, validateReleaseConnections } from './release-regression-check.mjs';
import {observeResourceControls as effectiveControls,verifyResourcePolicy} from './release-regression-controls.mjs';
import {verifyRuntimeDependencies,assertMatchingRuntimeDependencies} from './release-regression-dependencies.mjs';
import {startProcessTreeSampling} from './process-tree.mjs';
import {createCgroupAccounting,startCgroupSampling} from './cgroup-accounting.mjs';

const execute = promisify(execFile);
const generator = fileURLToPath(new URL('./production-load.mjs', import.meta.url));
const generatorSources=['production-load.mjs','production-html-validation.mjs','latency-histogram.mjs'];
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const workloadFiles = Object.entries(productionFixtureFiles).filter(([name]) => name !== 'package.json');
const fixtureSha256 = digest(JSON.stringify(workloadFiles.map(([name, text]) => [name, digest(text)])));

// Only command failure fields survive; never serialize command options, env,
// configuration objects or arbitrary properties from errors/cause objects.
export function releaseFailureDiagnostic(error) {
  const output=value=>{
    const text=typeof value==='string'?value:Buffer.isBuffer(value)?value.toString('utf8'):'';
    return {text:text.slice(-8000),characters:text.length,truncated:text.length>8000};
  };
  const metadata=(value,depth=0)=>{
    if(!value||typeof value!=='object')return null;
    const text=(field,limit)=>typeof value[field]==='string'?value[field].slice(0,limit):null;
    return {name:text('name',128),message:text('message',2000),
      code:Number.isSafeInteger(value.code)?value.code:text('code',128),signal:text('signal',128),
      killed:value.killed===true,cause:depth<2?metadata(value.cause,depth+1):null};
  };
  return {...metadata(error),stdout:output(error?.stdout),stderr:output(error?.stderr)};
}

// A finally exception must not discard an otherwise retained measurement or
// hide the command failure that triggered teardown. Attempt both owned cleanup
// paths and make the returned report explicitly invalid if either one fails.
export async function retainReleaseCleanupFailures(report,{stopServer,closeAccounting}={}){
  for(const [stage,cleanup]of [['server-stop',stopServer],['cgroup-close',closeAccounting]]){
    if(!cleanup)continue;
    try{await cleanup();}
    catch(error){(report.cleanupFailures||=[]).push({stage,diagnostic:releaseFailureDiagnostic(error)});}
  }
  if(report.cleanupFailures?.length){
    report.complete=false;
    report.failure||={stage:'cleanup',reason:'Owned benchmark cleanup failed; the comparison is invalid.'};
    report.gate={status:'invalid',stage:'cleanup'};
  }
}

async function verifyDescendantControls(pid, expected) {
  if (process.platform !== 'linux') return effectiveControls(pid);
  const entries = (await readdir('/proc')).filter(value => /^\d+$/.test(value));
  if (entries.length > 8192) throw new Error('Too many processes to verify the owned server process tree.');
  const processes = (await Promise.all(entries.map(async value => {
    try { const source = await readFile(`/proc/${value}/stat`, 'utf8'), fields = source.slice(source.lastIndexOf(')') + 2).split(' '); return { pid: Number(value), parent: Number(fields[1]) }; } catch { return null; }
  }))).filter(Boolean);
  const descendants = [pid];
  for (let i = 0; i < descendants.length; i++) for (const entry of processes) if (entry.parent === descendants[i] && !descendants.includes(entry.pid)) descendants.push(entry.pid);
  for (const child of descendants) {
    const observed = await effectiveControls(child);
    if (!equal(observed, expected)) throw new Error('Owned server descendants have different effective resource controls.');
  }
  return expected;
}

export async function verifyReleaseInstallation(input, configurationDirectory = process.cwd()) {
  if (!input || typeof input.directory !== 'string' || !Array.isArray(input.archives) || input.archives.length !== 2 || !/^[a-f0-9]{40}$/.test(input.source || '')) throw new Error('Each variant requires an installed fixture directory, declared source commit and two exact archive paths.');
  const directory = await realpath(path.resolve(configurationDirectory, input.directory));
  const entries = await readdir(directory);
  if (entries.some(value => /^\.env(?:\.|$)/.test(value) || /^(?:prnext|next)\.config\./.test(value) && value !== 'next.config.mjs' || /^(?:instrumentation|proxy|middleware)\./.test(value) && value !== 'middleware.js' || /^(?:babel|postcss)\.config\.|^\.babelrc/.test(value) || value === 'src')) throw new Error('Use a dedicated production fixture without environment files or additional runtime configuration.');
  const expectedSources = new Set(workloadFiles.map(([name]) => name));
  async function inspectSources(folder) {
    for (const entry of await readdir(path.join(directory, folder), { withFileTypes: true })) {
      const name = `${folder}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('The production fixture must not link workload sources.');
      if (entry.isDirectory()) await inspectSources(name);
      else if (!entry.isFile() || !expectedSources.has(name)) throw new Error(`Additional workload source is not part of the production fixture: ${name}`);
    }
  }
  for (const folder of ['app', 'pages', 'components', 'public']) await inspectSources(folder);
  for (const [name, text] of workloadFiles) {
    const file = path.join(directory, name), physical = await realpath(file);
    if (!within(directory, physical) || !(await lstat(file)).isFile() || !(await readFile(file)).equals(Buffer.from(text))) throw new Error(`The production fixture source does not match: ${name}`);
  }
  const resolve = createRequire(path.join(directory, 'package.json'));
  const archives = [];
  let cli, binary, mainVersion, nativeVersion;
  for (const archiveName of input.archives) {
    if (typeof archiveName !== 'string') throw new Error('Provide exact archive filenames.');
    const bytes = await readFile(path.resolve(configurationDirectory, archiveName)), archive = readArchive(bytes);
    const metadata = JSON.parse(archive.get('package/package.json').data.toString('utf8'));
    const installedManifest = await realpath(resolve.resolve(`${metadata.name}/package.json`)), packageRoot = path.dirname(installedManifest);
    if (!within(directory, packageRoot) || (await lstat(path.dirname(resolve.resolve(`${metadata.name}/package.json`)))).isSymbolicLink()) throw new Error('Release comparisons require independent installed archives, not checkout or workspace links.');
    for (const [name, entry] of archive) {
      const file = path.join(packageRoot, name.slice('package/'.length));
      if (!within(packageRoot, await realpath(file)) || !(await lstat(file)).isFile() || !(await readFile(file)).equals(entry.data)) throw new Error('Installed package bytes differ from the exact comparison archive.');
    }
    async function inventory(folder, prefix = '') {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (!prefix && item.name === 'node_modules') continue;
        const relative = prefix + item.name;
        if (item.isSymbolicLink()) throw new Error('Installed comparison packages cannot link runtime files.');
        if (item.isDirectory()) await inventory(path.join(folder, item.name), relative + '/');
        else if (!item.isFile() || !archive.has(`package/${relative}`)) throw new Error('Installed comparison packages contain extra files outside the exact archive.');
      }
    }
    await inventory(packageRoot);
    archives.push({ name: metadata.name, version: metadata.version, sha256: digest(bytes), bytes: bytes.length, files: archive.size });
    if (metadata.name === '@thomas.f/prnext') { if (cli) throw new Error('Provide one framework and one native archive.'); cli = path.join(packageRoot, 'cli.mjs'); mainVersion = metadata.version; }
    else if (archive.has(`package/bin/prnext${process.platform === 'win32' ? '.exe' : ''}`)) {
      if (binary || metadata.name !== nativePlatform().package || !metadata.os?.includes(process.platform) || !metadata.cpu?.includes(process.arch)) throw new Error('The native comparison archive must match this platform.');
      binary = path.join(packageRoot, 'bin', `prnext${process.platform === 'win32' ? '.exe' : ''}`); nativeVersion = metadata.version;
    }
  }
  if (!cli || !binary || mainVersion !== nativeVersion) throw new Error('Matching framework and native archives are required.');
  return { directory, cli, binary, provenance: { source: { declaredCommit: input.source, associationVerifiedByHarness: false }, archives, installationVerified: true, binarySha256: digest(await readFile(binary)),runtimeDependencies:await verifyRuntimeDependencies(directory) } };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(target, workers, env, accountingGroup) {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  // Starting the verified native directly gives the harness an owned root PID
  // and stdin shutdown handle, without a shell or a checkout resolver fallback.
  const args = ['start', target.directory, '--worker', path.join(target.directory, '.prnext/runtime/worker.mjs'), '--node', process.execPath, '--hostname', '127.0.0.1', '--port', String(port), '--workers', String(workers), '--shutdown-on-stdin-eof'];
  const launch = accountingGroup?.launch(target.binary,args) || {command:target.binary,args};
  const child = spawn(launch.command, launch.args, { cwd: target.directory, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'] });
  let startupError;
  child.once('error', error => { startupError = error; });
  child.stdin.on('error', () => {});
  const stopChild = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      let force;
      const complete = () => { clearTimeout(force); resolve(); };
      child.once('close', complete);
      force = setTimeout(() => {
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { if (child.exitCode === null) child.kill(); });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }, 15000);
      child.stdin.end();
    });
  };
  const stop = async () => { await stopChild(); await accountingGroup?.close(); };
  try {
    for (let i = 0; i < 300; i++) {
      if (startupError || child.exitCode !== null || child.signalCode) throw new Error('The verified benchmark server failed to start.');
      let ready=false;
      try { const response = await fetch(url + '/probe.txt', { signal: AbortSignal.timeout(500) }); ready=response.status === 200 && (await response.text()) === 'private benchmark readiness\n'; } catch {}
      if(ready){ await accountingGroup?.bind(child.pid); return { pid: child.pid, url, stop, accountingGroup }; }
      await delay(100);
    }
    throw new Error('The verified benchmark server did not become ready.');
  } catch (error) { await stop(); throw error; }
}

export async function runReleaseRegression(configuration, { configurationDirectory = process.cwd() } = {}) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).some(key => !['baseline', 'candidate', 'workload', 'budgets','resourcePolicy','resourceAccounting'].includes(key))) throw new Error('Use baseline, candidate, workload, budgets, resourcePolicy and resourceAccounting configuration fields.');
  if(configuration.resourceAccounting!==undefined&&configuration.resourceAccounting!=='cgroup-v2')throw Error('Use cgroup-v2 for explicitly isolated kernel accounting.');
  if(configuration.resourceAccounting==='cgroup-v2'&&process.platform!=='linux')throw Error('Kernel cgroup accounting requires Linux.');
  for (const [field, allowed] of [['workload', ['seconds', 'warmupSeconds', 'connections', 'repetitions', 'workers']], ['budgets', ['throughputDropPercent', 'p95IncreasePercent', 'maxNoisePercent', 'maxGeneratorCpuPercent']]]) if (configuration[field] !== undefined && (!configuration[field] || typeof configuration[field] !== 'object' || Array.isArray(configuration[field]) || Object.keys(configuration[field]).some(key => !allowed.includes(key)))) throw new Error(`Unknown or invalid release benchmark ${field} setting.`);
  const generatorSha256=digest(JSON.stringify(await Promise.all(generatorSources.map(async name=>[name,digest(await readFile(new URL(name,import.meta.url)))]))));
  const workload = { seconds: 10, warmupSeconds: 2, connections: 8, repetitions: 6, workers: 2, ...configuration.workload, routes: [...releaseRoutes], fixtureSha256, generatorSha256 };
  const budgets = { throughputDropPercent: 10, p95IncreasePercent: 15, maxNoisePercent: 15, maxGeneratorCpuPercent: 85, ...configuration.budgets };
  validateReleaseBudgets(budgets);
  const connectionsByRoute = validateReleaseConnections(workload.connections);
  if (typeof workload.connections !== 'number') workload.connections = connectionsByRoute;
  // Validate run bounds before starting any process or modifying build output.
  if (!Number.isFinite(workload.seconds) || workload.seconds < 1 || workload.seconds > 120 || !Number.isFinite(workload.warmupSeconds) || workload.warmupSeconds < 0.25 || workload.warmupSeconds > 30 || !Number.isInteger(workload.repetitions) || workload.repetitions < 6 || workload.repetitions > 20 || workload.repetitions % 2 || !Number.isInteger(workload.workers) || workload.workers < 1 || workload.workers > 16) throw new Error('Use 6–20 even repetitions, 1–120 second measurements, 0.25–30 second warmups, 1–128 connections and 1–16 workers.');
  const targets = {};
  for (const name of ['baseline', 'candidate']) targets[name] = await verifyReleaseInstallation(configuration[name], configurationDirectory);
  if (targets.baseline.directory === targets.candidate.directory) throw new Error('Use separate independently installed application directories.');
  assertMatchingRuntimeDependencies(targets.baseline.provenance.runtimeDependencies,targets.candidate.provenance.runtimeDependencies);
  const controls = await effectiveControls();
  const resourcePolicy=verifyResourcePolicy(configuration.resourcePolicy,controls);
  const environment = { platform: platform(), arch: arch(), release: release(), cpuModel: cpus()[0]?.model || 'unknown', logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version, nodeSha256: digest(await readFile(process.execPath)), controls,resourcePolicy };
  const report = { version: configuration.resourceAccounting==='cgroup-v2'?3:2, complete: false, environment, workload, budgets, artifacts: Object.fromEntries(Object.entries(targets).map(([name, value]) => [name, value.provenance])), samples: [] };
  const temporary = await mkdtemp(path.join(tmpdir(), 'prnext-release-perf-')), canonicalTemp = await realpath(tmpdir());
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.NODE_ENV = 'production';
  let server, accounting, stage = 'build';
  try {
    for (const target of Object.values(targets)) await execute(process.execPath, [target.cli, 'build', target.directory], { cwd: target.directory, env: { ...env, PRNEXT_BINARY: target.binary }, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 ** 2 });
    if(report.version===3){stage='resource-accounting';accounting=await createCgroupAccounting();report.resourceAccounting=accounting.provenance;}
    for (let repetition = 0; repetition < workload.repetitions; repetition++) {
      const order = repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const variant of order) {
        stage = 'server-start';
        const accountingGroup=await accounting?.createServerGroup(`${repetition}-${variant}`);
        server = await startServer(targets[variant], workload.workers, env, accountingGroup);
        for (let index = 0; index < releaseRoutes.length; index++) {
          const route = releaseRoutes[(index + repetition) % releaseRoutes.length];
          async function load(seconds, label) {
            const file = path.join(temporary, `${repetition}-${variant}-${index}-${label}.json`);
            await writeFile(file, JSON.stringify({ url: server.url, route, seconds, connections: connectionsByRoute[route], mode: 'closed', encoding: 'identity' }), { flag: 'wx' });
            const result = await execute(process.execPath, [generator, file], { env, windowsHide: true, timeout: seconds * 1000 + 20000, maxBuffer: 8 * 1024 ** 2 });
            return JSON.parse(result.stdout);
          }
          stage = 'load';
          const warmup = await load(workload.warmupSeconds, 'warmup');
          const expectedControls=report.version===3?await effectiveControls(server.pid):controls;
          if(report.version===3)verifyResourcePolicy(configuration.resourcePolicy,expectedControls);
          const controlsBefore = await verifyDescendantControls(server.pid, expectedControls);
          const sampling=startProcessTreeSampling(server.pid,{intervalMs:1000});
          const cgroupSampling=server.accountingGroup?startCgroupSampling(server.accountingGroup,{intervalMs:1000}):undefined;
          let measurement,serverResources,serverCgroupResources;
          try{await Promise.all([sampling.ready,cgroupSampling?.ready]);measurement=await load(workload.seconds,'measure');}
          finally{[serverResources,serverCgroupResources]=await Promise.all([sampling.stop(),cgroupSampling?.stop()]);}
          const controlsAfter = await verifyDescendantControls(server.pid, expectedControls);
          report.samples.push({ repetition, variant, route, environment, controlsBefore, controlsAfter, warmup, measurement,serverRootPid:server.pid,serverResources,serverCpuSeconds:serverResources.cpuSeconds,serverMemoryBytes:serverResources.peakRssBytes,...(serverCgroupResources?{serverCgroupResources}:{}) });
        }
        await server.stop(); server = undefined;
      }
    }
    stage = 'validation';
    report.complete = true;
    report.gate = checkReleaseRegression(report);
    return report;
  } catch (error) {
    report.complete = false;
    report.failure = { stage, reason: 'The comparison did not produce complete, valid matching measurements. Inspect the retained samples and verify the prepared application installations.',diagnostic:releaseFailureDiagnostic(error) };
    report.gate = { status: 'invalid', stage };
    return report;
  } finally {
    await retainReleaseCleanupFailures(report,{stopServer:()=>server?.stop(),closeAccounting:()=>accounting?.close()});
    const physical = await realpath(temporary);
    if (path.dirname(physical) !== canonicalTemp || !path.basename(physical).startsWith('prnext-release-perf-')) throw new Error('Unexpected owned performance scratch directory.');
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
