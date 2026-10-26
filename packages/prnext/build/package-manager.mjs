import path from 'node:path';
import { lstat, readFile, realpath, access, readdir, writeFile, rm, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import { npmCommand } from '../native/npm.mjs';
import { rename } from '../runtime/fs.mjs';
import { pathToFileURL } from 'node:url';
import { packageManifest } from '../native/resolve.mjs';

const execute = promisify(execFile);
export const migrationLockfiles = ['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb'];
const lockManager = name => name.startsWith('pnpm-') ? 'pnpm' : name === 'yarn.lock' ? 'yarn' : name.startsWith('bun.') ? 'bun' : 'npm';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };

export async function regularMigrationFile(file, { limit = 64 * 1024 * 1024 } = {}) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Migration requires a regular file, not a symlink or directory: ${file}`);
  if (info.size > limit) throw new Error(`Migration file exceeds ${limit} bytes: ${file}`);
  const contents = await readFile(file);
  if (contents.length > limit) throw new Error(`Migration file exceeds ${limit} bytes: ${file}`);
  return { contents, mode: info.mode & 0o777 };
}

function yamlString(value) {
  value = value.trim();
  if (value.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(value);
    if (!match) throw new Error('Unsupported YAML string in package-manager configuration.');
    return JSON.parse(match[1]);
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value);
    if (!match) throw new Error('Unsupported YAML string in package-manager configuration.');
    return match[1].replaceAll("''", "'");
  }
  const result = value.replace(/\s+#.*$/, '').trim();
  if (!result || /[\[\]{},&*|>]/.test(result) && !/^[!./\w@*?{}[\]()-]+$/.test(result)) throw new Error('Unsupported YAML workspace pattern; use a list of quoted package globs.');
  return result;
}
function pnpmPatterns(source) {
  const lines = source.split(/\r?\n/), start = lines.findIndex(line => /^packages\s*:/.test(line));
  if (start < 0) return ['**'];
  const inline = lines[start].replace(/^packages\s*:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (inline) {
    if (!inline.startsWith('[') || !inline.endsWith(']')) throw new Error('pnpm-workspace.yaml packages must be a list of package globs.');
    const entries = inline.slice(1,-1).match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) || [];
    return entries.map(yamlString);
  }
  const result = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]; if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const match = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error('pnpm-workspace.yaml packages must be a list of package globs.');
    result.push(yamlString(match[1]));
  }
  return result;
}
function workspacePatterns(pkg, pnpm) {
  const patterns = pnpm ? pnpmPatterns(pnpm.contents.toString('utf8')) : Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.some(value => typeof value !== 'string')) throw new Error('Workspace packages must be an array of globs.');
  if (patterns.some(value => !value || value.length > 4096 || /[\0\r\n\\]/.test(value) || path.isAbsolute(value.replace(/^!/, '')) || value.includes('..'))) throw new Error('Workspace package globs must stay inside the workspace root.');
  return patterns;
}
function workspaceContains(patterns, relative) {
  const positive = patterns.filter(value => !value.startsWith('!'));
  const negative = patterns.filter(value => value.startsWith('!')).map(value => value.slice(1));
  return positive.some(value => picomatch(value.replace(/\/$/, ''), { dot: true })(relative)) && !negative.some(value => picomatch(value.replace(/\/$/, ''), { dot: true })(relative));
}
function workspacePrefix(patterns, relative) {
  return patterns.filter(value => !value.startsWith('!')).some(pattern => {
    // Complex extglob/brace patterns may include slashes. Conservatively reject
    // a linked directory rather than omit manifests the manager could visit.
    if (/[{}()]/.test(pattern)) return true;
    const parts = pattern.replace(/^\.\//, '').replace(/\/$/, '').split('/'), segments = relative.split('/'), memo = new Map();
    function match(p, s) {
      if (s === segments.length) return true;
      if (p === parts.length) return false;
      const key = `${p}:${s}`; if (memo.has(key)) return memo.get(key);
      const result = parts[p] === '**' ? match(p + 1, s) || match(p, s + 1) : picomatch(parts[p], { dot: true })(segments[s]) && match(p + 1, s + 1);
      memo.set(key, result); return result;
    }
    return match(0,0);
  });
}
function declaration(pkg) {
  if (pkg?.packageManager === undefined) return null;
  const match = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\+[^\s]+)?$/.exec(pkg.packageManager);
  if (!match) throw new Error('packageManager must identify npm, pnpm or yarn with an exact version.');
  return { name: match[1], version: match[2] };
}

/** Discover the manager and shared workspace lockfile without running commands. */
export async function migrationInstallContext(directory, pkg) {
  const target = await realpath(directory), ancestors = [];
  for (let current = target; ; current = path.dirname(current)) {
    const manifest = current === target ? pkg : await regularMigrationFile(path.join(current, 'package.json'), { limit: 1024 * 1024 }).then(value => value ? JSON.parse(value.contents.toString('utf8').replace(/^\uFEFF/, '')) : null);
    const pnpm = await regularMigrationFile(path.join(current, 'pnpm-workspace.yaml'), { limit: 1024 * 1024 });
    ancestors.push({ directory: current, manifest, pnpm });
    if (manifest?.workspaces || pnpm || current === path.dirname(current)) break;
    if (ancestors.length > 64) throw new Error('Workspace discovery exceeds 64 parent directories.');
  }
  const owner = ancestors.at(-1), workspace = Boolean(owner.manifest?.workspaces || owner.pnpm);
  const root = workspace ? owner.directory : target;
  const relative = path.relative(root, target).replaceAll(path.sep, '/');
  let reason;
  const declared = ancestors.map(item => declaration(item.manifest)).filter(Boolean);
  if (new Set(declared.map(item => `${item.name}@${item.version}`)).size > 1) reason = 'Application and workspace packageManager declarations disagree. Align them or use --no-install.';
  const stateFiles = [...new Set([path.join(target, 'package.json'), path.join(root, 'package.json'), ...[root, ...(root !== target ? [target] : [])].flatMap(dir => migrationLockfiles.map(name => path.join(dir, name)))])];
  const existing = [];
  for (const file of stateFiles) if (await regularMigrationFile(file)) existing.push(file);
  const foundLocks = existing.filter(file => migrationLockfiles.includes(path.basename(file)));
  const managers = new Set(foundLocks.map(file => lockManager(path.basename(file))));
  const yarnConfig = await regularMigrationFile(path.join(root, '.yarnrc.yml'), { limit: 1024 * 1024 });
  const classicConfig = await regularMigrationFile(path.join(root, '.yarnrc'), { limit: 1024 * 1024 });
  const manager = declared[0]?.name || (managers.size === 1 ? [...managers][0] : owner.pnpm ? 'pnpm' : yarnConfig || classicConfig ? 'yarn' : 'npm');
  const patterns = workspace ? workspacePatterns(owner.manifest, manager === 'pnpm' || !owner.manifest?.workspaces ? owner.pnpm : null) : [];
  if (workspace && relative && !workspaceContains(patterns, relative)) reason = 'The application is not listed in its parent workspace. Add it to the workspace or use --no-install and install it explicitly.';
  if (workspace && owner.pnpm && manager !== 'pnpm' && !owner.manifest?.workspaces) reason = 'Only pnpm-workspace.yaml declares this workspace, but a different manager was selected. Align the manager or use --no-install.';
  if (manager === 'bun') reason = 'Bun migration installation is not supported. Use --no-install and install with Bun.';
  if (managers.size > 1 || managers.size && !managers.has(manager)) reason = 'Conflicting package-manager lockfiles or packageManager declaration. Keep the intended manager and lockfile, or use --no-install.';
  if (root !== target && foundLocks.some(file => path.dirname(file) === target)) reason = 'A workspace application has a nested lockfile. Resolve the shared/nested lockfile choice or use --no-install.';
  const filterPackage = typeof pkg.name === 'string' && pkg.name.length <= 214 && /^(?:@[a-zA-Z0-9][\w.-]*\/)?[a-zA-Z0-9][\w.-]*$/.test(pkg.name) && !pkg.name.includes('...') ? pkg.name : null;
  if (manager === 'pnpm' && workspace && !filterPackage) reason = 'A pnpm workspace application needs a valid package name for an exact install filter. Set its name or use --no-install.';
  const yarnLock = foundLocks.find(file => path.basename(file) === 'yarn.lock');
  const berry = manager === 'yarn' && (declared[0] ? Number(declared[0].version.split('.')[0]) >= 2 : yarnConfig ? true : yarnLock ? /^__metadata:/m.test((await regularMigrationFile(yarnLock)).contents.toString('utf8')) : false);
  let args;
  if (manager === 'npm') args = workspace && relative ? ['install','--workspace',relative,'--include-workspace-root=false'] : ['install','--workspaces=false'];
  else if (manager === 'pnpm') args = [...(workspace ? ['--filter',filterPackage || 'SET_PACKAGE_NAME','--fail-if-no-match', ...(relative ? [] : ['--include-workspace-root'])] : []),'install','--no-frozen-lockfile'];
  else args = ['install'];
  return { allowed: !reason, ...(reason ? { reason } : {}), manager, version: declared[0]?.version || null, berry, root, target,
    workspace, workspacePatterns: patterns, filterPackage, workspaceTarget: relative || '.', locks: foundLocks, stateFiles,
    command: { name: manager, args, cwd: root }, notes: manager === 'yarn' && workspace ? ['Yarn installs the shared workspace dependency graph from its root; migration edits only the selected application manifest.'] : [] };
}

async function managerLauncher(context, env) {
  if (context.manager === 'npm') return npmCommand(env);
  if (context.manager === 'yarn') {
    const config = await regularMigrationFile(path.join(context.root, '.yarnrc.yml'), { limit: 1024 * 1024 });
    const match = config && /^yarnPath\s*:\s*(.+)$/m.exec(config.contents.toString('utf8'));
    if (match) {
      const file = path.resolve(context.root, yamlString(match[1]));
      let physical;
      try { physical = await realpath(file); } catch { throw new Error('yarnPath must point to a regular release file inside the workspace.'); }
      if (!inside(context.root, file) || !inside(context.root, physical) || !(await regularMigrationFile(physical))) throw new Error('yarnPath must point to a regular release file inside the workspace.');
      return { command: process.execPath, args: [physical] };
    }
  }
  const executable = env.npm_execpath;
  const launcherFile = async file => {
    try { const physical = await realpath(file); return await regularMigrationFile(physical) ? physical : null; }
    catch (error) { if (['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code)) return null; throw error; }
  };
  if (executable && new RegExp(`(?:^|[/\\\\])${context.manager}(?:-cli)?\\.(?:c?js)$`).test(executable)) {
    const physical = await launcherFile(executable); if (physical) return { command: process.execPath, args: [physical] };
  }
  const directories = [path.dirname(process.execPath), ...(env.PATH || env.Path || '').split(path.delimiter)].filter(Boolean);
  const candidates = directories.flatMap(directory => [
    path.join(directory, 'node_modules', context.manager, 'bin', context.manager === 'pnpm' ? 'pnpm.cjs' : 'yarn.js'),
    path.join(directory, 'node_modules/corepack/dist', `${context.manager}.js`),
  ]);
  for (const file of candidates) { const physical = await launcherFile(file); if (physical) return { command: process.execPath, args: [physical] }; }
  if (process.platform !== 'win32') return { command: context.manager, args: [] };
  throw new Error(`Cannot locate ${context.manager}. Install the project's declared package manager or provide Corepack, then retry. No global installation was attempted.`);
}

