import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep this an explicit list: Markdown inside examples or fixtures can be code.
const documentation = new Set([
  'README.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'COMPATIBILITY.md',
  'RELEASE.md',
  'packages/prnext/README.md',
  'packages/prnext/build/ADAPTERS.md',
  '.github/assets/prnext-logo.svg',
  '.github/FUNDING.yml',
]);

// Only flat PNG/GIF documentation assets; runtime assets and scripts stay unknown.
const documentationImage = /^\.github\/assets\/[A-Za-z0-9][A-Za-z0-9._@-]*\.(?:png|gif)$/;

export function documentationOnly(changes) {
  return changes.length > 0 && changes.every(({ name, oldMode, newMode }) =>
    (documentation.has(name) ||
      (typeof name === 'string' && documentationImage.exec(name)?.[0] === name)) &&
    [oldMode, newMode].every(mode => mode === '000000' || mode === '100644'));
}

export function readChanges(base, head, cwd = process.cwd()) {
  for (const revision of [base, head]) {
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Expected full commit SHAs');
  }
  const records = execFileSync('git', [
    'diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head, '--',
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0');
  records.pop();
  const changes = [];
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [AMDT]$/.exec(records[index]);
    if (!match || records[index + 1] === undefined) throw new Error('Unexpected Git diff record');
    changes.push({ name: records[index + 1], oldMode: match[1], newMode: match[2] });
  }
  return changes;
}

export function requiresFullTests(event, base, head, cwd = process.cwd()) {
  // Manual runs, initial pushes and unknown event types always use the full suite.
  if (!['pull_request', 'push'].includes(event) || !base || /^0+$/.test(base)) return true;
  return !documentationOnly(readChanges(base, head, cwd));
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

if (isMainModule()) {
  const full = requiresFullTests(process.env.CI_EVENT, process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA);
  console.log(full ? 'Code or configuration changed: run the full platform matrix.' : 'Documentation only: the platform matrix is not needed.');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
}
