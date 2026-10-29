import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { packageManifest } from '../native/resolve.mjs';
import { supportedNode } from '../native/diagnostics.mjs';
import { npmCommand } from '../native/npm.mjs';

export const createHelp = `Usage: prnext create <directory> [--js] [--no-install] [--json]

Create a minimal App Router project and install its dependencies with npm.
TypeScript is the default; --js creates a JavaScript project.
The directory must be absent or completely empty. Existing files are never replaced.
--no-install prepares files without running npm or accessing the network.
Inside an existing workspace, use --no-install and its own package manager.

  npx @thomas.f/prnext create my-app
  cd my-app
  npm run dev
`;

export function parseCreateArgs(args, cwd = process.cwd()) {
  const flags = new Set(), positional = [];
  let literal = false;
  for (const arg of args) {
    if (literal) positional.push(arg);
    else if (arg === '--') literal = true;
    else if (['--no-install', '--js', '--json'].includes(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate create option: ${arg}`);
      flags.add(arg);
    } else if (arg.startsWith('-')) throw new Error(`Unknown create option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1 || !positional[0].trim() || /[\0\r\n]/.test(positional[0])) throw new Error('Provide one project directory: prnext create my-app');
  return { directory: path.resolve(cwd, positional[0]), options: { install: !flags.has('--no-install'), typescript: !flags.has('--js'), json: flags.has('--json') } };
}

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function info(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function physicalDirectory(directory, missing = false) {
  // macOS exposes standard directories through root-owned /private aliases.
  // Resolve only those exact system targets; every user-controlled descendant
  // still goes through the strict no-symlink walk below, on every write.
  if (process.platform === 'darwin') {
    const alias = /^\/(?:var|tmp|etc)(?=\/|$)/.exec(directory)?.[0];
    if (alias && (await info(alias))?.isSymbolicLink() && await realpath(alias) === `/private${alias}`) {
      directory = `/private${directory}`;
    }
  }
  const root = path.parse(directory).root;
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    if (process.platform === 'win32' && (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[<>:"|?*]|[. ]$/.test(part))) throw new Error(`Invalid Windows directory name: ${part}`);
    current = path.join(current, part);
    const entry = await info(current);
    if (!entry && missing) continue;
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error(`Project directories must not be files, symbolic links or junctions: ${current}`);
  }
  if (!missing && !samePath(await realpath(directory), directory)) throw new Error('Use a physical project directory without symbolic links or junctions.');
}

async function parentWorkspace(directory) {
  for (let current = path.dirname(directory); ; current = path.dirname(current)) {
    const workspace = await info(path.join(current, 'pnpm-workspace.yaml'));
    if (workspace) return current;
    const file = path.join(current, 'package.json'), entry = await info(file);
    if (entry) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) throw new Error(`Cannot safely inspect parent package.json: ${file}`);
      let manifest;
      try { manifest = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
      catch { throw new Error(`Parent package.json is invalid: ${file}`); }
      if (manifest.workspaces) return current;
    }
    if (current === path.dirname(current)) return null;
  }
}

function projectName(directory) {
  const name = path.basename(directory).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 100);
  return !name || ['node_modules', 'favicon.ico'].includes(name) ? 'prnext-app' : name;
}
const json = value => JSON.stringify(value, null, 2) + '\n';

function projectFiles(name, typescript) {
  const extension = typescript ? 'tsx' : 'jsx';
  const scripts = { dev: 'prnext dev', build: 'prnext build', start: 'prnext start', check: 'prnext check', ...(typescript ? { typecheck: 'prnext typecheck' } : {}) };
  const manifest = { name, version: '0.0.0', private: true, type: 'module', scripts,
    dependencies: { [packageManifest.name]: packageManifest.version, ...Object.fromEntries(Object.entries(packageManifest.peerDependencies).filter(([name])=>!packageManifest.peerDependenciesMeta?.[name]?.optional)) },
    ...(typescript ? { devDependencies: { typescript: '^5.9.0', '@types/node': '^22.0.0', '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0' } } : {}),
    engines: { node: packageManifest.engines.node } };
  const files = new Map([
    ['package.json', json(manifest)],
    [`app/layout.${extension}`, `import './globals.css';\n${typescript ? "import type { ReactNode } from 'react';\n" : ''}
export const metadata = { title: 'My PRNext app', description: 'A React application built with PRNext.' };

export default function RootLayout({ children }${typescript ? ': { children: ReactNode }' : ''}) {
  return <html lang="en"><body>{children}</body></html>;
}
`],
    [`app/page.${extension}`, `export default function Home() {
  return <main><h1>PRNext</h1><p>Edit <code>app/page.${extension}</code> to get started.</p></main>;
}
`],
    ['app/globals.css', `:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 64rem; margin: auto; padding: clamp(2rem, 8vw, 6rem) 1.5rem; }
h1 { font-size: clamp(2.5rem, 8vw, 4rem); letter-spacing: -.04em; }
p { line-height: 1.6; }
code { font-size: .95em; }
`],
    ['.gitignore', 'node_modules/\n.prnext/\n.prnext-types/\n.prnext-dev/\n.prnext-cache/\n.env*\n!.env.example\n*.tsbuildinfo\n'],
    ['README.md', `# ${name}\n\nA minimal PRNext application.\n\nRun \`npm install\` if dependencies have not been installed, then:\n\n\`\`\`sh\nnpm run dev\n\`\`\`\n\nEdit \`app/page.${extension}\`. Use the local URL printed by the server.\n\n\`\`\`sh\nnpm run check\n${typescript ? 'npm run typecheck\n' : ''}npm run build\nnpm start\n\`\`\`\n\nUse another port with \`npm run dev -- --port 3001\` when needed.\n\n[PRNext documentation](https://prnext.dev) · Installed AI guide: \`npx --no-install prnext docs --ai\`.\nPRNext is experimental; Next.js compatibility is partial.\n`],
    ['AGENTS.md', `# PRNext project\n\nThis application uses \`@thomas.f/prnext\`. Before changing routing, configuration, data fetching or deployment, read the installed guide at \`node_modules/@thomas.f/prnext/AI.md\` or run:\n\n\`\`\`sh\nnpx --no-install prnext docs --ai\nnpx --no-install prnext docs --ai --list\n\`\`\`\n\nRead only the relevant topic with \`npx --no-install prnext docs --ai <topic>\`. The installed documentation is version-specific; do not assume full Next.js compatibility. Preserve the project's package manager and lockfile.\n`],
  ]);
  if (typescript) files.set('tsconfig.json', json({ compilerOptions: { target: 'ES2022', lib: ['DOM', 'DOM.Iterable', 'ES2022'], module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve', strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true }, include: ['**/*.ts', '**/*.tsx'], exclude: ['node_modules', '.prnext', '.prnext-dev', '.prnext-cache'] }));
  return files;
}

function abortError() { const error = new Error('Project creation canceled.'); error.name = 'AbortError'; return error; }
function aborted(signal) { if (signal?.aborted) throw abortError(); }

/** Run npm without a shell; a canceled command waits for its own installer tree. */
export async function installProject(directory, { signal, onOutput = () => {} } = {}) {
  aborted(signal);
  const env = { ...process.env, INIT_CWD: directory, PWD: directory };
  for (const key of Object.keys(env)) if (/^npm_config_(?:workspace|workspaces|global|prefix)$/i.test(key)) delete env[key];
  const npm = npmCommand(env);
  await new Promise((resolve, reject) => {
    const child = spawn(npm.command, [...npm.args, 'install', '--prefix', directory, '--workspaces=false', '--global=false'], { cwd: directory, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', timer, canceling = false;
    const receive = stream => chunk => { tail = (tail + chunk).slice(-16000); onOutput(String(chunk), stream); };
    child.stdout.on('data', receive('stdout'));
    child.stderr.on('data', receive('stderr'));
    function terminate(force) {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if (child.exitCode !== null || child.signalCode) return;
        const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
      }
    }
    function cancel() { canceling = true; terminate(false); timer ||= setTimeout(() => terminate(true), 5000); }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, childSignal) => {
      // A detached lifecycle script can close npm's pipes before it exits.
      // Do not let npm's exit cancel escalation for that remaining group.
      if ((canceling || signal?.aborted) && process.platform !== 'win32') terminate(true);
      cleanup();
      if (canceling || signal?.aborted) reject(abortError());
      else if (code === 0) resolve();
      else reject(new Error(`npm install failed (${childSignal || code}).${tail.trim() ? '\n' + tail.trim() : ''}`));
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export async function createProject(directory, options = {}, services = {}) {
  const root = path.resolve(directory), typescript = options.typescript !== false, install = options.install !== false;
  aborted(options.signal);
  const nodeVersion = services.nodeVersion || process.version;
  if (!supportedNode(nodeVersion)) throw new Error(`Node ${nodeVersion} is unsupported. Use Node ${packageManifest.engines.node}.`);
  await physicalDirectory(root, true);
  const existing = await info(root);
  if (existing && (await readdir(root)).length) throw new Error(`Project directory must be empty; no files were changed: ${root}`);
  if (install && await parentWorkspace(root)) throw new Error('Automatic installation inside an existing workspace is not supported. Use --no-install, then add the project with the workspace package manager. No files were changed.');
  aborted(options.signal);
  await mkdir(root, { recursive: true });
  await physicalDirectory(root);
  const lockPath = path.join(root, '.prnext-create.lock');
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  const locked = await lock.stat();
  try {
    if ((await readdir(root)).some(name => name !== '.prnext-create.lock')) throw new Error(`Project directory is no longer empty; existing files were preserved: ${root}`);
    const name = projectName(root), files = projectFiles(name, typescript);
    for (const [relative, content] of files) {
      aborted(options.signal);
      await physicalDirectory(root);
      const target = path.join(root, relative), parent = path.dirname(target);
      await physicalDirectory(parent, true);
      await mkdir(parent, { recursive: true });
      await physicalDirectory(parent);
      const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o644);
      try { await file.writeFile(content, 'utf8'); } finally { await file.close(); }
    }
    const report = { ok: true, status: 'prepared', root, name, typescript, files: [...files.keys()], installed: false, next: install ? ['npm run dev'] : ['npm install', 'npm run dev'] };
    if (install) {
      try {
        aborted(options.signal);
        await (services.runInstall || installProject)(root, { signal: options.signal, onOutput: options.onOutput });
        aborted(options.signal);
        report.installed = true;
        report.status = 'created';
      } catch (error) {
        report.ok = false;
        report.status = error.name === 'AbortError' || options.signal?.aborted ? 'cancelled' : 'install-failed';
        report.error = error.message;
        report.next = ['npm install', 'npm run dev'];
      }
    }
    return report;
  } finally {
    await lock.close();
    const current = await info(lockPath);
    if (current?.isFile() && !current.isSymbolicLink() && sameFile(current, locked)) await unlink(lockPath);
  }
}
