#!/usr/bin/env node
import { rename } from './runtime/fs.mjs';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveNativeBinary, packageManifest } from './native/resolve.mjs';
import { readBuildDirectory } from './runtime/build-directory.mjs';
import { shouldWatchProjectFile } from './runtime/env.mjs';

const self = fileURLToPath(import.meta.url);
const [command = 'help', ...argv] = process.argv.slice(2);
const help = `PRNext ${packageManifest.version}

Use prnext for portable scripts; prn is a shortcut on compatible shells.

  prnext build [directory]              Build React/TypeScript and static HTML
  prnext start [directory] [options]    Start native Rust production server
  prnext pstart [directory] [options]   Start production persistently in the background
  prnext prestart [name]                Replace a persistent app after a health check
  prnext pstop [name] [--all]            Stop persistent apps
  prnext pstatus [--json]               Show persistent app status (alias: plist)
  prnext plogs [name] [--follow]         Read persistent app logs
  prnext pstartup [--remove]            Configure restoration at user login
  prnext pstart --help                  All persistent commands and options
  prnext dev [directory] [options]      Rebuild and restart on source changes
  prnext routes [directory]             Display compiled routes
  prnext check [directory] [--json]      Check an existing Next project before building
  prnext inspect [directory] [--json]    Explain routes, cache decisions and timings
  prnext host [prnext.host.json]         Host built apps by hostname; wake on demand
  prnext host [config] --check           Validate hosting configuration and builds
  prnext host [config] --status [--json]  Show memory, process and idle status
  prnext migrate [directory] [options]   Migrate a Next project's scripts and dependencies

Migration options: --dry-run (preview), --no-install (prepare only), --json
  prnext migrate --check                Audit source compatibility without migrating
  prnext migrate --check --against URL --candidate URL [--routes paths.json]
                                       Compare GET responses before switching
Migration keeps Next.js and backs up package.json and existing lockfiles.
Simple next dev/build/start scripts become prnext commands; custom shell scripts need a manual edit.

Server options: --port 3000 --hostname 127.0.0.1 --workers 1 --inspect
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
    if (child.stdin) child.stdin.end();
    else child.kill('SIGTERM');
  });
}

async function main() {
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (['--version', '-v'].includes(command)) { console.log(packageManifest.version); return; }
  if (['pstart', 'prestart', 'pstop', 'pstatus', 'plist', 'plogs', 'pdelete', 'pstartup', 'pdown'].includes(command)) {
    const { persistentCommand } = await import('./runtime/persistent/client.mjs');
    await persistentCommand(command, argv);
    return;
  }
  if (command === 'host') {
    if (argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
    const files = argv.filter(arg => !arg.startsWith('-'));
    if (files.length > 1 || argv.some(arg => arg.startsWith('-') && !['--status', '--json', '--check'].includes(arg))) throw new Error('host accepts [config], --check, or --status [--json]');
    const config = path.resolve(files[0] || 'prnext.host.json');
    if (argv.includes('--status') && argv.includes('--check')) throw new Error('Choose --check or --status for the host command.');
    if (argv.includes('--status')) {
      const info = path.parse(config);
      const report = JSON.parse(await readFile(path.join(info.dir, info.name + '.status.json'), 'utf8'));
      report.snapshotAgeMs = Date.now() - report.time;
      if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`PRNext host: ${report.reservedMb}/${report.memoryMb} MiB reserved; snapshot ${Math.round(report.snapshotAgeMs / 1000)}s ago${report.stopping ? ' (stopped)' : ''}`);
        for (const app of report.apps) console.log(`${app.name}: ${app.state}, ${(app.rssBytes / 1024 / 1024).toFixed(1)}/${app.memoryMb} MiB RSS, ${app.activeRequests} active request(s), ${app.starts} start(s) — ${app.reason}`);
      }
      return;
    }
    if (argv.includes('--json')) throw new Error('--json requires --status');
    const binary = await resolveNativeBinary();
    const child = spawn(binary, ['host', config, '--node', process.execPath, '--shutdown-on-stdin-eof', ...(argv.includes('--check') ? ['--check'] : [])], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    const shutdown = () => child.stdin.end();
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    await done(child);
    return;
  }
  if (command === 'migrate') {
    if (argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
    const { parseMigrationArgs, migrateProject } = await import('./build/migrate.mjs');
    const { directory, options } = parseMigrationArgs(argv);
    if (options.check) {
      const { auditMigration, compareServers } = await import('./build/migration-audit.mjs');
      const report = await auditMigration(directory);
      if (options.against) {
        const routes = options.routes ? JSON.parse(await readFile(path.resolve(options.routes), 'utf8'))
          : report.routes.filter(route => route.kind === 'page' && !route.pattern.includes('[')).map(route => route.pattern);
        report.comparison = await compareServers({ ...options, routes });
        report.ok &&= report.comparison.ok;
      }
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`PRNext migration check ${report.ok ? 'passed' : 'failed'}: ${directory}`);
        console.log(`${report.files} source files; ${report.routes.length} routes.`);
        for (const item of report.findings) console.log(`${item.severity.toUpperCase()} ${item.file || 'project'}${item.line ? ':' + item.line : ''}: ${item.message}\n  ${item.action}`);
        for (const result of report.comparison?.results || []) console.log(`${result.equal ? 'MATCH' : 'DIFFERENT'} ${result.route}: ${result.error || result.differences.join(', ') || 'responses match'}`);
        for (const note of [...report.notes, ...(report.comparison ? [report.comparison.scope] : [])]) console.log(note);
      }
      if (!report.ok) process.exitCode = 1;
      return;
    }
    const report = await migrateProject(directory, options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`PRNext migration ${report.status}: ${report.root}`);
      for (const change of report.changes) console.log(`  ${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
      for (const backup of report.backups) console.log(`Backup: ${backup}`);
      for (const note of report.notes) console.log(note);
      if (report.error) console.error(report.error);
      if (report.ok && !options.dryRun) console.log(options.install ? 'Next: npm run build, then npm start (or npm run dev).' : 'Next: install dependencies with your package manager, then prnext check and prnext build.');
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (!['build', 'start', 'dev', 'routes', 'check', 'inspect'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const args = [...argv];
  const root = path.resolve(args[0] && !args[0].startsWith('-') ? args.shift() : '.');
  if (command === 'inspect') {
    if (args.some(arg => arg !== '--json')) throw new Error('inspect accepts only [directory] and --json');
    const { inspectProject, printInspection } = await import('./build/inspect.mjs');
    const report = await inspectProject(root);
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2)); else printInspection(report);
    return;
  }
  if (['start', 'dev'].includes(command) && args.includes('--inspect')) {
    args.splice(args.indexOf('--inspect'), 1);
    process.env.PRNEXT_INSPECT_DIR = path.join(root, '.prnext-cache/inspect');
  }
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
    ...(command === 'routes' ? [] : ['--worker', path.join(root, outputDirectory, 'runtime/worker.mjs'), '--node', process.execPath,
      '--shutdown-on-stdin-eof']), ...args], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, env: { ...process.env, NODE_ENV: process.env.NODE_ENV || (command === 'dev' ? 'development' : 'production') } });
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
      if (stopping) return;
      if (attempted && !actualChanges.length) return;
      attempted = true;
      const changed = actualChanges.slice(0, 32).map(file => file.slice(0, 256));
      await notifyDev({ state: 'building' });
      if (actualChanges.some(file => /(?:^|\/)(?:(?:next|prnext|contentlayer)\.config\.|package(?:-lock)?\.json$|(?:pnpm-lock\.yaml|yarn\.lock)$)/.test(file))) { await stop(rebuildChild); rebuildChild = undefined; }
      if (stopping) return;
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
        // Shutdown can arrive while the previous server is draining. Never
        // leave a replacement running after shutdown already stopped its peers.
        if (stopping) return;
        for (const file of changedFiles) {
          if (file === outputDirectory || file.startsWith(outputDirectory + '/') || outputDirectory.startsWith(file + '/')) changedFiles.delete(file);
        }
        if (!changedFiles.size) { clearTimeout(timer); queued = false; }
        server = launch();
        server.on('error', error => console.error(`PRNext server: ${error.message}`));
        const manifest = JSON.parse(await readFile(path.join(root, outputDirectory, 'manifest.json'), 'utf8'));
        if (stopping) return;
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
    if (stopping) return;
    const relative = String(filename || '').replaceAll(path.sep, '/');
    if (relative === outputDirectory || relative.startsWith(outputDirectory + '/') || !shouldWatchProjectFile(filename)) return;
    changedFiles.add(String(filename).replaceAll(path.sep, '/'));
    clearTimeout(timer);
    timer = setTimeout(() => { if (changedFiles.size) void rebuild(); }, 150);
    },
  });
  if (stopping) { watcher.close(); return; }
  await rebuild();
}

main().catch(error => { console.error(`PRNext: ${error.message}`); process.exitCode = 1; });
