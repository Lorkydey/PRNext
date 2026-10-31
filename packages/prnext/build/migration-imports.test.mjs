import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditImportGraph } from './migration-imports.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-import-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

test('audit follows imported dependency chains and checks actual named adapters without loading packages', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/page.jsx': "import { Widget } from 'widget'; export default Widget;",
    'node_modules/widget/package.json': '{"name":"widget","version":"1.2.3","exports":{"import":"./entry.mjs","require":"./wrong.cjs"}}',
    'node_modules/widget/entry.mjs': "import { missingNavigationApi } from 'next/navigation'; import { helper } from './helper.mjs'; export const Widget = helper; throw new Error('MUST NOT RUN');",
    'node_modules/widget/helper.mjs': "export { cookies } from 'next/headers';",
    'node_modules/widget/wrong.cjs': "require('next/dist/wrong-conditional')",
    'node_modules/unrelated/package.json': '{"name":"unrelated","main":"index.js"}',
    'node_modules/unrelated/index.js': "require('next/dist/must-not-be-scanned')",
  });
  const result = await auditImportGraph(root, [path.join(root, 'app/page.jsx')]);
  const finding = result.findings.find(value => value.id === 'unsupported-export');
  assert.equal(finding.file, 'npm:widget/entry.mjs');
  assert.equal(finding.line, 1);
  assert.match(finding.message, /missingNavigationApi/);
  assert.deepEqual(finding.chain, [{ file: 'app/page.jsx', line: 1, specifier: 'widget' }]);
  assert.equal(result.findings.some(value => value.id === 'unsupported-import'), false);
  assert.deepEqual(result.dependencies.map(({ name, version }) => ({ name, version })), [{ name: 'widget', version: '1.2.3' }]);
  assert.equal(result.evidence.state, 'checked');
  assert.match(await readFile(path.join(root, 'node_modules/widget/entry.mjs'), 'utf8'), /MUST NOT RUN/);
  assert.deepEqual((await readdir(root)).sort(), ['app', 'node_modules', 'package.json']);
});

test('aliased roots produce canonical relative findings and client helper chains', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/client.jsx': "'use client';import '../lib/shared.js';",
    'lib/shared.js': "import { cookies } from 'next/headers';",
  });
  const alias = root + '-alias';
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(alias, { force: true }));
  const result = await auditImportGraph(alias, [path.join(alias, 'app/client.jsx')]);
  const finding = result.findings.find(value => value.id === 'server-import-in-client');
  assert.equal(finding?.file, 'lib/shared.js');
  assert.deepEqual(finding.chain, [{ file: 'app/client.jsx', line: 1, specifier: '../lib/shared.js' }]);
});

test('audit uses require, browser and react-server export conditions and follows workspace symlinks once', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/page.jsx': "import 'conditional';",
    'app/client.jsx': "'use client'; import 'conditional';",
    'pages/api/test.cjs': "require('conditional');",
    'workspace/package.json': '{"name":"conditional","version":"1.0.0","exports":{"react-server":"./rsc.mjs","browser":"./browser.mjs","import":"./node.mjs","require":"./require.cjs"}}',
    'workspace/rsc.mjs': "import 'next/dist/rsc-only';",
    'workspace/browser.mjs': "import 'next/dist/browser-only';",
    'workspace/node.mjs': "import './cycle.mjs';",
    'workspace/cycle.mjs': "import './node.mjs';",
    'workspace/require.cjs': "require('next/dist/require-only');",
  });
  await mkdir(path.join(root, 'node_modules'));
  await symlink(path.join(root, 'workspace'), path.join(root, 'node_modules/conditional'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await auditImportGraph(root, ['app/page.jsx', 'app/client.jsx', 'pages/api/test.cjs'].map(file => path.join(root, file)));
  assert.deepEqual(result.findings.filter(value => value.id === 'unsupported-import').map(value => value.message.match(/next\/dist\/[\w-]+/)[0]).sort(), ['next/dist/browser-only', 'next/dist/require-only', 'next/dist/rsc-only']);
  assert.ok(result.evidence.modules <= 8);
  assert.equal(result.dependencies.length, 1);
});