async function workspaceManifestSnapshots(context) {
  const snapshots = new Map(); let directories = 0, bytes = 0;
  const add = async file => {
    if (snapshots.has(file)) return;
    const value = await regularMigrationFile(file, { limit: 1024 * 1024 }); if (!value) return;
    bytes += value.contents.length;
    if (snapshots.size >= 5000 || bytes > 32 * 1024 * 1024) throw new Error('Workspace manifest snapshot exceeds 5000 manifests or 32 MiB.');
    snapshots.set(file, value);
  };
  await add(path.join(context.root, 'package.json')); await add(path.join(context.target, 'package.json'));
  if (context.workspace) {
    const ignored = new Set(['node_modules','.git','.yarn','.corepack','.npm-cache','.pnpm-store','.yarn-cache']);
    async function walk(directory) {
      if (++directories > 10000) throw new Error('Workspace discovery exceeds 10,000 directories.');
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        if (ignored.has(entry.name)) continue;
        const file = path.join(directory, entry.name), relative = path.relative(context.root, file).replaceAll(path.sep, '/');
        if (entry.isSymbolicLink()) {
          if (workspacePrefix(context.workspacePatterns, relative)) throw new Error('Workspace package directories or their ancestors must not be symlinks during migration.');
          continue;
        }
        if (!entry.isDirectory()) continue;
        if (workspaceContains(context.workspacePatterns, relative)) await add(path.join(file, 'package.json'));
        await walk(file);
      }
    }
    await walk(context.root);
  }
  return snapshots;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
