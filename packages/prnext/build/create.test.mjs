import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCreateArgs, createProject, installProject } from './create.mjs';
import { packageManifest } from '../native/resolve.mjs';

const supportedServices = { nodeVersion: '24.22.1' };
const defaults = { install: true, typescript: true, json: false };
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'prnext-create-unit-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readPackage(root) {
  return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
}

async function linkDirectory(t, target, link) {
  try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Directory links unavailable: ${error.code}`); return false; }
    throw error;
  }
}

async function stopped(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  if (process.platform === 'win32') return false;
  // An orphan may remain as a zombie until the platform's init process reaps it.
  // It has exited and cannot run; kill(pid, 0) alone does not distinguish this.
  try {
    const { stdout } = await execute('ps', ['-o', 'stat=', '-p', String(pid)]);
    return !stdout.trim() || stdout.trim().startsWith('Z');
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return true;
    throw error;
  }
}

async function assertStopped(pid) {
  const deadline = Date.now() + 2000;
  while (!await stopped(pid)) {
    assert.ok(Date.now() < deadline, `Installer process ${pid} is still running.`);
    await delay(20);
  }
}

test('create parses the required directory, portable defaults and flags in either order', () => {
  const cwd = path.resolve('create-parser-root');
  assert.deepEqual(parseCreateArgs(['my app'], cwd), { directory: path.join(cwd, 'my app'), options: defaults });
  assert.deepEqual(parseCreateArgs(['--no-install', 'my app', '--js', '--json'], cwd), {
    directory: path.join(cwd, 'my app'), options: { install: false, typescript: false, json: true },
  });
  assert.equal(parseCreateArgs(['.'], cwd).directory, cwd);
  assert.equal(parseCreateArgs(['--no-install', '--', '-my-app'], cwd).directory, path.join(cwd, '-my-app'));
});

test('create rejects missing or extra directories, unknown options and duplicate flags', () => {
  for (const args of [[], ['--no-install'], ['one', 'two'], ['one', '--force'], ['one', '--typescript'],
    ['one', '--no-install', '--no-install'], ['one', '--js', '--js'], ['one', '--json', '--json'],
    ['--', 'one', 'two']]) {
    assert.throws(() => parseCreateArgs(args), undefined, `Arguments should be rejected: ${JSON.stringify(args)}`);
  }
});

test('create prepares a minimal TypeScript app with exact installed framework and React versions', async t => {
  const base = await fixture(t), root = path.join(base, 'My First App');
  let installs = 0;
  const report = await createProject(root, { install: false }, {
    ...supportedServices, runInstall: async () => { installs++; },
  });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'prepared');
  assert.equal(report.root, root);
  assert.equal(report.name, 'my-first-app');
  assert.equal(report.typescript, true);
  assert.equal(report.installed, false);
  assert.equal(installs, 0);
  assert.equal(await exists(path.join(root, '.prnext-create.lock')), false);
  const pkg = await readPackage(root);
  assert.equal(pkg.name, report.name);
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.dependencies, {
    [packageManifest.name]: packageManifest.version,
    ...Object.fromEntries(['react','react-dom','react-server-dom-webpack'].map(name=>[name,packageManifest.peerDependencies[name]])),
  });
  for (const command of ['dev', 'build', 'start', 'check', 'typecheck']) assert.equal(pkg.scripts[command], `prnext ${command}`);
  for (const dependency of ['typescript', '@types/node', '@types/react', '@types/react-dom']) assert.ok(pkg.devDependencies[dependency]);
  const tsconfig = JSON.parse(await readFile(path.join(root, 'tsconfig.json'), 'utf8'));
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
  assert.equal(tsconfig.compilerOptions.moduleResolution.toLowerCase(), 'bundler');
  const layout = await readFile(path.join(root, 'app/layout.tsx'), 'utf8');
  const page = await readFile(path.join(root, 'app/page.tsx'), 'utf8');
  assert.match(layout, /<html\b/);
  assert.match(layout, /<body\b/);
  assert.match(page, /<main\b/);
  const cssFiles = (await readdir(path.join(root, 'app'))).filter(name => name.endsWith('.css'));
  assert.equal(cssFiles.length, 1);
  assert.ok(layout.includes(cssFiles[0]));
  assert.ok((await readFile(path.join(root, 'app', cssFiles[0]), 'utf8')).trim());
  const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
  for (const directory of ['node_modules', '.prnext', '.prnext-types', '.prnext-dev', '.prnext-cache']) assert.ok(ignore.includes(directory));
  const instructions = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /prnext docs --ai/);
  assert.ok(instructions.includes(packageManifest.name));
  assert.ok((await readFile(path.join(root, 'README.md'), 'utf8')).includes('npm run dev'));
  assert.ok(Array.isArray(report.files) && report.files.length >= 7);
  for (const file of report.files) {
    assert.equal(path.isAbsolute(file), false, 'Created-file reports use portable project-relative paths.');
    assert.equal((await stat(path.join(root, file))).isFile(), true);
  }
  assert.ok(report.next.some(command => /npm install/.test(command)));
});

test('create accepts a truly empty existing directory and prepares JavaScript without TypeScript tools', async t => {
  const base = await fixture(t), root = path.join(base, 'empty-app');
  await mkdir(root);
  const report = await createProject(root, { install: false, typescript: false }, supportedServices);
  assert.equal(report.ok, true);
  assert.equal(report.typescript, false);
  assert.equal(await exists(path.join(root, '.prnext-create.lock')), false);
  const pkg = await readPackage(root);
  assert.equal(pkg.dependencies[packageManifest.name], packageManifest.version);
  assert.equal(pkg.scripts.typecheck, undefined);
  assert.ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0);
  assert.equal(await exists(path.join(root, 'tsconfig.json')), false);
  const files = await readdir(path.join(root, 'app'));
  assert.ok(files.includes('layout.jsx'));
  assert.ok(files.includes('page.jsx'));
  assert.equal(files.some(file => /\.tsx?$/.test(file)), false);
  assert.doesNotMatch(await readFile(path.join(root, 'app/layout.jsx'), 'utf8'), /import type|ReactNode/);
});

test('create runs the injected installer only after writing the complete project and forwards output', async t => {
  const base = await fixture(t), root = path.join(base, 'installed-app'), chunks = [];
  const controller = new AbortController();
  let calls = 0;
  const report = await createProject(root, { signal: controller.signal, onOutput: value => chunks.push(value) }, {
    ...supportedServices,
    runInstall: async (directory, { signal, onOutput }) => {
      calls++;
      assert.equal(directory, root);
      assert.equal(signal, controller.signal);
      assert.equal((await readPackage(directory)).dependencies[packageManifest.name], packageManifest.version);
      assert.equal(await exists(path.join(directory, 'app/page.tsx')), true);
      assert.equal(await exists(path.join(directory, 'AGENTS.md')), true);
      onOutput('installed fixture dependencies');
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.ok, true);
  assert.equal(report.status, 'created');
  assert.equal(report.installed, true);
  assert.equal(await exists(path.join(root, '.prnext-create.lock')), false);
  assert.deepEqual(chunks, ['installed fixture dependencies']);
  assert.ok(report.next.some(command => /npm run dev/.test(command)));
});

test('create keeps all generated files and reports a recoverable installation failure', async t => {
  const base = await fixture(t), root = path.join(base, 'offline-app');
  let calls = 0;
  const report = await createProject(root, {}, {
    ...supportedServices, runInstall: async () => { calls++; throw new Error('fixture registry offline'); },
  });
  assert.equal(calls, 1);
  assert.equal(report.ok, false);
  assert.equal(report.status, 'install-failed');
  assert.equal(report.installed, false);
  assert.equal(await exists(path.join(root, '.prnext-create.lock')), false);
  assert.match(report.error, /fixture registry offline/);
  assert.equal((await readPackage(root)).dependencies[packageManifest.name], packageManifest.version);
  for (const file of report.files) assert.equal(await exists(path.join(root, file)), true);
  assert.ok(report.next.some(command => /npm install/.test(command)));
});

test('create cancels an already aborted request before making any filesystem changes', async t => {
  const base = await fixture(t), root = path.join(base, 'cancelled-app');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(createProject(root, { signal: controller.signal }, {
    ...supportedServices, runInstall: async () => { calls++; },
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(await exists(root), false);
  assert.deepEqual(await readdir(base), []);
});

test('create reports cancellation during installation and keeps the prepared source files', async t => {
  const base = await fixture(t), root = path.join(base, 'interrupted-app');
  const controller = new AbortController();
  const report = await createProject(root, { signal: controller.signal }, {
    ...supportedServices,
    runInstall: async (_root, { signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      throw signal.reason;
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.installed, false);
  assert.equal(await exists(path.join(root, '.prnext-create.lock')), false);
  assert.equal(await exists(path.join(root, 'package.json')), true);
  assert.equal(await exists(path.join(root, 'app/page.tsx')), true);
});

test('create preserves ordinary and hidden content in nonempty directories', async t => {
  const base = await fixture(t);
  for (const entry of ['keep.txt', '.gitignore', '.git']) {
    const root = path.join(base, entry.replaceAll('.', '_'));
    await mkdir(root);
    if (entry === '.git') await mkdir(path.join(root, entry));
    else await writeFile(path.join(root, entry), 'user content\n');
    await assert.rejects(createProject(root, { install: false }, supportedServices));
    assert.deepEqual(await readdir(root), [entry]);
    if (entry !== '.git') assert.equal(await readFile(path.join(root, entry), 'utf8'), 'user content\n');
  }
});

test('create refuses existing files without overwriting them', async t => {
  const base = await fixture(t), root = path.join(base, 'existing-file');
  await writeFile(root, 'preserve this file\n');
  await assert.rejects(createProject(root, { install: false }, supportedServices));
  assert.equal(await readFile(root, 'utf8'), 'preserve this file\n');
  assert.deepEqual(await readdir(base), ['existing-file']);
});

test('create refuses a symbolic-link or junction destination without touching its target', async t => {
  const base = await fixture(t), physical = path.join(base, 'physical'), root = path.join(base, 'linked');
  await mkdir(physical);
  if (!await linkDirectory(t, physical, root)) return;
  await assert.rejects(createProject(root, { install: false }, supportedServices));
  assert.deepEqual(await readdir(physical), []);
  assert.equal(await realpath(root), physical);
});

test('create refuses a linked ancestor before creating a nested destination', async t => {
  const base = await fixture(t), physical = path.join(base, 'physical'), link = path.join(base, 'linked');
  await mkdir(physical);
  if (!await linkDirectory(t, physical, link)) return;
  await assert.rejects(createProject(path.join(link, 'nested-app'), { install: false }, supportedServices));
  assert.deepEqual(await readdir(physical), []);
  assert.equal(await realpath(link), physical);
});

test('macOS system aliases allow creation while linked descendants and existing content stay protected', { skip: process.platform !== 'darwin' }, async t => {
  for (const parent of ['/var/tmp', '/tmp']) {
    const logical = await mkdtemp(path.join(parent, 'prnext-create-system-alias-'));
    const physical = await realpath(logical);
    t.after(() => rm(physical, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    assert.equal(physical, `/private${logical}`);
    const root = path.join(logical, 'new app');
    const report = await createProject(root, { install: false }, supportedServices);
    assert.equal(report.ok, true);
    assert.equal(report.root, root);
    assert.equal(await realpath(root), path.join(physical, 'new app'));
    assert.equal((await readPackage(root)).dependencies[packageManifest.name], packageManifest.version);
    assert.equal(await exists(path.join(root, 'app/page.tsx')), true);
    await assert.rejects(createProject(root, { install: false }, supportedServices), /must be empty/);

    const target = path.join(physical, 'empty target');
    const link = path.join(logical, 'user link');
    await mkdir(target);
    await symlink(target, link, 'dir');
    for (const destination of [link, path.join(link, 'nested')]) {
      await assert.rejects(createProject(destination, { install: false }, supportedServices), /symbolic links or junctions/);
    }
    assert.deepEqual(await readdir(target), []);
  }
});

test('create rejects unsupported Node versions before writing a project', async t => {
  const base = await fixture(t), root = path.join(base, 'old-node-app');
  await assert.rejects(createProject(root, { install: false }, { nodeVersion: '20.20.0' }), /Node|unsupported/i);
  assert.equal(await exists(root), false);
  assert.deepEqual(await readdir(base), []);
});

test('create blocks automatic installation inside npm and pnpm workspaces before making changes', async t => {
  for (const manager of ['npm', 'pnpm']) {
    const base = await fixture(t), root = path.join(base, 'apps', 'my-app');
    const workspaceFile = path.join(base, manager === 'npm' ? 'package.json' : 'pnpm-workspace.yaml');
    const workspace = manager === 'npm' ? '{"private":true,"workspaces":["apps/*"]}\n' : 'packages:\n  - "apps/*"\n';
    await writeFile(workspaceFile, workspace);
    const lockFile = path.join(base, manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml');
    const lock = manager === 'npm' ? '{"name":"workspace","lockfileVersion":3}\n' : 'lockfileVersion: "9.0"\n';
    await writeFile(lockFile, lock);
    let calls = 0;
    const services = { ...supportedServices, runInstall: async () => { calls++; } };
    await assert.rejects(createProject(root, {}, services), /workspace|--no-install/i);
    assert.equal(calls, 0);
    assert.equal(await exists(path.join(base, 'apps')), false);
    assert.equal(await readFile(workspaceFile, 'utf8'), workspace);
    assert.equal(await readFile(lockFile, 'utf8'), lock);
    const report = await createProject(root, { install: false }, services);
    assert.equal(report.ok, true);
    assert.equal(report.status, 'prepared');
    assert.equal(calls, 0);
    assert.equal(await exists(path.join(root, '.prnext-create.lock')), false);
    assert.equal(await readFile(workspaceFile, 'utf8'), workspace);
    assert.equal(await readFile(lockFile, 'utf8'), lock);
  }
});

test('installer runs npm without shell interpolation, scopes the destination and forwards output', async t => {
  const base = await fixture(t), root = path.join(base, 'project with spaces & ampersand');
  await mkdir(root);
  const launcher = path.join(base, 'npm-cli.js');
  await writeFile(launcher, `const fs = require('node:fs');
fs.writeFileSync('invocation.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),init:process.env.INIT_CWD,pwd:process.env.PWD,
workspace:process.env.npm_config_workspace??null,workspaces:process.env.npm_config_workspaces??null,global:process.env.npm_config_global??null,prefix:process.env.npm_config_prefix??null}));
process.stdout.write('fixture stdout');process.stderr.write('fixture stderr');
`);
  const overrides = { npm_execpath: launcher, npm_config_workspace: 'other-app', npm_config_workspaces: 'true', npm_config_global: 'true', npm_config_prefix: base };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  const output = [];
  try {
    Object.assign(process.env, overrides);
    await installProject(root, { onOutput: (value, stream) => output.push({ value, stream }) });
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const invocation = JSON.parse(await readFile(path.join(root, 'invocation.json'), 'utf8'));
  assert.equal(invocation.args[0], 'install');
  assert.equal(invocation.args[invocation.args.indexOf('--prefix') + 1], root);
  assert.ok(invocation.args.includes('--workspaces=false'));
  assert.ok(invocation.args.includes('--global=false'));
  assert.equal(invocation.cwd, root);
  assert.equal(invocation.init, root);
  assert.equal(invocation.pwd, root);
  for (const key of ['workspace', 'workspaces', 'global', 'prefix']) assert.equal(invocation[key], null);
  assert.ok(output.some(item => item.stream === 'stdout' && item.value.includes('fixture stdout')));
  assert.ok(output.some(item => item.stream === 'stderr' && item.value.includes('fixture stderr')));
});

test('installer cancellation waits for its own process tree, including a descendant that ignores SIGTERM', { timeout: 15_000 }, async t => {
  const base = await fixture(t), root = path.join(base, 'interrupted installer');
  await mkdir(root);
  const launcher = path.join(base, 'npm-cli.js');
  const descendantCode = "process.on('SIGTERM',()=>{});process.stdout.write('descendant:'+process.pid+'\\n');setInterval(()=>{},1000);";
  await writeFile(launcher, `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','pipe','inherit']});
