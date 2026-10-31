import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const managedDispatcher = `#!/bin/sh
# PRNext managed pre-push dispatcher v1. Install with npm run hooks:install.
set -eu
root=$(git rev-parse --show-toplevel)
# Old branches without a committed hook keep their existing behavior.
if ! git cat-file -e HEAD:.githooks/pre-push 2>/dev/null; then
  exit 0
fi
if [ ! -f "$root/.githooks/pre-push" ]; then
  printf '%s\\n' 'PRNext pre-push hook is missing from this checkout. Restore the tracked file before pushing.' >&2
  exit 1
fi
exec sh "$root/.githooks/pre-push" "$@"
`;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

export function installHooks({ cwd = process.cwd() } = {}) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  try {
    git(root, ['config', '--show-origin', '--get-all', 'core.hooksPath']);
    throw new Error('core.hooksPath is already configured. Existing hook configuration was preserved; review it before choosing a hook installation.');
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const common = realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  const directory = path.join(common, 'hooks');
  try { if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('The shared hooks directory is not an ordinary directory. Existing hooks were preserved.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(directory); }
  const target = path.join(directory, 'pre-push');
  try {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || readFileSync(target, 'utf8') !== managedDispatcher) throw new Error('A custom or modified pre-push hook already exists. It was preserved; review that hook before installing PRNext’s dispatcher.');
    chmodSync(target, 0o755);
    return { installed: false, path: target };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  writeFileSync(target, managedDispatcher, { flag: 'wx', mode: 0o755 });
  return { installed: true, path: target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Run npm run hooks:install without arguments from this repository.');
    const result = installHooks();
    console.log(result.installed ? 'Installed the managed pre-push dispatcher in this repository’s shared hooks directory.' : 'The managed pre-push dispatcher is already installed.');
    console.log('Branches with a committed .githooks/pre-push use lightweight local checks. Remote CI remains required.');
  } catch (error) { console.error('Hook installation stopped: ' + error.message); process.exitCode = 1; }
}
