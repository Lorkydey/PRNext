import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentDiagnostics, supportedNode } from './diagnostics.mjs';

test('Node diagnostics honor each supported major and its minimum', () => {
  for (const version of ['22.23.4','22.24.0','24.22.1','26.12.1','27.0.0']) assert.equal(supportedNode(version), true, version);
  for (const version of ['20.99.0','22.23.3','23.1.0','24.22.0','25.1.0','26.12.0','24.22.1-rc.1','garbage']) assert.equal(supportedNode(version), false, version);
});

test('environment diagnostics collect independent failures and never permit native builds', async () => {
  let calls = 0;
  const diagnostics = await environmentDiagnostics({ version: '20.1.0', platform: 'linux', arch: 'x64', libc: 'glibc', env: {},
    resolve: async options => { calls++; assert.equal(options.allowBuild, false); throw new Error('Native package missing'); } });
  assert.equal(calls, 1);
  assert.deepEqual(diagnostics.map(value => value.id), ['node','native']);
  assert.ok(diagnostics.every(value => value.severity === 'error' && value.action));
  const unsupported = await environmentDiagnostics({ version: '24.22.1', platform: 'linux', arch: 'x64', libc: 'musl', env: {}, resolve: () => assert.fail('unsupported platform must not launch anything') });
  assert.match(unsupported[1].message, /no prebuilt/);
  const override = await environmentDiagnostics({ version: '24.22.1', platform: 'linux', arch: 'x64', libc: 'musl', env: { PRNEXT_BINARY: '/custom/build', SECRET: 'do-not-print' }, resolve: async () => '/custom/build' });
  assert.equal(override[1].severity, 'info');
  assert.doesNotMatch(JSON.stringify(override), /do-not-print|\/custom\/build/);
});
