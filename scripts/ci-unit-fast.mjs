import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// This scenario runs the actual native dev server. The complete unit command
// retains it; the fast loop deliberately has no native build prerequisite.
const nativeIntegration = new Set(['packages/prnext/runtime/dev-env.test.mjs']);
export async function fastUnitFiles(source = root) {
  const files = [];
  for (const folder of ['packages/prnext/runtime', 'packages/prnext/native']) {
    for (const name of (await readdir(path.join(source, folder))).sort()) {
      const file = folder + '/' + name;
      if (name.endsWith('.test.mjs') && !nativeIntegration.has(file)) files.push(file);
    }
  }
  assert.ok(files.length > 0, 'No fast unit files were discovered'); return files;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...await fastUnitFiles()], { cwd: root, stdio: 'inherit', windowsHide: true,
      // Unexpected native use must fail promptly instead of starting Cargo or
      // using a stale developer binary and silently extending this quick mode.
      env: { ...process.env, PRNEXT_BINARY: path.join(root, '.prnext-quick-native-disabled-' + randomUUID()) } });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('close', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
