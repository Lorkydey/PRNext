import { execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const zero = value => /^0+$/.test(value);
const typeProjects = ['tests/types/tsconfig.json', 'examples/basic/tsconfig.json', 'examples/app/tsconfig.json'];
const toolingTest = /^scripts\/(?:ci-[^/]+\.test\.mjs|pre-push\.test\.mjs|install-hooks\.test\.mjs)$/;

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...options });
}

export function parsePushUpdates(input) {
  if (Buffer.byteLength(input) > 65536) throw new Error('Push ref input exceeds 64 KiB. Push fewer refs at a time.');
  if (!input) return [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => {
    const fields = line.split(' ');
    if (fields.length !== 4 || fields.some(value => !value || /\s/.test(value)) || !sha.test(fields[1]) || !sha.test(fields[3]) || fields[1].length !== fields[3].length) throw new Error('Git supplied an invalid push ref record. Retry the push from Git.');
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    if (!remoteRef.startsWith('refs/') || zero(localOid) && zero(remoteOid)) throw new Error('Git supplied an unknown push update. No checks were skipped.');
    return { localRef, localOid, remoteRef, remoteOid, deletion: zero(localOid), creation: zero(remoteOid) };
  });
}

function commit(cwd, oid, label) {
  try { return git(cwd, ['rev-parse', '--verify', oid + '^{commit}']).trim(); }
  catch { throw new Error(`${label} is not an available commit. Fetch the remote ref into this repository, then retry; tree and blob refs are not supported.`); }
}

function cleanSource(cwd, expectedHead) {
  if (git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== expectedHead) throw new Error('HEAD changed during validation. Retry from a clean worktree at the commit being pushed.');
  const flags = git(cwd, ['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  if (flags.some(record => record[0] === 'S' || record[0] !== record[0].toUpperCase())) throw new Error('Tracked files use skip-worktree or assume-unchanged. Use a complete clean worktree so the pushed source can be verified.');
  if (git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])) throw new Error('This worktree has staged, unstaged or untracked changes. Use a clean worktree checked out at the commit being pushed, then retry. Local changes were preserved.');
  const entries = git(cwd, ['ls-tree', '-r', '-z', expectedHead]).split('\0').filter(Boolean);
  if (entries.some(record => /^(?:120000|160000) /.test(record))) throw new Error('The pushed tree contains symlinks or submodules whose source cannot be verified by this local check. Validate from a complete tree without external source links.');
}

function emptyTree(cwd) {
  // Create only Git's immutable empty-tree object, never change refs or files.
  return git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], { input: '' }).trim();
}

function creationBase(cwd, remote, head) {
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) {
    try {
      const tracked = git(cwd, ['rev-parse', '--verify', `refs/remotes/${remote}/HEAD^{commit}`]).trim();
      return git(cwd, ['merge-base', head, tracked]).trim();
    } catch { /* An unknown or unrelated remote needs the complete initial tree. */ }
  }
  return emptyTree(cwd);
}

function whitespace(cwd, base, head) {
  try { git(cwd, ['-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab', 'diff', '--check', base, head, '--']); }
  catch (error) {
    const details = String(error.stdout || error.stderr || '').split(/\r?\n/).filter(line => line && !line.startsWith('+')).slice(0, 20).join('\n');
    throw new Error('The pushed diff failed its whitespace check. Fix the reported lines and commit the correction before retrying.' + (details ? '\n' + details : ' Git could not inspect the complete diff.'));
  }
}

function validationEnvironment(cwd) {
  // Git's hook-local repository variables must never escape into test fixtures.
  const names = git(cwd, ['rev-parse', '--local-env-vars']).trim().split(/\r?\n/);
  if (!names.length || names.some(name => !/^GIT_[A-Z0-9_]+$/.test(name))) throw new Error('Git could not identify its local environment variables. No validation child was started.');
  const excluded = new Set([...names, 'NODE_TEST_CONTEXT']);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (excluded.has(name.toUpperCase())) delete env[name];
  return env;
}

