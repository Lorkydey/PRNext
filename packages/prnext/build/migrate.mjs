import { rename } from '../runtime/fs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { readFile, writeFile, rm, lstat, realpath, access } from 'node:fs/promises';
import { checkProject } from './check.mjs';
import { sourceCheckout } from '../native/resolve.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies'];
const locks = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function optionalFile(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function parseMigrationArgs(args) {
  const options = { dryRun: false, install: true, json: false };
  let directory;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--check') options.check = true;
    else if (['--against', '--candidate', '--routes', '--timeout'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = arg === '--timeout' ? Number(value) : value;
    }
    else if (arg === '--no-install') options.install = false;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown migrate option: ${arg}. Use --check, --dry-run, --no-install or --json.`);
    else if (directory === undefined) directory = arg;
    else throw new Error('migrate accepts a single project directory.');
  }
  if ((options.against || options.candidate || options.routes || options.timeout !== undefined) && (!options.check || !options.against || !options.candidate)) throw new Error('Server comparison requires --check, --against and --candidate.');
  return { directory: path.resolve(directory || '.'), options };
}

// Preserve literal shell words without evaluating them. Complex shell programs
// need a manual edit: replacing a substring could drop a build step or rewrite
// a quoted example instead of the executable command.
function words(script) {
  if (/[\r\n]/.test(script)) throw new Error('contains multiple shell lines');
  const result = [];
  const token = /\s*((?:[^\s'"\\;&|<>`$()*?#[\]{}~!]+|'[^']*'|"[^"\\`$]*")+)/gy;
  let offset = 0;
  while (offset < script.length) {
    if (!script.slice(offset).trim()) break;
    token.lastIndex = offset;
    const match = token.exec(script);
    if (!match) throw new Error('contains shell chaining, substitution or escaping');
    result.push({ raw: match[1], value: match[1].replace(/'([^']*)'|"([^"]*)"/g, (_all, a, b) => a ?? b) });
    offset = token.lastIndex;
  }
  return result;
}

export function migrateScript(script, command) {
  // PRN is a reserved device name in older Windows shells. Generated scripts
  // must remain portable even when migration runs on another operating system.
  if (script === undefined) return { value: `prnext ${command}`, removed: [] };
  if (typeof script !== 'string') throw new Error(`scripts.${command} must be a string.`);
  // Existing PRNext scripts, including customized wrappers, are not rewritten.
  if (/^(?:prn|prnext)\s+/.test(script.trim())) return { value: script, removed: [] };
  let tokens;
  try { tokens = words(script); }
  catch (error) { throw new Error(`scripts.${command} ${error.message}. Adapt it to prnext ${command} manually before migrating; no scripts were overwritten.`); }
  const prefix = [];
  let environmentPort;
  if (tokens[0]?.value === 'cross-env') prefix.push(tokens.shift().raw);
  while (tokens[0] && /^[A-Za-z_][A-Za-z\d_]*=/.test(tokens[0].value)) {
    const assignment = tokens.shift();
    prefix.push(assignment.raw);
    if (assignment.value.startsWith('PORT=')) environmentPort = assignment.value.slice(5);
  }
  if (tokens[0]?.value === 'npx') {
    tokens.shift();
    if (tokens[0]?.value === '--no-install') tokens.shift();
  }
  const executable = tokens.shift()?.value;
  if (!['next', 'rx'].includes(executable) || tokens.shift()?.value !== command) {
    throw new Error(`scripts.${command} is customized. Adapt it to prnext ${command} manually before migrating; no scripts were overwritten.`);
  }
  // Upgrade the former shortcut without interpreting its native PRNext options
  // as Next.js bundler flags. Complex shell programs still require a manual edit.
  if (executable === 'rx') return { value: [...prefix, 'prnext', command, ...tokens.map(token => token.raw)].join(' '), removed: [] };
  const kept = [], removed = [];
  let directory = false, explicitPort = false;
  for (let i = 0; i < tokens.length; i++) {
    const { value, raw } = tokens[i];
    if (['--turbo', '--turbopack', '--webpack'].includes(value) && command !== 'start') { removed.push(value); continue; }
    const option = /^(-p|--port|-H|--hostname)(?:=(.*))?$/.exec(value);
    if (option && command !== 'build') {
      const flag = ['-p', '--port'].includes(option[1]) ? '--port' : '--hostname';
      if (flag === '--port') explicitPort = true;
      if (option[2] !== undefined) kept.push(raw.replace(/^(['"]?)(?:-p|--port|-H|--hostname)/, `$1${flag}`));
      else {
        const argument = tokens[++i];
        if (!argument || argument.value.startsWith('-')) throw new Error(`scripts.${command}: ${option[1]} requires a value.`);
        kept.push(flag, argument.raw);
      }
    } else if (!value.startsWith('-') && !directory) {
      directory = true;
      // The PRNext CLI takes the directory before its server options.
      kept.unshift(raw);
    } else throw new Error(`scripts.${command}: unsupported Next option ${raw}. Adapt the script before migrating.`);
  }
  // The native server takes an explicit port; preserve Next's literal PORT
  // prefix when the script does not already override it with a CLI option.
  if (command !== 'build' && !explicitPort && environmentPort !== undefined) {
    if (!/^\d+$/.test(environmentPort) || Number(environmentPort) > 65535) throw new Error(`scripts.${command}: PORT must be a literal port number. Adapt the script before migrating.`);
    kept.push('--port', environmentPort);
  }
  return { value: [...prefix, 'prnext', command, ...kept].join(' '), removed };
}

export function migrationPackage(input, framework, spec) {
  if (!record(input)) throw new Error('package.json must contain an object.');
  for (const field of ['scripts', ...dependencyFields]) {
    if (input[field] !== undefined && !record(input[field])) throw new Error(`package.json ${field} must be an object.`);
  }
  const output = structuredClone(input);
  const changes = [], notes = [];
  output.scripts ||= {};
  for (const command of ['dev', 'build', 'start']) {
    const previous = input.scripts?.[command];
    const migrated = migrateScript(previous, command);
    if (previous === migrated.value) continue;
    if (previous !== undefined) {
      let backup = `${command}:next`, suffix = 2;
      while (own(output.scripts, backup) && output.scripts[backup] !== previous) backup = `${command}:next:${suffix++}`;
      if (!own(output.scripts, backup)) {
        output.scripts[backup] = previous;
        changes.push({ field: `scripts.${backup}`, before: null, after: previous });
      }
    }
    output.scripts[command] = migrated.value;
    changes.push({ field: `scripts.${command}`, before: previous ?? null, after: migrated.value });
    if (migrated.removed.length) notes.push(`scripts.${command}: removed Next bundler flags ${migrated.removed.join(', ')}; PRNext selects its compiler from the project configuration.`);
  }
  const expected = framework.peerDependencies['react-server-dom-webpack'];
  const wanted = { [framework.name]: spec, react: expected, 'react-dom': expected, 'react-server-dom-webpack': expected };
  // Remove the former local package name so two packages cannot compete for
  // the same prn/prnext executable after installing the scoped release.
  if (framework.name !== 'prnext') {
    for (const field of dependencyFields) {
      if (!output[field] || !own(output[field], 'prnext')) continue;
      changes.push({ field: `${field}.prnext`, before: output[field].prnext, after: null });
      delete output[field].prnext;
    }
  }
  output.dependencies ||= {};
  for (const [name, version] of Object.entries(wanted)) {
    if (output.dependencies[name] !== version) {
      changes.push({ field: `dependencies.${name}`, before: output.dependencies[name] ?? null, after: version });
      output.dependencies[name] = version;
    }
    for (const field of ['devDependencies', 'optionalDependencies']) {
      if (output[field] && own(output[field], name)) {
        changes.push({ field: `${field}.${name}`, before: output[field][name], after: null });
        delete output[field][name];
      }
    }
  }
  if (changes.some(change => /^dependencies\.react/.test(change.field))) notes.push(`React protocol packages are aligned to ${expected}. Check other libraries' peer dependencies during installation.`);
  notes.push('Next.js, application sources and next.config files are kept. Existing Next scripts are saved as dev:next, build:next and start:next when applicable.');
  return { package: output, changes, notes };
}

async function installContext(root, pkg) {
  const present = [];
  for (const name of locks) if (await optionalFile(path.join(root, name))) present.push(name);
  const manager = pkg.packageManager?.split('@')[0];
  if (manager && manager !== 'npm') return { allowed: false, reason: `This project uses ${manager}. Use --no-install, then install with ${manager}.`, locks: present };
  if (present.some(name => !['package-lock.json', 'npm-shrinkwrap.json'].includes(name))) {
    return { allowed: false, reason: 'A non-npm lockfile is present. Use --no-install and the existing package manager to preserve its lockfile.', locks: present };
  }
  for (let directory = root; ; directory = path.dirname(directory)) {
    const contents = directory === root ? null : await optionalFile(path.join(directory, 'package.json'));
    let ancestor;
    try { ancestor = directory === root ? pkg : contents && JSON.parse(contents); } catch { ancestor = null; }
    if (ancestor?.workspaces) return { allowed: false, reason: 'A workspace package manager must be run from its workspace root. Use --no-install, then install from that root.', locks: present };
    if (directory === path.dirname(directory)) break;
  }
  return { allowed: true, locks: present };
}

async function backup(file, contents) {
  for (let index = 0; index < 1000; index++) {
    const destination = `${file}.prnext-backup${index ? '.' + index : ''}`;
    try { await writeFile(destination, contents, { flag: 'wx', mode: 0o600 }); return destination; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await readFile(destination)).equals(contents)) return destination;
    }
  }
  throw new Error(`Too many migration backups for ${file}.`);
}

async function replacePackage(file, original, text, mode) {
  const temporary = `${file}.prnext-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode });
    if (!(await readFile(file)).equals(original)) throw new Error('package.json changed during migration. Retry after the other edit finishes.');
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function installMigrationDependencies(root, { json = false, local = false } = {}) {
  const npm = process.env.npm_execpath;
  // Never use a shell to interpolate a project path or a package specification.
  const args = ['install', '--workspaces=false', ...(local ? ['--install-links=false'] : [])];
  const command = npm && /(?:^|[/\\])npm(?:-cli)?\.(?:c?js)$/.test(npm) ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const argv = command === process.execPath ? [npm, ...args] : args;
  await new Promise((resolve, reject) => {
    // Windows .cmd launchers require a shell; argv contains only fixed flags,
    // never project data. npx/npm invocations use npm-cli.js directly instead.
    const child = spawn(command, argv, { cwd: root, stdio: json ? ['inherit', 2, 2] : 'inherit', shell: process.platform === 'win32' && command === 'npm.cmd' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`npm install failed (${signal || code}). Backups are available; fix the dependency conflict and retry. No --force or --legacy-peer-deps override was used.`)));
  });
  for (const name of ['prn', 'prnext']) {
    const executable = path.join(root, 'node_modules/.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
    try { await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK); }
    catch { throw new Error(`npm did not install the ${name} executable. Check npm's bin-links setting and the local PRNext dependency path, then retry.`); }
  }
}

export async function migrateProject(directory, { dryRun = false, install = true, json = false } = {}, services = {}) {
  const root = path.resolve(directory), file = path.join(root, 'package.json');
  const report = { root, ok: false, status: 'checking', dryRun, changes: [], backups: [], notes: [], preflight: null };
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error('Migration requires a regular package.json file, not a symlink or directory.');
    const original = await readFile(file);
    const source = original.toString('utf8');
    const input = JSON.parse(source.replace(/^\uFEFF/, ''));
    if (!record(input)) throw new Error('package.json must contain an object.');
    const framework = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if ([framework.name, 'prnext', 'prnext-monorepo'].includes(input.name)) throw new Error('Choose the Next.js application directory, not the PRNext framework repository.');
    const local = sourceCheckout() !== null;
    // npm resolves file dependencies from the physical working directory. A
    // symlink such as macOS /var -> /private/var otherwise changes ../ depth.
    const relative = path.relative(await realpath(root), await realpath(packageRoot)).split(path.sep).join('/') || '.';
    const spec = local ? `file:${relative}` : framework.version;
    const plan = migrationPackage(input, framework, spec);
    report.changes = plan.changes;
    report.notes = plan.notes;
    if (local) report.notes.push(`This unpublished checkout uses a local PRNext dependency (${spec}); keep this checkout available. Rust is required on the first native build.`);
    const context = await installContext(root, input);
    if (!context.allowed) {
      report.notes.push(context.reason);
      if (install && !dryRun) throw new Error(context.reason);
    }
    const check = services.check || checkProject;
    report.preflight = await check(root, { validateDependencies: false });
    if (!report.preflight.ok) throw new Error(`Project preflight failed: ${report.preflight.errors.join(' ')}`);
    if (!report.preflight.routes.length) throw new Error('No application routes found. Choose the Next.js app directory containing app/ or pages/.');
    if (dryRun) { report.ok = true; report.status = 'preview'; return report; }
    if (plan.changes.length || install) {
      report.backups.push(await backup(file, original));
      for (const name of context.locks) {
        const lockFile = path.join(root, name);
        const stat = await lstat(lockFile);
        if (!stat.isFile()) throw new Error(`Migration requires a regular ${name} file.`);
        report.backups.push(await backup(lockFile, await readFile(lockFile)));
      }
    }
    if (plan.changes.length) {
      const indent = /\n([\t ]+)"/.exec(source)?.[1] || 2;
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const text = (source.startsWith('\uFEFF') ? '\uFEFF' : '') + JSON.stringify(plan.package, null, indent).replaceAll('\n', newline) + (/\r?\n$/.test(source) ? newline : '');
      await replacePackage(file, original, text, stat.mode & 0o777);
    }
    report.status = plan.changes.length ? 'prepared' : 'unchanged';
    if (!install) {
      report.ok = true;
      report.notes.push('Dependency installation and installed-version validation are pending. Install with your package manager, then run prn check and prn build.');
      return report;
    }
    report.status = 'installing';
    await (services.install || installMigrationDependencies)(root, { json, local });
    report.preflight = await check(root);
    if (!report.preflight.ok) throw new Error(`Dependencies were installed, but final preflight failed: ${report.preflight.errors.join(' ')}`);
    report.ok = true;
    report.status = 'migrated';
    report.notes.push('Migration prepared and dependencies checked. Run npm run build and test your application before deploying.');
    return report;
  } catch (error) {
    report.error = error.message;
    if (report.status === 'checking') report.status = 'blocked';
    else report.status = 'incomplete';
    return report;
  }
}
