import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const name = path.relative(root, file); return name && name !== '..' && !name.startsWith('..' + path.sep) && !path.isAbsolute(name); };
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
export function parseLocalArguments(args) {
  const options = { mode: 'quick', jobs: 2, root: defaultRoot, list: false }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; assert.ok(['--mode', '--jobs', '--root', '--cache', '--list'].includes(flag) && !seen.has(flag), 'Unknown or duplicate local CI argument'); seen.add(flag);
    if (flag === '--list') { options.list = true; continue; }
    const value = args[++i]; assert.ok(value && !value.startsWith('--'), 'Missing local CI argument');
    options[flag.slice(2)] = value;
  }
  assert.ok(['quick', 'full'].includes(options.mode), 'Expected quick or full mode');
  assert.match(String(options.jobs), /^[1-4]$/, 'Expected 1 to 4 local jobs'); options.jobs = Number(options.jobs);
  options.root = path.resolve(options.root); if (options.cache) options.cache = path.resolve(options.cache);
  return options;
}

export async function collectSources(root) {
  root = await realpath(root);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(name)) delete env[name];
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 ** 2 }).split('\0').filter(Boolean);
  const files = [], checked = new Set([root]); let total = 0;
  async function checkParent(directory) {
    if (checked.has(directory)) return;
    assert.ok(inside(root, directory) && !(await lstat(directory)).isSymbolicLink(), 'Local CI source directory links are not supported');
    await checkParent(path.dirname(directory)); checked.add(directory);
  }
  for (const name of [...new Set(names)].sort()) {
    assert.ok(!/[\\\0\r\n]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git'), 'Unsafe source path');
    // Local account/deployment environment files never enter a test snapshot.
    if (/^\.env(?:$|\.)/.test(path.posix.basename(name))) continue;
    const file = path.resolve(root, name); assert.ok(inside(root, file));
    let info; try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await checkParent(path.dirname(file));
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Local CI source links are not supported: ' + name);
    assert.ok(info.size <= 128 * 1024 ** 2 && (total += info.size) <= 512 * 1024 ** 2, 'Local source snapshot exceeds its bound');
    const bytes = await readFile(file); files.push({ name, sha256: hash(bytes), mode: info.mode & 0o777, bytes });
  }
  assert.ok(files.some(file => file.name === 'package-lock.json') && files.some(file => file.name === 'package.json'), 'A complete PRNext source checkout is required');
  return { files, fingerprint: hash(JSON.stringify(files.map(({ name, sha256, mode }) => [name, sha256, mode]))) };
}