process.stdout.write('installer:'+process.pid+'\\n');child.stdout.pipe(process.stdout);setInterval(()=>{},1000);
`);
  const previous = process.env.npm_execpath;
  const controller = new AbortController();
  let output = '', installerPid, descendantPid, watchdog, installation;
  try {
    process.env.npm_execpath = launcher;
    installation = installProject(root, { signal: controller.signal, onOutput: value => {
      output += value;
      installerPid = Number(/installer:(\d+)/.exec(output)?.[1]) || installerPid;
      descendantPid = Number(/descendant:(\d+)/.exec(output)?.[1]) || descendantPid;
      if (installerPid && descendantPid) controller.abort();
    } });
    const timeout = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Installer tree did not exit after cancellation.')), 10_000); });
    await assert.rejects(Promise.race([installation, timeout]), { name: 'AbortError' });
    assert.ok(installerPid && descendantPid, output);
    for (const pid of [installerPid, descendantPid]) await assertStopped(pid);
  } finally {
    clearTimeout(watchdog);
    if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous;
    // If a regression fails the test, stop only the processes created above.
    for (const pid of [descendantPid, installerPid]) if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await installation?.catch(() => {});
  }
});

test('POSIX cancellation stops a descendant with closed npm pipes after its parent exits', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const base = await fixture(t), root = path.join(base, 'closed installer pipes');
  await mkdir(root);
  const launcher = path.join(base, 'npm-cli.js');
  const readyFile = path.join(root, 'descendant-ready.json');
  const descendantCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
  await writeFile(launcher, `const {spawn}=require('node:child_process');const fs=require('node:fs');
spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});
const ready=setInterval(()=>{try{const child=JSON.parse(fs.readFileSync(${JSON.stringify(readyFile)},'utf8'));clearInterval(ready);process.stdout.write('installer:'+process.pid+' descendant:'+child.pid+'\\n');}catch{}},10);
setInterval(()=>{},1000);
`);
  const previous = process.env.npm_execpath;
  const controller = new AbortController();
  let output = '', installerPid, descendantPid, watchdog, installation;
  try {
    process.env.npm_execpath = launcher;
    installation = installProject(root, { signal: controller.signal, onOutput: value => {
      output += value;
      installerPid = Number(/installer:(\d+)/.exec(output)?.[1]) || installerPid;
      descendantPid = Number(/descendant:(\d+)/.exec(output)?.[1]) || descendantPid;
      if (installerPid && descendantPid) controller.abort();
    } });
    const timeout = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Installer cancellation did not complete.')), 10_000); });
    await assert.rejects(Promise.race([installation, timeout]), { name: 'AbortError' });
    assert.ok(installerPid && descendantPid, output);
    await assertStopped(installerPid);
    await assertStopped(descendantPid);
  } finally {
    clearTimeout(watchdog);
    if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous;
    for (const pid of [descendantPid, installerPid]) if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await installation?.catch(() => {});
  }
});

test('create CLI prints portable instructions for a directory with spaces without installing or resolving native code', async t => {
  const base = await fixture(t), root = path.join(base, 'Human project with spaces & ampersand');
  const env = { ...process.env, PRNEXT_BINARY: path.join(base, 'native-must-not-be-resolved') };
  const result = await execute(process.execPath, [cli, 'create', root, '--no-install'], { cwd: base, env, timeout: 15_000 });
  assert.ok(result.stdout.includes(`Open ${root} in your terminal, then run:`));
  assert.match(result.stdout, /npm install/);
  assert.match(result.stdout, /npm run dev/);
  assert.doesNotMatch(result.stdout, /^\s*cd\s/m);
  assert.equal(result.stderr, '');
  assert.equal((await readPackage(root)).dependencies[packageManifest.name], packageManifest.version);
  assert.equal(await exists(path.join(root, 'node_modules')), false);
  assert.equal(await exists(path.join(root, '.prnext-create.lock')), false);
});

test('create CLI help and invalid commands leave destination content untouched', async t => {
  const base = await fixture(t), root = path.join(base, 'existing target');
  const env = { ...process.env, PRNEXT_BINARY: path.join(base, 'native-must-not-be-resolved') };
  const invoke = args => execute(process.execPath, [cli, ...args], { cwd: base, env, timeout: 15_000 });
  const help = await invoke(['create', '--help']);
  assert.match(help.stdout, /prnext create <directory>/);
  for (const option of ['--no-install', '--js', '--json']) assert.ok(help.stdout.includes(option));
  assert.deepEqual(await readdir(base), []);
  await mkdir(root);
  await writeFile(path.join(root, '.keep'), 'preserve me\n');
  for (const args of [['create', '--no-install'], ['create', root, '--force', '--no-install'],
    ['create', root, 'extra', '--no-install'], ['create', root, '--no-install'], ['create', '--help', root], ['creat', root]]) {
    await assert.rejects(invoke(args), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /PRNext:/);
      return true;
    });
    assert.deepEqual(await readdir(root), ['.keep']);
    assert.equal(await readFile(path.join(root, '.keep'), 'utf8'), 'preserve me\n');
    assert.deepEqual(await readdir(base), ['existing target']);
  }
});
