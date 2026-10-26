import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDevError } from './dev-error-overlay.mjs';

test('React hydration diagnostics have a short readable summary without losing the report', () => {
  for (const message of [
    'Hydration failed because the server rendered text did not match the client.\n\nhttps://react.dev/link/hydration-mismatch\n+ browser\n- server',
    "A tree hydrated but some attributes of the server rendered HTML didn't match the client properties.\nThis will not be patched.",
  ]) {
    const report = { message, stack: 'original complete stack' }, copy = { ...report };
    assert.deepEqual(summarizeDevError(report, { recoverable: true }), { title: 'Hydration mismatch', description: 'The server and browser rendered different output.', hydration: true });
    assert.deepEqual(report, copy);
  }
});

test('runtime errors retain a useful first line while full multiline text remains unchanged', () => {
  const report = { message: "TypeError: Cannot read properties of undefined (reading 'id')\nsecond line" };
  assert.equal(summarizeDevError(report).description, "Cannot read properties of undefined (reading 'id')");
  assert.equal(summarizeDevError(report).title, 'Runtime error');
  assert.ok(report.message.endsWith('\nsecond line'));
});

test('build and TypeScript kinds have distinct labels and bounded summaries', () => {
  assert.equal(summarizeDevError({ message: 'Invalid syntax' }, { kind: 'build' }).title, 'Build error');
  assert.equal(summarizeDevError('file.ts(2,3): Type mismatch', { kind: 'typescript' }).title, 'TypeScript');
  const report = { message: 'x'.repeat(5000) };
  assert.ok(summarizeDevError(report).description.length <= 240);
  assert.ok(summarizeDevError(report).description.endsWith('…'));
  assert.equal(report.message.length, 5000);
});

test('ordinary references to hydration are not presented as React mismatches', () => {
  const result = summarizeDevError({ message: 'Could not load hydration.js' });
  assert.equal(result.title, 'Runtime error'); assert.equal(result.hydration, false);
  assert.ok(summarizeDevError({ message: '' }, { kind: 'build' }).description);
});

test('build summaries remove nested source locations before the actual compiler error', () => {
  const message = String.raw`pages/pages.jsx:1: C:\Users\work\Desktop\prnext\.prnext-hmr-test-FKuBBa\components\Counter.jsx: JSX attributes must only be assigned a non-empty expression. (3:47)`;
  const report = { message, stack: message + '\n    at compile (build.mjs:1:2)' };
  assert.equal(summarizeDevError(report, { kind: 'build' }).description, 'JSX attributes must only be assigned a non-empty expression. (3:47)');
  assert.equal(report.message, message);
  assert.equal(report.stack, message + '\n    at compile (build.mjs:1:2)');
  assert.equal(summarizeDevError(report, { kind: 'runtime' }).description, message);
});

test('build summary cleanup preserves ordinary messages containing colons', () => {
  for (const message of [
    'Cannot resolve dependency: package:subpath',
    'Could not resolve ./Counter.jsx: package not found',
  ]) assert.equal(summarizeDevError({ message }, { kind: 'build' }).description, message);
});
