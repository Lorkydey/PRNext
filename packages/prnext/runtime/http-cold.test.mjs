import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const runtime = process.env.PRNEXT_TEST_HTTP_RUNTIME || new URL('./http.mjs', import.meta.url).href;

function freshProcess(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, runtime], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('HTTP adapter import does not initialize the unrelated Undici web API implementation', () => {
  const modules = JSON.parse(freshProcess(`
    await import(process.argv[1]);
    process.stdout.write(JSON.stringify(process.moduleLoadList.filter(name => name.includes('undici'))));
  `));
  assert.deepEqual(modules, []);
});

test('HTTP adapter retains IncomingMessage, query/body handling and native header validation', () => {
  freshProcess(`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const http = createRequire(import.meta.url)('node:http');
    const runtime = await import(process.argv[1]);
    const { request, bytes } = runtime.createRequest({
      url: 'http://localhost/a?x=1&x=2', headers: { Cookie: 'a=one%20two' }, body: Buffer.from('body'),
    });
    assert.ok(request instanceof http.IncomingMessage);
    assert.equal(bytes.toString(), 'body');
    assert.deepEqual(request.query.x, ['1', '2']);
    assert.equal(request.cookies.a, 'one two');
    const response = new runtime.CapturedResponse();
    assert.throws(() => response.setHeader('bad header', 'value'), TypeError);
    assert.throws(() => response.setHeader('x-test', 'bad\\r\\nvalue'), TypeError);
    response.status(201).setHeader('set-cookie', ['a=1', 'b=2']).end('content');
    assert.deepEqual(response.result(), {
      status: 201, headers: { 'set-cookie': ['a=1', 'b=2'] }, body: Buffer.from('content'),
    });
  `);
});

test('HTTP adapter observes builtin constructor and validator instrumentation installed after import', () => {
  freshProcess(`
    import assert from 'node:assert/strict';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const http = createRequire(import.meta.url)('node:http');
    const runtime = await import(process.argv[1]);
    const original = {
      IncomingMessage: http.IncomingMessage,
      validateHeaderName: http.validateHeaderName,
      validateHeaderValue: http.validateHeaderValue,
    };
    const calls = { name: 0, value: 0 };
    try {
      http.IncomingMessage = class InstrumentedIncomingMessage extends original.IncomingMessage {};
      http.validateHeaderName = (...args) => { calls.name++; return original.validateHeaderName(...args); };
      http.validateHeaderValue = (...args) => { calls.value++; return original.validateHeaderValue(...args); };
      syncBuiltinESMExports();
      assert.ok(runtime.createRequest({ url: 'http://localhost/' }).request instanceof http.IncomingMessage);
      const response = new runtime.CapturedResponse();
      response.setHeader('x-test', 'ok');
      assert.equal(calls.name, 1);
      assert.equal(calls.value, 1);
      assert.throws(() => response.setHeader('x-test', 'bad\\r\\nvalue'), TypeError);
    } finally {
      Object.assign(http, original);
      syncBuiltinESMExports();
    }
  `);
});