async function restoreManifestFormatting(snapshots) {
  let restored = 0; const errors = [];
  for (const [file, before] of snapshots) {
    try {
    if (await realpath(path.dirname(file)) !== path.dirname(file)) throw new Error(`Workspace directory changed during installation: ${path.dirname(file)}`);
    const after = await regularMigrationFile(file, { limit: 1024 * 1024 });
    if (!after) throw new Error(`Workspace manifest disappeared during installation: ${file}`);
    if (after.contents.equals(before.contents)) continue;
    const parse = contents => { try { return JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error(`Workspace manifest became invalid during installation; preserved the newer file: ${file}`); } };
    if (JSON.stringify(canonical(parse(before.contents))) !== JSON.stringify(canonical(parse(after.contents)))) throw new Error(`Workspace manifest changed semantically during installation; preserved the newer file: ${file}`);
    const temporary = file + `.prnext-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, before.contents, { flag: 'wx', mode: before.mode });
      if (!(await regularMigrationFile(file)).contents.equals(after.contents)) throw new Error(`Workspace manifest changed while restoring formatting: ${file}`);
      await rename(temporary, file); restored++;
    } finally { await rm(temporary, { force: true }); }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return restored;
}

// Yarn Classic does not create bin links for link: packages. Preserve the live
// local checkout and supply scoped launchers without a global `yarn link`.
async function localClassicBins(context) {
  const application = JSON.parse((await regularMigrationFile(path.join(context.target, 'package.json'))).contents.toString('utf8').replace(/^\uFEFF/, ''));
  if (!application.dependencies?.[packageManifest.name]?.startsWith('link:')) return;
  let installed;
  for (const directory of [context.target, context.root]) {
    const candidate = path.join(directory, 'node_modules', packageManifest.name, 'package.json');
    try { installed = { directory: path.dirname(await realpath(candidate)), manifest: JSON.parse((await regularMigrationFile(await realpath(candidate))).contents.toString('utf8').replace(/^\uFEFF/, '')) }; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!installed || installed.manifest.name !== packageManifest.name) throw new Error('The local Yarn link did not resolve the PRNext package.');
  let binDirectory = context.target;
  for (const part of ['node_modules','.bin']) {
    binDirectory = path.join(binDirectory, part);
    try { const info = await lstat(binDirectory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local bin launchers require real node_modules/.bin directories.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(binDirectory); }
  }
  const create = async (file, contents, mode, source) => {
    // Never overwrite an existing manager/user executable or symbolic link.
    if (await realpath(binDirectory) !== binDirectory) throw new Error('The local bin directory changed during migration.');
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() && await realpath(file) === source || info.isFile() && (await readFile(file)).equals(Buffer.from(contents))) return;
      throw new Error(`Existing ${path.basename(file)} launcher was preserved; resolve the conflicting executable before migrating.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(file, contents, { flag: 'wx', mode });
  };
  for (const name of ['prn','prnext']) {
    const entry = installed.manifest.bin?.[name];
    if (typeof entry !== 'string' || path.isAbsolute(entry)) throw new Error(`The local package has no safe ${name} bin entry.`);
    const source = await realpath(path.resolve(installed.directory, entry));
    if (!inside(installed.directory, source) || !(await regularMigrationFile(source))) throw new Error('The local PRNext bin must stay inside its package.');
    const shim = '#!/usr/bin/env node\n' + `import(${JSON.stringify(pathToFileURL(source).href)}).catch(error=>{console.error(error);process.exitCode=1;});\n`;
    await create(path.join(binDirectory, name), shim, 0o755, source);
    if (process.platform === 'win32') {
      const node = process.execPath.replaceAll('%', '%%');
      await create(path.join(binDirectory, `${name}.cmd`), `@ECHO off\r\nSETLOCAL DisableDelayedExpansion\r\n"${node}" "%~dp0${name}" %*\r\n`, 0o644, source);
    }
  }
}

export async function executeManager(context, args, options = {}) {
  const env = { ...process.env, COREPACK_ENABLE_AUTO_PIN: '0', ...(context.manager === 'yarn' ? { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' } : {}), ...options.env };
  const launcher = options.launcher || await managerLauncher(context, env);
  return execute(launcher.command, [...launcher.args, ...args], { cwd: context.root, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options, env });
}

export async function installWithManager(context, { json = false, local = false, env: overrides } = {}) {
  if (!context.allowed) throw new Error(context.reason || 'The package-manager installation plan is blocked.');
  const env = { ...process.env, ...overrides, COREPACK_ENABLE_AUTO_PIN: '0', ...(context.manager === 'yarn' ? { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' } : {}) };
  const launcher = await managerLauncher(context, env);
  const manifests = await workspaceManifestSnapshots(context);
  if (context.manager === 'pnpm' && context.workspace) {
    const matches = [...manifests].filter(([,value]) => JSON.parse(value.contents.toString('utf8').replace(/^\uFEFF/, '')).name === context.filterPackage);
    if (matches.length !== 1 || matches[0][0] !== path.join(context.target, 'package.json')) throw new Error('The pnpm install filter must identify exactly the selected workspace; package names must be unique.');
  }
  const actual = (await executeManager(context, ['--version'], { env, launcher })).stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(actual)) throw new Error(`${context.manager} returned an invalid version.`);
  if (context.version && actual !== context.version) throw new Error(`${context.manager}@${context.version} is declared, but ${actual} would run. Use the declared package manager; no version override was applied.`);
  const args = [...context.command.args];
  if (context.manager === 'npm' && local) args.push('--install-links=false');
  if (context.manager === 'yarn' && Number(actual.split('.')[0]) === 1) args.push('--non-interactive');
  let restoredManifests = 0;
  try { await new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...launcher.args, ...args], { cwd: context.root, env, stdio: json ? ['inherit', 2, 2] : 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${context.manager} install failed (${signal || code}). Fix the dependency conflict and retry. No force or peer-dependency bypass was used.`)));
  }); } finally { restoredManifests = await restoreManifestFormatting(manifests); }
  if (local && context.manager === 'yarn' && Number(actual.split('.')[0]) === 1) await localClassicBins(context);
  const pnp = context.manager === 'yarn' && await regularMigrationFile(path.join(context.root, '.pnp.cjs'));
  for (const name of ['prn','prnext']) {
    if (pnp) {
      const result = await executeManager(context, ['bin', name], { cwd: context.target, env, launcher });
      if (!result.stdout.trim()) throw new Error(`Yarn did not expose the ${name} executable in this workspace.`);
    } else {
      const suffix = process.platform === 'win32' ? '.cmd' : '';
      let found = false;
      for (const directory of [context.target, context.root]) try { await access(path.join(directory, 'node_modules/.bin', name + suffix), process.platform === 'win32' ? constants.F_OK : constants.X_OK); found = true; break; } catch {}
      if (!found) throw new Error(`${context.manager} did not install the ${name} executable. Check bin linking and the PRNext dependency.`);
    }
  }
  return { version: actual, pnp: Boolean(pnp), restoredManifests };
}
