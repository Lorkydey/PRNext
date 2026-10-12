import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceWithNative } from './launch.mjs';

test('Linux handoff preserves argv boundaries, environment, and explicit stdin policy', () => {
  for (const platform of ['linux']) {
    const calls = [], env = { NODE_ENV: 'production', NODE_OPTIONS: '--max-semi-space-size=8', VALUE: 'a b' };
    const args = ['start', '/an app/é', '--shutdown-on-stdin-eof'];
    assert.equal(replaceWithNative('/a binary/prnext', args, env, { platform, execArgv: [], execve: (...a) => calls.push(a) }), true);
    assert.deepEqual(calls, [['/a binary/prnext', ['/a binary/prnext', ...args, '--cli-exec'], env]]);
    assert.deepEqual(args, ['start', '/an app/é', '--shutdown-on-stdin-eof']);
  }
});

test('unsupported runtimes, IPC and instrumentation keep the supervised launcher', () => {
  const execve = () => assert.fail('must retain the Node supervisor');
  for (const runtime of [{ platform: 'win32', execve }, { platform: 'darwin', execve }, { platform: 'linux' }, { platform: 'aix', execve },
    { platform: 'linux', execve, send() {} }, { platform: 'linux', execve, execArgv: ['--inspect=0'] }]) {
    assert.equal(replaceWithNative('/prnext', [], {}, runtime), false);
  }
  for (const env of [{ NODE_V8_COVERAGE: '/coverage' }, ...['--require ./preload.cjs', '-r ./preload.cjs', '-r./preload.cjs',
    '--import=./hooks.mjs', '--experimental-loader ./loader.mjs', '--cpu-prof', '--heap-prof', '--experimental-permission',
    '--report-on-signal', '--heapsnapshot-signal=SIGUSR2', '--conditions=instrumented', '--no-warnings']
    .map(NODE_OPTIONS => ({ NODE_OPTIONS }))]) {
    assert.equal(replaceWithNative('/prnext', [], env, { platform: 'linux', execve }), false);
  }
});

test('handoff errors remain visible instead of launching a second server', () => {
  const failure = new Error('exec failed');
  assert.throws(() => replaceWithNative('/prnext', [], {}, { platform: 'linux', execve() { throw failure; } }), error => error === failure);
});