function check(cwd, args, label, env, timeout = 120000) {
  console.log('Pre-push: ' + label);
  try { execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true, timeout }); }
  catch { throw new Error(`${label} failed or exceeded its time limit. Fix the failure and retry the push; remote CI remains required.`); }
}

export async function runPrePush({ cwd = process.cwd(), input, remote }) {
  const updates = parsePushUpdates(input);
  if (!updates.length) { console.log('Pre-push: no ref updates; no source was validated.'); return { scope: 'no-updates' }; }
  const active = updates.filter(update => !update.deletion);
  if (!active.length) { console.log('Pre-push: ref deletions only; no source checks needed.'); return { scope: 'deletions' }; }
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const expectedScript = path.join(root, 'scripts/pre-push.mjs');
  if (realpathSync.native(fileURLToPath(import.meta.url)) !== realpathSync.native(expectedScript)) throw new Error('This validator belongs to another checkout. Run the push from the worktree containing the source being pushed.');
  const head = commit(root, 'HEAD', 'HEAD');
  for (const update of active) {
    if (commit(root, update.localOid, 'The pushed object') !== head) throw new Error('A pushed ref does not point to this worktree’s HEAD. Push it from a clean worktree at that commit, or push refs separately.');
  }
  cleanSource(root, head);
  for (const name of ['.githooks/pre-push', 'scripts/pre-push.mjs', 'scripts/ci-scope.mjs', 'scripts/ci-scope.test.mjs']) {
    if (!/^100(?:644|755) blob /.test(git(root, ['ls-tree', head, '--', name]))) throw new Error(`Required pushed tooling is missing or is not a regular file: ${name}.`);
  }
  const { documentationOnly, readChanges } = await import(pathToFileURL(path.join(root, 'scripts/ci-scope.mjs')).href);
  let docsOnly = true;
  for (const update of active) {
    const base = update.creation ? creationBase(root, remote, head) : commit(root, update.remoteOid, 'The remote object');
    whitespace(root, base, head);
    const changes = readChanges(base, head, root);
    // Initial refs and empty diffs cannot certify a documentation-only change.
    if (update.creation || !documentationOnly(changes)) docsOnly = false;
  }
  const tests = git(root, ['ls-tree', '-r', '--name-only', '-z', head, '--', 'scripts/']).split('\0').filter(name => toolingTest.test(name));
  if (!tests.includes('scripts/ci-scope.test.mjs')) throw new Error('The CI scope regression test is missing from the pushed tree.');
  const childEnv = validationEnvironment(root);
  check(root, ['--test', ...tests.sort()], 'Lightweight tooling tests', childEnv);
  if (!docsOnly) {
    const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
    try { accessSync(compiler, constants.R_OK); if (!lstatSync(compiler).isFile()) throw new Error(); }
    catch { throw new Error('The local TypeScript compiler is missing. Run npm ci in this clean worktree, then retry. No packages were installed by this hook.'); }
    for (const project of typeProjects) {
      if (!/^100(?:644|755) blob /.test(git(root, ['ls-tree', head, '--', project]))) throw new Error(`TypeScript configuration is missing from the pushed tree: ${project}.`);
      accessSync(path.join(root, project), constants.R_OK);
      check(root, [compiler, '-p', project], 'TypeScript: ' + project, childEnv);
    }
  }
  cleanSource(root, head);
  console.log(docsOnly ? 'Pre-push: documentation checks passed. Remote CI remains required.' : 'Pre-push: whitespace, tooling and TypeScript checks passed. Remote CI remains required.');
  return { scope: docsOnly ? 'documentation' : 'executable' };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(path.resolve(process.argv[1])); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

if (isMainModule()) {
  try {
    if (process.argv.length !== 4) throw new Error('This command is invoked by Git pre-push with its remote arguments and ref updates on stdin. Install the hook with npm run hooks:install.');
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error('Push ref input exceeds 64 KiB. Push fewer refs at a time.'); }
    await runPrePush({ input, remote: process.argv[2] });
  } catch (error) { console.error('Pre-push blocked: ' + error.message); process.exitCode = 1; }
}
