#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveNativeBinary, packageManifest } from './native/resolve.mjs';
import { readBuildDirectory } from './runtime/build-directory.mjs';
import { shouldWatchProjectFile } from './runtime/env.mjs';

const self = fileURLToPath(import.meta.url);
const [command = 'help', ...argv] = process.argv.slice(2);
const help = `PRNext ${packageManifest.version}

Use prnext or prn: both names run the same CLI.

  prnext build [directory]             Build React/TypeScript and static HTML
  prnext start [directory] [options]   Start native Rust production server
  prnext dev [directory] [options]     Rebuild and restart on source changes
  prnext routes [directory]           Display compiled routes
  prnext check [directory] [--json]   Check an existing Next project before building
  prn migrate [directory] [options]   Migrate a Next project's scripts and dependencies

Migration options: --dry-run (preview), --no-install (prepare only), --json
Migration keeps Next.js and backs up package.json and existing lockfiles.
Simple next dev/build/start scripts become prn commands; custom shell scripts need a manual edit.

Server options: --port 3000 --hostname 127.0.0.1 --workers 1
Production profiles: --profile balanced|speed|memory|classic
Memory favors lower RAM under concurrency, accepting more waiting and CPU per response.
Without an option: PRNEXT_PROFILE, legacy PRNEXT_MEMORY_PROFILE=compact, then balanced.
Classic preserves the former standard settings; standard remains an alias. Legacy compact remains accepted.
Development includes React Fast Refresh, stylesheet updates and an error overlay.
Requires Node >=22. Published packages include the native server for supported platforms.
Rust is only needed when building the framework from source.
`;

