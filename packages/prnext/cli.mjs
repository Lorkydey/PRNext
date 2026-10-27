#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, rm, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveNativeBinary, packageManifest } from './native/resolve.mjs';
import { replaceWithNative } from './native/launch.mjs';
import { readBuildDirectory } from './runtime/build-directory.mjs';

const [command = 'help', ...argv] = process.argv.slice(2);
const help = `PRNext ${packageManifest.version}

Use prnext for portable scripts; prn is a shortcut on compatible shells.

  prnext create <directory>            Create a project and install dependencies
  prnext create <directory> --no-install  Prepare project files without installing
  prnext create --help                 TypeScript, JavaScript and creation options
  prnext build [directory]              Build React/TypeScript and static HTML
  prnext build [directory] --watch      Incremental production rebuilds on changes
  prnext build [directory] --adapter static [--from dist] [--spa]
                                       Import an existing public build directory
  prnext build [directory] --adapter auto
                                       Detect a completed browser build
  prnext build [directory] --adapter static --from .
                                       Build a plain HTML/CSS/JS site
  prnext output [directory] [--json]    Read the versioned build output contract
  prnext start [directory] [options]    Start native Rust production server
  prnext pstart [directory] [options]   Start production persistently in the background
  prnext prestart [name]                Replace a persistent app after a health check
  prnext pstop [name] [--all]            Stop persistent apps
  prnext pstatus [--json]               Show persistent app status (alias: plist)
  prnext plogs [name] [--follow]         Read persistent app logs
  prnext pstartup [--remove]            Configure restoration at user login
  prnext pstart --help                  All persistent commands and options
  prnext dev [directory] [options]      Rebuild and restart on source changes
  prnext dev [directory] --host-ai      Share local diagnostics with your connected Host AI
  prnext dev [directory] --safe         Use full builds and fresh workers for troubleshooting
  prnext mcp [directory]                Connect an AI to the running local dev server
  prnext docs --ai [topic]              Read the AI guide bundled with this version
  prnext docs --ai --init [directory]   Add a guide pointer to the project's AGENTS.md
  prnext routes [directory]             Display compiled routes
  prnext check [directory] [--json]      Diagnose config, routes, Node, native and dependencies
  prnext typegen [directory] [--json]    Generate route types without building the app
  prnext typecheck [directory] [--json]  Generate types and check TypeScript without building
  prnext inspect [directory] [--json|--otlp] Explain routes, health and sampled timings
  prnext analyze [directory] [--json] [--max-js 150]  Browser bundles and budget (kB)
  prnext compiler [directory] [--json]  React Compiler results from the last successful build
  prnext host [prnext.host.json]         Host built apps by hostname; wake on demand
  prnext host [config] --check           Validate hosting configuration and builds
  prnext host [config] --status [--json]  Show memory, process and idle status
  prnext migrate [directory] [options]   Migrate a Next project's scripts and dependencies
  prn login [--server URL]               Connect PRNext Cloud through your browser
  prn deploy [directory]                 Upload sources, deploy and link the project
  prn update [directory]                 Deploy changes to the linked Cloud project
  prn whoami / prn logout                Show or disconnect your terminal account
  prn deploy --help                     Cloud options and local development

Migration options: --dry-run (preview), --no-install (prepare only), --json
  prnext migrate --check                Audit source compatibility without migrating
  prnext migrate --check --against URL --candidate URL [--routes paths.json]
                                       Compare GET responses before switching
Migration keeps Next.js and backs up package.json and existing lockfiles.
Simple next dev/build/start scripts become prnext commands; custom shell scripts need a manual edit.
Installation honors npm, pnpm, Yarn Classic/Berry and the workspace root.
The preview reports the manager, root and selected workspace. Failed installs
restore the selected manifest/lockfiles; dependency caches may need a retry.

Type commands require an application tsconfig and TypeScript installation.
They generate route types unless typedRoutes: false, preserve JSONC/extends,
and report updates to tsconfig/prnext-env.d.ts. typecheck always checks errors.

Analysis options: --metric raw|gzip|brotli (default raw), --baseline analysis.json
  --max-js 150                         Maximum initial JS per route, in kB
  --max-increase-bytes 1024 --max-increase-percent 5
  --budgets budgets.json               Exact route keys with maxJs (kB),
                                       maxIncreaseBytes and/or maxIncreasePercent
Analysis exit codes: 0 passed, 1 budget exceeded or initial total unverifiable,
  2 invalid input or missing build. Request-dependent totals are lower bounds.

Server options: --port 3000 --hostname 127.0.0.1 --workers 1 --inspect
Production profiles: --profile balanced|speed|memory|classic
Worker retirement: --worker-idle-seconds 300 --lane-idle-seconds 30 --keep-warm [true|false]
Memory favors lower RAM under concurrency, accepting more waiting and CPU per response.
Without an option: PRNEXT_PROFILE, legacy PRNEXT_MEMORY_PROFILE=compact, then balanced.
Classic preserves the former standard settings; standard remains an alias. Legacy compact remains accepted.
Development includes React Fast Refresh, stylesheet updates and an error overlay.
Requires Node 22.23.4+, 24.22.1+ or 26.12.1+. Published packages include the native server for supported platforms.
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
  if (command === 'create') {
    const { createHelp, parseCreateArgs, createProject } = await import('./build/create.mjs');
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(createHelp); return; }
    const { directory, options } = parseCreateArgs(argv);
    const controller = new AbortController();
    let interrupted;
    const interrupt = signal => { interrupted = signal; controller.abort(); };
    const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    try {
      const report = await createProject(directory, { ...options, signal: controller.signal,
        onOutput: options.json ? () => {} : (chunk, stream) => process[stream].write(chunk) });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`PRNext project ${report.status}: ${report.root}`);
        if (report.error) console.error(report.error);
        if (!report.ok) console.log('Project files were preserved. Retry installation from this directory.');
        if (path.resolve(process.cwd()) !== directory) console.log(`\nOpen ${report.root} in your terminal, then run:`);
        for (const next of report.next) console.log(`  ${next}`);
      }
      if (!report.ok) process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
    } finally { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); }
    return;
  }
  if (command === 'docs') {
    const { executeAiDocs } = await import('./runtime/ai-docs.mjs');
    const result = await executeAiDocs(argv);
    process.stdout.write(result.output);
    return;
  }
  if (command === 'mcp') {
    if (argv.includes('--help') || argv.includes('-h')) { console.log('prnext mcp [directory]\nLocal development MCP over stdio. Start prnext dev first; no shell or production access is exposed.'); return; }
    if (argv.length > 1 || argv.some(arg => arg.startsWith('-'))) throw Error('mcp accepts only [directory]');
    const {runDevMcp}=await import('./runtime/dev-tools-mcp.mjs');
    await runDevMcp(path.resolve(argv[0] || '.'));return;
  }
  if (['login', 'logout', 'whoami', 'deploy', 'update'].includes(command)) {
    const { cloudCommand } = await import('./runtime/cloud/client.mjs');
    await cloudCommand(command, argv);
    return;
  }
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
  if (!['build', 'start', 'dev', 'routes', 'check', 'typegen', 'typecheck', 'inspect', 'analyze', 'compiler', 'output'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const args = [...argv];
  const root = path.resolve(args[0] && !args[0].startsWith('-') ? args.shift() : '.');
  if (['check','typegen','typecheck','analyze','compiler'].includes(command) && args.some(arg => ['--help','-h'].includes(arg))) { console.log(help); return; }
  if(command==='compiler'){
    try {
      if(args.some(arg=>arg!=='--json') || args.filter(arg=>arg==='--json').length>1)throw new Error('compiler accepts only [directory] and --json');
      const {readReactCompilerReport,printReactCompilerReport}=await import('./build/react-compiler-report.mjs');
      const {readBuildOutput}=await import('./build/output-contract.mjs');
      const directory=path.join(root,await readBuildDirectory(root));
      const output=await readBuildOutput(directory);
      if(output.adapter!=='react')throw new Error('React Compiler reports apply to React builds. This application uses the static adapter.');
      const report=await readReactCompilerReport(directory,{buildId:output.buildId});
      if(!report)throw new Error('No React Compiler report is available. Rebuild this application with the installed PRNext version.');
      if(args.includes('--json'))console.log(JSON.stringify(report,null,2));else printReactCompilerReport(report,{details:true});
    } catch(error) {
      if(args.includes('--json'))console.log(JSON.stringify({ok:false,error:error.message}));
      else console.error(`PRNext compiler: ${error.message}`);
      process.exitCode=2;
    }
    return;
  }
  if(command==='analyze'){
    try {
      const {analyzeBuild,printAnalysis,parseAnalysisArgs}=await import('./build/analyze.mjs');
      const options=parseAnalysisArgs(args),report=await analyzeBuild(root,options);
      if(options.json)console.log(JSON.stringify(report,null,2));else printAnalysis(report);
      if(!report.ok)process.exitCode=1;
    } catch(error) {
      if(args.includes('--json'))console.log(JSON.stringify({ok:false,error:error.message}));
      else console.error(`PRNext analysis: ${error.message}`);
      process.exitCode=2;
    }
    return;
  }
  if (command === 'typegen' || command === 'typecheck') {
    if (args.some(arg => arg !== '--json') || args.filter(arg => arg === '--json').length > 1) throw new Error(`${command} accepts only [directory] and --json`);
    const { runTypeCommand } = await import('./build/type-command.mjs');
    process.chdir(root);
    process.env.INIT_CWD = root;
    process.env.PWD = root;
    const report = await runTypeCommand(root, { check: command === 'typecheck' });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`PRNext ${command} ${report.ok ? 'passed' : 'failed'}: ${root}`);
      console.log(`${report.routes} page routes; tsconfig: ${report.tsconfig || 'unavailable'}; route types: ${report.typedRoutes ? 'enabled' : 'disabled'}.`);
      for (const file of report.updated) console.log(`Updated ${file}`);
      for (const note of report.notes) console.log(note);
      for (const error of report.errors) console.error(error);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'output') {
    if (args.some(arg => arg !== '--json')) throw new Error('output accepts only [directory] and --json');
    const { readBuildOutput } = await import('./build/output-contract.mjs');
    const output = await readBuildOutput(path.join(root, await readBuildDirectory(root)));
    if (args.includes('--json')) console.log(JSON.stringify(output, null, 2));
    else console.log(`PRNext output v${output.version}: ${output.adapter}\nBuild: ${output.buildId}\nManifest: ${output.manifest}\nAssets: ${output.assets}\nServer: ${output.server?.entry || 'none'}\nSPA fallback: ${output.fallback || 'disabled'}`);
    return;
  }
  if (command === 'inspect') {
    if (args.some(arg => !['--json', '--otlp'].includes(arg)) || args.includes('--json') && args.includes('--otlp')) throw new Error('inspect accepts [directory] and either --json or --otlp');
    const { inspectProject, printInspection, inspectionMetrics } = await import('./build/inspect.mjs');
    const report = await inspectProject(root);
    if (args.includes('--otlp')) console.log(JSON.stringify(inspectionMetrics(report), null, 2));
    else if (args.includes('--json')) console.log(JSON.stringify(report, null, 2)); else printInspection(report);
    return;
  }
  if (['start', 'dev'].includes(command) && args.includes('--inspect')) {
    args.splice(args.indexOf('--inspect'), 1);
    process.env.PRNEXT_INSPECT_DIR = path.join(root, '.prnext-cache/inspect');
    await mkdir(process.env.PRNEXT_INSPECT_DIR, {recursive:true, mode:0o700});
    process.env.PRNEXT_METRICS_FILE ||= path.join(process.env.PRNEXT_INSPECT_DIR, `metrics-${process.pid}.jsonl`);
    const old = (await readdir(process.env.PRNEXT_INSPECT_DIR)).filter(name => /^metrics-\d+\.jsonl$/.test(name));
    for (const name of old.slice(0, Math.max(0, old.length - 4))) {
      const pid = Number(name.slice(8,-6));
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') await rm(path.join(process.env.PRNEXT_INSPECT_DIR,name),{force:true}); }
    }
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
      for (const item of report.diagnostics) {
        const output = item.severity === 'error' ? console.error : console.log;
        output(`${item.severity}: ${item.message}${item.action ? ` ${item.action}` : ''}`);
      }
      for (const note of report.notes) console.log(note);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'build') {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--dev') options.dev = true;
      else if (flag === '--watch') options.watch = true;
      else if (flag === '--spa') options.spa = true;
      else if (flag === '--adapter' || flag === '--from') {
        const value = args[++i];
        if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
        const key = flag.slice(2);
        if (options[key] !== undefined) throw new Error(`Duplicate build option: ${flag}`);
        options[key] = value;
      } else throw new Error(`Unknown build option: ${flag}`);
    }
    const dev = !!options.dev;
    const envMode = process.env.NODE_ENV === 'test' ? 'test' : undefined;
    process.env.NODE_ENV = dev ? 'development' : 'production';
    const started = performance.now();
    if(options.watch){
      if(dev)throw new Error('--watch builds production; use prnext dev for development.');
      const {watchProduction}=await import('./build/production-builder.mjs');
      delete options.watch;await watchProduction(root,options);return;
    }
    if (options.adapter === undefined || options.adapter === 'auto') {
      const { detectBuildAdapter } = await import('./build/static-input.mjs');
      const selected = await detectBuildAdapter(root, { prepared: options.adapter === 'auto' });
      if (selected.adapter === 'static') Object.assign(options, selected);
      else if (options.adapter === 'auto') options.adapter = 'react';
    }
    if (options.adapter === 'static') {
      const { buildStatic } = await import('./build/static-adapter.mjs');
      await buildStatic(root, options);
    } else {
      const { build } = await import('./build/index.mjs');
      const result=await build(root, { ...options, dev, envMode });
      if(!dev&&result.compilationCache?.hits){
        const {hits,reusedBytes}=result.compilationCache;
        console.log(`Compilation cache: ${hits} ${hits===1?'graph':'graphs'} reused (${Math.ceil(reusedBytes/1024)} KiB).`);
      }
      if(result.reactCompilerReport?.enabled){
        const {printReactCompilerReport}=await import('./build/react-compiler-report.mjs');
        printReactCompilerReport(result.reactCompilerReport,{details:false});
      }
    }
    console.log(`PRNext built ${root} in ${((performance.now() - started) / 1000).toFixed(2)}s`);
    return;
  }
  const binary = await resolveNativeBinary();
  if(command==='dev') {const {develop}=await import('./runtime/development.mjs');await develop(root,args,binary);return;}
  const outputDirectory = await readBuildDirectory(root);
  const serverEnvironment = {...process.env,NODE_ENV:process.env.NODE_ENV||'production'};
  if(command==='start'&&serverEnvironment.NODE_ENV!=='development'){
    if(replaceWithNative(binary,['start',root,'--worker',path.join(root,outputDirectory,'runtime/worker.mjs'),
      '--node',process.execPath,...args],serverEnvironment))return;
  }
  const server=spawn(binary,[command==='routes'?'routes':'start',root,
    ...(command==='routes'?[]:['--worker',path.join(root,outputDirectory,'runtime/worker.mjs'),'--node',process.execPath,'--shutdown-on-stdin-eof']),...args],
    {stdio:['pipe','inherit','inherit'],windowsHide:true,env:serverEnvironment});
  let stopping=false;
  const shutdown=async()=>{if(stopping)return;stopping=true;await stop(server);};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  try{await done(server).catch(error=>{if(!stopping)throw error;});}
  finally{process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);await stop(server);}

}

main().catch(error => { console.error(`PRNext: ${error.message}`); process.exitCode = 1; });
