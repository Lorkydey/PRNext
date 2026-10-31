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