test('react-server conditions survive a shared local helper outside app when its resolved path is unchanged', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/page.jsx': "export { default } from '../lib/shared.js';",
    'lib/shared.js': "export { default } from 'conditional-review';",
    'node_modules/conditional-review/package.json': '{"name":"conditional-review","version":"1.0.0","exports":{"react-server":"./rsc.js","default":"./node.js"}}',
    'node_modules/conditional-review/rsc.js': "import 'next/dist/unsupported-rsc'; export default function Page(){};",
    'node_modules/conditional-review/node.js': 'export default function Page(){};',
  });
  const result = await auditImportGraph(root, [path.join(root, 'app/page.jsx')]);
  const failure = result.findings.find(value => value.id === 'unsupported-import');
  assert.ok(failure, 'the imported RSC condition must be inspected through a shared helper');
  assert.equal(failure.file, 'npm:conditional-review/rsc.js');
  assert.deepEqual(failure.chain, [
    { file: 'app/page.jsx', line: 1, specifier: '../lib/shared.js' },
    { file: 'lib/shared.js', line: 1, specifier: 'conditional-review' },
  ]);
  assert.ok(result.evidence.modules <= 4);
});

test('unknown imports and native modules stay unknown, type-only and font imports are not rejected', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'page.tsx': "import type { invented } from 'next/navigation'; import { Roboto } from 'next/font/google'; import { cookies } from 'next/headers'; import missing from 'not-installed'; const name = 'dynamic'; import(name); require('./native.node');",
    'native.node': 'not a real binary',
  });
  const result = await auditImportGraph(root, [path.join(root, 'page.tsx')]);
  assert.equal(result.findings.some(value => value.severity === 'error'), false);
  assert.deepEqual(result.findings.map(value => value.id).sort(), ['compiler-import', 'computed-import', 'loader-import', 'unresolved-import']);
  assert.equal(result.evidence.state, 'unknown');
  assert.equal(result.evidence.unknown, 4);
});

test('client boundaries propagate through helpers and graph depth is bounded', async t => {
  const files = { 'package.json': '{"name":"app","type":"module"}', 'entry.jsx': "'use client'; import './helper.js';", 'helper.js': "import { cookies } from 'next/headers'; import './depth0.js';" };
  for (let i = 0; i < 35; i++) files[`depth${i}.js`] = i < 34 ? `import './depth${i + 1}.js'` : 'export const end = true';
  const root = await fixture(t, files);
  const result = await auditImportGraph(root, [path.join(root, 'entry.jsx')]);
  assert.equal(result.findings.some(value => value.id === 'server-import-in-client' && value.file === 'helper.js'), true);
  assert.equal(result.evidence.limited, true);
  assert.equal(result.evidence.state, 'unknown');
  assert.ok(result.evidence.modules <= 33);
  assert.equal(result.findings.some(value => value.id === 'import-graph-limit'), true);
});

test('client imports through a barrel cross module-level Server Action boundaries and still audit server dependencies', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/client.jsx': "'use client'; import { save } from '../lib/actions.js'; export { save };",
    'lib/actions.js': "export { save } from './save.js';",
    'lib/save.js': "'use server'; import { cookies } from 'next/headers'; import './server-helper.js'; export async function save() { return cookies(); }",
    'lib/server-helper.js': "import 'server-conditional';",
    'node_modules/server-conditional/package.json': '{"name":"server-conditional","version":"1.0.0","exports":{"react-server":"./rsc.js","browser":"./browser.js","default":"./node.js"}}',
    'node_modules/server-conditional/rsc.js': "import 'next/dist/server-action-rsc'; throw new Error('MUST NOT RUN');",
    'node_modules/server-conditional/browser.js': "import 'next/dist/incorrect-browser-branch';",
    'node_modules/server-conditional/node.js': "import 'next/dist/incorrect-node-branch';",
  });
  const result = await auditImportGraph(root, [path.join(root, 'app/client.jsx')]);
  assert.equal(result.findings.some(value => value.id === 'server-import-in-client'), false);
  const errors = result.findings.filter(value => value.severity === 'error');
  assert.equal(errors.length, 1, 'the Server Action implementation must still be audited under react-server conditions');
  assert.equal(errors[0].file, 'npm:server-conditional/rsc.js');
  assert.equal(errors[0].id, 'unsupported-import');
  assert.deepEqual(errors[0].chain.map(edge => edge.specifier), ['../lib/actions.js', './save.js', './server-helper.js', 'server-conditional']);
  assert.deepEqual(result.dependencies.map(value => value.name), ['server-conditional']);
});