function done(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Process exited ${signal || code}`)));
  });
}
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function main() {
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (['--version', '-v'].includes(command)) { console.log(packageManifest.version); return; }
  if (command === 'migrate') {
    if (argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
    const { parseMigrationArgs, migrateProject } = await import('./build/migrate.mjs');
    const { directory, options } = parseMigrationArgs(argv);
    const report = await migrateProject(directory, options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`PRNext migration ${report.status}: ${report.root}`);
      for (const change of report.changes) console.log(`  ${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
      for (const backup of report.backups) console.log(`Backup: ${backup}`);
      for (const note of report.notes) console.log(note);
      if (report.error) console.error(report.error);
      if (report.ok && !options.dryRun) console.log(options.install ? 'Next: npm run build, then npm start (or npm run dev).' : 'Next: install dependencies with your package manager, then prn check and prn build.');
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (!['build', 'start', 'dev', 'routes', 'check'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const args = [...argv];
  const root = path.resolve(args[0] && !args[0].startsWith('-') ? args.shift() : '.');
  if (command === 'build' || command === 'dev') {
    // Build plugins such as Contentlayer read cwd/INIT_CWD rather than webpack's
    // context. Explicit application directories must behave like `cd app`.
    process.chdir(root);
    process.env.INIT_CWD = root;
    process.env.PWD = root;
  }
  if (command === 'check') {
    if (args.some(arg => arg !== '--json')) throw new Error('check accepts only [directory] and --json');
    const { checkProject } = await import('./build/check.mjs');
    const report = await checkProject(root);
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`PRNext preflight ${report.ok ? 'passed' : 'failed'}: ${root}`);
      console.log(`${report.routes.length} routes. Installed versions: ${Object.entries(report.versions).map(([name,version])=>`${name}@${version||'missing'}`).join(', ')}`);
      for (const error of report.errors) console.error(error);
      for (const note of report.notes) console.log(note);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'build') {
    const dev = args.includes('--dev');
    if (args.some(arg => arg !== '--dev')) throw new Error('build accepts only [directory] and --dev');
    const envMode = process.env.NODE_ENV === 'test' ? 'test' : undefined;
    process.env.NODE_ENV = dev ? 'development' : 'production';
    const { build } = await import('./build/index.mjs');
    const started = performance.now();
    await build(root, { dev, envMode });
    console.log(`PRNext built ${root} in ${((performance.now() - started) / 1000).toFixed(2)}s`);
    return;
  }
  const binary = await resolveNativeBinary();
  let outputDirectory = await readBuildDirectory(root);
  const launch = () => spawn(binary, [command === 'routes' ? 'routes' : 'start', root,
    ...(command === 'routes' ? [] : ['--worker', path.join(root, outputDirectory, 'runtime/worker.mjs')]), ...args], { stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || (command === 'dev' ? 'development' : 'production') } });
  let server;
  let stopping = false;
  let watcher;
  let rebuildChild;
  let timer;
  const devStateFile = path.join(root, '.prnext-dev.json');
  const changedFiles = new Set();
  async function notifyDev(value) {
    const temporary = `${devStateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, devStateFile);
  }
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    watcher?.close();
    await Promise.all([stop(server), stop(rebuildChild)]);
    if (command === 'dev') await rm(devStateFile, { force: true });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (command !== 'dev') {
    server = launch();
    await done(server).catch(error => { if (!stopping) throw error; });
    return;
  }
  let building = false;
  let queued = false;
  let attempted = false;
  const {createDevChangeFilter} = await import('./runtime/dev-file-changes.mjs');
  const filterChanges = createDevChangeFilter(root);
  async function rebuild() {
    if (stopping) return;
    if (building) { queued = true; return; }
    building = true;
    const pending = [...changedFiles];
    changedFiles.clear();
    let buildOutput = '';
    try {
      const actualChanges = await filterChanges(pending);
      if (attempted && !actualChanges.length) return;
      attempted = true;
      const changed = actualChanges.slice(0, 32).map(file => file.slice(0, 256));
      await notifyDev({ state: 'building' });
      if (actualChanges.some(file => /(?:^|\/)(?:(?:next|prnext|contentlayer)\.config\.|package(?:-lock)?\.json$|(?:pnpm-lock\.yaml|yarn\.lock)$)/.test(file))) { await stop(rebuildChild); rebuildChild = undefined; }
      if (!rebuildChild || rebuildChild.exitCode !== null || rebuildChild.signalCode) {
        rebuildChild = spawn(process.execPath, [path.join(path.dirname(self), 'build/dev-worker.mjs')], { stdio: ['inherit', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' } });
      }
      const stdout = chunk => { process.stdout.write(chunk); buildOutput = (buildOutput + chunk).slice(-12_000); };
      const stderr = chunk => { process.stderr.write(chunk); buildOutput = (buildOutput + chunk).slice(-12_000); };
      rebuildChild.stdout.on('data', stdout); rebuildChild.stderr.on('data', stderr);
      let result;
      try {
        result = await new Promise((resolve, reject) => {
          const worker = rebuildChild;
          const cleanup = () => { worker.off('message', message); worker.off('exit', exited); worker.off('error', failed); };
          const message = value => { if (value?.type === 'result') { cleanup(); resolve(value); } };
          const exited = (code, signal) => { cleanup(); reject(new Error(`Compiler exited ${signal || code}`)); };
          const failed = error => { cleanup(); reject(error); };
          worker.on('message', message); worker.once('exit', exited); worker.once('error', failed);
          worker.send({type:'build',root});
        });
      } finally { rebuildChild.stdout.off('data', stdout); rebuildChild.stderr.off('data', stderr); }
      if (result.recycle) { await stop(rebuildChild); rebuildChild = undefined; }
      if (!result.ok) throw new Error(result.error);
      filterChanges.acceptInputs(result.inputs || []);
      if (!stopping) {
        await stop(server);
        outputDirectory = await readBuildDirectory(root);
        await watcher.refresh();
        for (const file of changedFiles) {
          if (file === outputDirectory || file.startsWith(outputDirectory + '/') || outputDirectory.startsWith(file + '/')) changedFiles.delete(file);
        }
        if (!changedFiles.size) { clearTimeout(timer); queued = false; }
        server = launch();
        server.on('error', error => console.error(`PRNext server: ${error.message}`));
        const manifest = JSON.parse(await readFile(path.join(root, outputDirectory, 'manifest.json'), 'utf8'));
        await notifyDev({ state: 'ready', buildId: manifest.buildId, clientManifest: manifest.devClient, changed });
        console.log('Source compiled. React Fast Refresh applied in connected browsers.');
      }
    } catch (error) { if (!stopping) { console.error(`Build failed: ${error.message}`); await notifyDev({ state: 'error', error: buildOutput || error.message }); } }
    finally { building = false; if (queued && !stopping) { queued = false; void rebuild(); } }
  }
  const { watchProject } = await import('./runtime/watch-project.mjs');
  watcher = await watchProject(root, {
    ignore: relative => relative === outputDirectory || relative.startsWith(outputDirectory + '/'),
    onError: error => { console.error(`PRNext development watcher: ${error.message}`); process.exitCode = 1; void shutdown(); },
    onChange: filename => {
    const relative = String(filename || '').replaceAll(path.sep, '/');
    if (relative === outputDirectory || relative.startsWith(outputDirectory + '/') || !shouldWatchProjectFile(filename)) return;
    changedFiles.add(String(filename).replaceAll(path.sep, '/'));
    clearTimeout(timer);
    timer = setTimeout(() => { if (changedFiles.size) void rebuild(); }, 150);
    },
  });
  await rebuild();
}

main().catch(error => { console.error(`PRNext: ${error.message}`); process.exitCode = 1; });