export async function syncSnapshot(destination, snapshot) {
  await mkdir(destination, { recursive: true });
  assert.ok((await lstat(destination)).isDirectory() && !(await lstat(destination)).isSymbolicLink(), 'Local CI snapshot cannot be a link');
  const marker = path.join(destination, '.prnext-local-ci');
  try { assert.equal(await readFile(marker, 'utf8'), 'managed source snapshot v1\n'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; assert.equal((await readdir(destination)).length, 0, 'Refusing an unowned local CI directory'); await writeFile(marker, 'managed source snapshot v1\n', { flag: 'wx' }); }
  const managed = path.join(destination, '.source-files.json');
  let previous = []; try { previous = JSON.parse(await readFile(managed, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(Array.isArray(previous) && previous.length <= 50000 && previous.every(name => typeof name === 'string'));
  const current = new Set(snapshot.files.map(file => file.name));
  for (const name of previous) if (!current.has(name)) {
    const target = path.resolve(destination, name); assert.ok(inside(destination, target));
    try { assert.ok(inside(await realpath(destination), await realpath(path.dirname(target))) || await realpath(path.dirname(target)) === await realpath(destination)); assert.ok(!(await lstat(target)).isSymbolicLink()); await unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of snapshot.files) {
    const target = path.resolve(destination, file.name); assert.ok(inside(destination, target));
    assert.equal(hash(file.bytes), file.sha256, 'Snapshot source bytes changed');
    await mkdir(path.dirname(target), { recursive: true });
    // Resolve the parent after mkdir so a pre-existing link cannot redirect writes.
    assert.ok(inside(await realpath(destination), await realpath(path.dirname(target))) || await realpath(path.dirname(target)) === await realpath(destination));
    try {
      const info = await lstat(target); assert.ok(info.isFile() && !info.isSymbolicLink());
      if (hash(await readFile(target)) === file.sha256 && (info.mode & 0o777) === file.mode) continue;
      assert.equal(info.nlink, 1, 'Managed source cannot overwrite an externally linked inode');
      if (process.platform === 'win32' && !(info.mode & 0o200)) await chmod(target, info.mode | 0o200);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = target + '.prnext-ci-write-' + randomUUID();
    try {
      await writeFile(temporary, file.bytes, { flag: 'wx', mode: file.mode }); await chmod(temporary, file.mode); await rename(temporary, target);
    } finally { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  await writeFile(managed, JSON.stringify([...current]));
}

export function validationPlan(mode, runId = 'plan') {
  const unit = { id: 'unit-types', commands: [['npm', 'run', 'test:ci'], ['npm', 'run', 'test:unit'], ['npm', 'run', 'test:types']] };
  if (mode === 'quick') return [{ ...unit, commands: [['npm', 'run', 'test:ci'], ['npm', 'run', 'test:unit:fast'], ['npm', 'run', 'test:types']] }];
  assert.equal(mode, 'full');
  return [unit, { id: 'rust-checks', commands: [['cargo', 'fmt', '--all', '--', '--check'], ['cargo', 'clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'], ['cargo', 'test', '--workspace', '--locked']] },
    ...['browser', 'integration'].flatMap(suite => Array.from({ length: 4 }, (_, i) => ({ id: suite + '-' + (i + 1), suite,
      commands: [['node', 'scripts/ci-shards.mjs', '--suite', suite, '--shard', `${i + 1}/4`, '--plan-output', `artifacts/ci-local-results/${runId}/${suite}-plan.json`]] })))];
}

export function dependencyFingerprint(files, nodeVersion = process.version) {
  const inputs = files.filter(file => /(?:^|\/)(?:package|package-lock)\.json$/.test(file.name)).map(file => {
    if (path.posix.basename(file.name) !== 'package.json') return [file.name, file.sha256];
    const manifest = JSON.parse(file.bytes.toString('utf8'));
    // Acquisition uses --ignore-scripts. Editing test/CI commands alone must
    // not force npm to reinstall an otherwise identical locked dependency tree.
    delete manifest.scripts; return [file.name, hash(JSON.stringify(manifest))];
  });
  return hash(JSON.stringify(inputs) + nodeVersion);
}

export function localEnvironment(workspace, cache, original = process.env) {
  const allowed = /^(?:PATH|PATHEXT|SystemRoot|SystemDrive|WINDIR|COMSPEC|OS|NUMBER_OF_PROCESSORS|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|TEMP|TMP|INCLUDE|LIB|LIBPATH|VCINSTALLDIR|VCToolsInstallDir|WindowsSdkDir|WindowsSDKVersion|UniversalCRTSdkDir|UCRTVersion|SDKROOT|MACOSX_DEPLOYMENT_TARGET|PRNEXT_REDIS_SERVER|PLAYWRIGHT_BROWSERS_PATH|RUSTUP_HOME)$/i;
  const env = Object.fromEntries(Object.entries(original).filter(([name]) => allowed.test(name)));
  env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || env.Path || ''); delete env.Path;
  Object.assign(env, { HOME: path.join(workspace, 'home'), USERPROFILE: path.join(workspace, 'home'), APPDATA: path.join(workspace, 'home/appdata'), LOCALAPPDATA: path.join(workspace, 'home/localappdata'),
    RUSTUP_HOME: env.RUSTUP_HOME || path.join(homedir(), '.rustup'), CARGO_HOME: path.join(cache, 'cargo'), CARGO_TARGET_DIR: path.join(workspace, 'target'),
    NODE_COMPILE_CACHE: path.join(cache, 'node'), PRNEXT_PM_HOME: path.join(workspace, 'processes'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || path.join(cache, 'browsers'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, 'empty.gitconfig'), CARGO_BUILD_JOBS: String(Math.min(4, availableParallelism())), RAYON_NUM_THREADS: String(Math.min(4, availableParallelism())),
    npm_config_cache: path.join(cache, 'npm'), npm_config_userconfig: path.join(workspace, 'empty.npmrc'), npm_config_globalconfig: path.join(workspace, 'empty-global.npmrc'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' });
  return env;
}

export async function runCommand(command, { cwd, env, log, signal, timeout = 2700000 } = {}) {
  if (signal?.aborted) return { code: null, cancelled: true };
  const handle = await open(log, 'w'), started = performance.now();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['ignore', handle.fd, handle.fd], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
      let cancelled = false, timer, finished = false;
      const stop = () => {
        if (finished || cancelled) return; cancelled = true;
        if (process.platform === 'win32') {
          try { execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      };
      const cleanup = () => { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', (code, termSignal) => { cleanup(); resolve({ code, signal: termSignal, cancelled, seconds: (performance.now() - started) / 1000 }); });
      timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    });
  } finally { await handle.close(); }
}

export async function mapBounded(items, limit, work) {
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 4);
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; results[index] = await work(items[index], index); }
  }));
  return results;
}

export async function reserveLocalPorts(count) {
  assert.ok(Number.isInteger(count) && count >= 0 && count <= 4);
  const leases = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
      let released = false;
      leases.push({ port: server.address().port, release: async () => {
        if (released) return; released = true;
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } });
    }
    return leases;
  } catch (error) { await Promise.all(leases.map(lease => lease.release())); throw error; }
}

export async function cloneDependencies(base, destination, stamp) {
  assert.ok(!(await lstat(destination)).isSymbolicLink());
  assert.equal(await readFile(path.join(destination, '.prnext-local-ci'), 'utf8'), 'managed source snapshot v1\n');
  // macOS can expose the same temporary directory through /var and /private/var.
  // Compare canonical roots before validating or remapping dependency links.
  base = await realpath(base); destination = await realpath(destination);
  assert.ok((await lstat(path.join(base, 'node_modules'))).isDirectory() && !(await lstat(path.join(base, 'node_modules'))).isSymbolicLink());
  const marker = path.join(destination, '.dependencies.json');
  try { if (await readFile(marker, 'utf8') === stamp && (await lstat(path.join(destination, 'node_modules'))).isDirectory() && !(await lstat(path.join(destination, 'node_modules'))).isSymbolicLink()) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const modules = path.join(destination, 'node_modules');
  try { assert.ok((await lstat(modules)).isDirectory() && !(await lstat(modules)).isSymbolicLink()); assert.ok(inside(await realpath(destination), await realpath(modules))); await rm(modules, { recursive: true, force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const links = [];
  await cp(path.join(base, 'node_modules'), modules, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true,
    filter: async (source, target) => {
      if (!(await lstat(source)).isSymbolicLink()) return true;
      const resolved = await realpath(source); assert.ok(inside(base, resolved), 'Dependency link leaves the isolated checkout');
      links.push([target, path.join(destination, path.relative(base, resolved)), (await lstat(resolved)).isDirectory()]); return false;
    } });
  for (const [link, target, directory] of links) { await mkdir(path.dirname(link), { recursive: true }); await symlink(target, link, process.platform === 'win32' ? directory ? 'junction' : 'file' : undefined); }
  await writeFile(marker, stamp);
}

export async function dependenciesReady(workspace, stamp, packages) {
  try {
    if (await readFile(path.join(workspace, '.dependencies.json'), 'utf8') !== stamp) return false;
    const modules = await lstat(path.join(workspace, 'node_modules'));
    assert.ok(modules.isDirectory() && !modules.isSymbolicLink(), 'Dependency directory must be a real owned directory');
    for (const name of packages) if (!(await lstat(path.join(workspace, 'node_modules', name, 'package.json'))).isFile()) return false;
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function main(args) {
  const options = parseLocalArguments(args), runId = randomUUID();
  if (options.list) { console.log(JSON.stringify(validationPlan(options.mode), null, 2)); return 0; }
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok(major === 22 && (minor > 23 || minor === 23 && patch >= 4) || major === 24 && (minor > 22 || minor === 22 && patch >= 1) || major > 26 || major === 26 && (minor > 12 || minor === 12 && patch >= 1), 'Use Node 22.23.4+, 24.22.1+ or 26.12.1+');
  const root = await realpath(options.root); let cache = options.cache || path.join(tmpdir(), 'prnext-local-ci', hash(root).slice(0, 16), process.platform + '-' + process.arch + '-' + process.versions.node);
  assert.ok(!inside(root, cache) && !inside(path.resolve(cache), root) && root !== path.resolve(cache), 'Local CI cache must be outside the source checkout');
  await mkdir(cache, { recursive: true }); cache = await realpath(cache);
  assert.ok(!inside(root, cache) && !inside(cache, root) && root !== cache, 'Local CI cache aliases the source checkout');
  const ownerFile = path.join(cache, 'owner.json'), owner = JSON.stringify({ schemaVersion: 1, root, node: process.version });
  try { assert.ok((await lstat(ownerFile)).isFile() && !(await lstat(ownerFile)).isSymbolicLink()); assert.equal(await readFile(ownerFile, 'utf8'), owner, 'Local CI cache belongs to another checkout'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; assert.equal((await readdir(cache)).length, 0, 'Local CI cache is not an empty owned directory'); await writeFile(ownerFile, owner, { flag: 'wx' }); }
  const lockFile = path.join(cache, 'validation.lock');
  let lock; try { lock = await open(lockFile, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('Another validation owns this local CI cache. Preserve its lock until it finishes.'); throw error; }
  const controller = new AbortController(), interrupt = () => controller.abort(); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let browserPorts = [];
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, root, runId }));
    const snapshot = await collectSources(root), base = path.join(cache, 'base'), reports = path.join(cache, 'reports', runId);
    await mkdir(reports, { recursive: true }); await syncSnapshot(base, snapshot);
    assert.equal((await collectSources(root)).fingerprint, snapshot.fingerprint, 'Source changed while taking the snapshot');
    const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'); assert.ok((await lstat(npmCli)).isFile(), 'Run through npm or use a Node distribution containing npm');
    const stamp = dependencyFingerprint(snapshot.files);
    async function environment(workspace) {
      const env = localEnvironment(workspace, cache);
      for (const directory of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.CARGO_HOME]) await mkdir(directory, { recursive: true });
      await writeFile(env.npm_config_userconfig, ''); await writeFile(env.npm_config_globalconfig, ''); await writeFile(env.GIT_CONFIG_GLOBAL, ''); return env;
    }
    const command = args => args[0] === 'npm' ? [process.execPath, npmCli, ...args.slice(1)] : args[0] === 'node' ? [process.execPath, ...args.slice(1)] : args;
    async function execute(workspace, id, args, env) {
      console.log('Local CI: ' + id); const log = path.join(reports, id + '.log');
      const result = await runCommand(command(args), { cwd: workspace, env, log, signal: controller.signal, timeout: id === 'dependencies' || id.endsWith('-setup') ? 600000 : 2700000 });
      if (result.code !== 0 || result.cancelled) throw new Error(id + ' failed; see ' + log);
      return { ...result, log };
    }
    const baseEnv = await environment(base);
    const installed = await dependenciesReady(base, stamp, ['react', 'typescript', '@playwright/test']);
    if (!installed) { await execute(base, 'dependencies', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], baseEnv); await writeFile(path.join(base, '.dependencies.json'), stamp); }
    if (options.mode === 'full' && process.platform === 'win32' && !baseEnv.PRNEXT_REDIS_SERVER) {
      const { ensureWindowsRedis } = await import(pathToFileURL(path.join(base, 'scripts/portable-redis.mjs')).href);
      baseEnv.PRNEXT_REDIS_SERVER = await ensureWindowsRedis(path.join(cache, 'redis'));
    }
    if (options.mode === 'full') await execute(base, 'native-build', ['cargo', 'build', '--release', '--locked'], baseEnv);
    const tasks = validationPlan(options.mode, runId);
    const browserTasks = tasks.filter(task => task.suite === 'browser');
    browserPorts = await reserveLocalPorts(browserTasks.length);
    const taskPorts = new Map(browserTasks.map((task, index) => [task.id, browserPorts[index]]));
    const workspaces = new Set([base]);
    const results = await mapBounded(tasks, options.jobs, async task => {
      if (controller.signal.aborted) return { id: task.id, passed: false, cancelled: true };
      try {
        const workspace = task.id === 'unit-types' || task.id === 'rust-checks' ? base : path.join(cache, task.id);
        workspaces.add(workspace);
        let env = baseEnv;
        if (workspace !== base) {
          await syncSnapshot(workspace, snapshot); await cloneDependencies(base, workspace, stamp); env = await environment(workspace); if (baseEnv.PRNEXT_REDIS_SERVER) env.PRNEXT_REDIS_SERVER = baseEnv.PRNEXT_REDIS_SERVER;
          const binaryName = process.platform === 'win32' ? 'prnext.exe' : 'prnext'; await mkdir(path.join(workspace, 'target/release'), { recursive: true });
          await copyFile(path.join(base, 'target/release', binaryName), path.join(workspace, 'target/release', binaryName));
        }
        if (task.suite === 'browser') await execute(workspace, task.id + '-setup', ['node', 'node_modules/@playwright/test/cli.js', 'install', 'chromium'], env);
        if (task.suite === 'browser') {
          const lease = taskPorts.get(task.id);
          env = { ...env, PRNEXT_BROWSER_PORT: String(lease.port) };
          await lease.release();
        }
        if (task.suite === 'integration') {
          const toolchain = path.join(workspace, 'tests/toolchain');
          if (!await dependenciesReady(toolchain, stamp, ['typescript', 'redis'])) {
            await execute(workspace, task.id + '-setup', ['npm', 'ci', '--prefix', 'tests/toolchain', '--workspaces=false', '--ignore-scripts', '--no-audit', '--no-fund'], env);
            await writeFile(path.join(toolchain, '.dependencies.json'), stamp);
          }
        }
        const steps = []; for (const [index, args] of task.commands.entries()) steps.push(await execute(workspace, task.id + '-' + index, args, env));
        return { id: task.id, passed: true, steps };
      } catch (error) { return { id: task.id, passed: false, error: error.message }; }
    });
    const current = await collectSources(root), unchanged = current.fingerprint === snapshot.fingerprint;
    let snapshotsUnchanged = true;
    for (const workspace of workspaces) for (const file of snapshot.files) {
      try { if (hash(await readFile(path.join(workspace, file.name))) !== file.sha256 || ((await lstat(path.join(workspace, file.name))).mode & 0o777) !== file.mode) snapshotsUnchanged = false; } catch { snapshotsUnchanged = false; }
    }
    const report = { schemaVersion: 1, mode: options.mode, platform: process.platform, node: process.version, dependencyCacheHit: installed, sourceFingerprint: snapshot.fingerprint, sourceUnchanged: unchanged, results,
      snapshotsUnchanged, passed: unchanged && snapshotsUnchanged && results.every(result => result.passed), scope: options.mode === 'full' ? 'local platform only; remote matrix remains required' : 'development feedback; not full qualification' };
    await writeFile(path.join(reports, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ passed: report.passed, report: path.join(reports, 'report.json') })); return report.passed ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); await Promise.all(browserPorts.map(lease => lease.release())); await lock.close(); await unlink(lockFile); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