test('Server Action exports do not turn sibling helpers or inline function directives into server boundaries', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/client.jsx': "'use client'; import '../lib/barrel.js';",
    'lib/barrel.js': "export { save } from './save.js'; export { read } from './unsafe.js'; export { inline } from './inline.js';",
    'lib/save.js': "'use server'; import { cookies } from 'next/headers'; export async function save() { return cookies(); }",
    'lib/unsafe.js': "import { cookies } from 'next/headers'; export function read() { return cookies(); }",
    'lib/inline.js': "import { headers } from 'next/headers'; export async function inline() { 'use server'; return headers(); }",
  });
  const result = await auditImportGraph(root, [path.join(root, 'app/client.jsx')]);
  assert.deepEqual(result.findings.filter(value => value.id === 'server-import-in-client').map(value => value.file).sort(), ['lib/inline.js', 'lib/unsafe.js']);
});

test('Node builtins in client helpers are rejected while server implementations remain valid', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/client.jsx': "'use client'; import '../lib/client-helper.js'; import { save } from '../lib/save.js';",
    'lib/client-helper.js': "import { readFileSync } from 'node:fs';\nconst net = require('net');",
    'lib/save.js': "'use server'; import { readFileSync } from 'node:fs'; export async function save() { return readFileSync('/value','utf8'); }",
    'app/page.jsx': "import { readFileSync } from 'fs'; export default function Page() {}",
    'pages/api/value.js': "import 'node:crypto'; export default function handler() {}",
  });
  const result = await auditImportGraph(root, ['app/client.jsx', 'app/page.jsx', 'pages/api/value.js'].map(file => path.join(root, file)));
  const failures = result.findings.filter(value => value.id === 'node-builtin-in-client');
  assert.deepEqual(failures.map(value => [value.file, value.line]), [['lib/client-helper.js', 1], ['lib/client-helper.js', 2]]);
  assert.ok(failures.every(value => value.severity === 'error'));
  assert.deepEqual(failures[0].chain.map(edge => edge.specifier), ['../lib/client-helper.js']);
  assert.equal(result.findings.some(value => value.file === 'lib/save.js' || value.file === 'app/page.jsx' || value.file === 'pages/api/value.js'), false);
});

test('real browser shims are audited and package browser:false mappings are accepted', async t => {
  const root = await fixture(t, {
    'package.json': '{"name":"app","type":"module"}',
    'app/client.jsx': "'use client'; import { Buffer } from 'buffer'; import 'browser-owner'; import type { Stats } from 'node:fs';",
    'node_modules/buffer/package.json': '{"name":"buffer","version":"1.0.0","main":"index.js"}',
    'node_modules/buffer/index.js': "export { unsupportedReviewExport as Buffer } from 'next/navigation';",
    'node_modules/browser-owner/package.json': '{"name":"browser-owner","version":"1.0.0","main":"index.js","browser":{"fs":false,"net":"./net-browser.js"}}',
    'node_modules/browser-owner/index.js': "import 'fs'; import 'net';",
    'node_modules/browser-owner/net-browser.js': "export const browser = true;",
  });
  // Type-only syntax is owned by TS even when other client fixtures use JSX.
  await writeFile(path.join(root, 'app/client.tsx'), await readFile(path.join(root, 'app/client.jsx')));
  const result = await auditImportGraph(root, [path.join(root, 'app/client.tsx')]);
  assert.equal(result.findings.some(value => value.id === 'node-builtin-in-client'), false);
  assert.equal(result.findings.some(value => value.id === 'source-syntax' || value.id === 'loader-import'), false, JSON.stringify(result.findings));
  assert.ok(result.findings.some(value => value.id === 'unsupported-export' && value.file === 'npm:buffer/index.js'));
  assert.ok(result.evidence.modules >= 4, 'the mapped browser implementation remains in the imported graph');
});
