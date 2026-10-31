import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionNetworkRecorder } from './action-network.mjs';

test('browser action metrics record lifecycle and a hashed identifier without credentials or payloads', () => {
  const recorder = createActionNetworkRecorder('https://127.0.0.1:1234');
  const context = new EventEmitter(), page = new EventEmitter();
  recorder.observeContext(context); context.emit('page', page);
  const request = { method: () => 'POST', url: () => 'https://127.0.0.1:1234/en/dashboard?private=query', headers: () => ({ 'next-action': 'private-action-id', cookie: 'secret-cookie' }), failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
  page.emit('request', request);
  assert.throws(() => recorder.assertComplete(), /terminal lifecycle/);
  page.emit('response', { request: () => request, status: () => 200, headers: () => ({ 'content-type': 'text/x-component;charset=utf-8' }) });
  page.emit('requestfailed', request);
  recorder.assertComplete();
  assert.equal(recorder.records[0].terminal, 'failed');
  assert.equal(recorder.records[0].failure, 'net::ERR_ABORTED');
  assert.equal(recorder.records[0].status, 200);
  assert.equal(recorder.records[0].contentType, 'text/x-component');
  assert.match(recorder.records[0].actionSha256, /^[a-f0-9]{64}$/);
  assert.ok(recorder.records[0].durationMs >= 0);
  assert.ok(!/private|secret|cookie/.test(JSON.stringify(recorder.records)));
});

test('browser action evidence remains bounded and marks context closure honestly', () => {
  const recorder = createActionNetworkRecorder('https://127.0.0.1:1234', { limit: 1 });
  const context = new EventEmitter(), page = new EventEmitter();
  recorder.observeContext(context); context.emit('page', page);
  const request = () => ({ method: () => 'POST', url: () => 'https://127.0.0.1:1234/en', headers: () => ({ 'next-action': 'id' }) });
  page.emit('request', request()); page.emit('request', request()); context.emit('close');
  assert.equal(recorder.records.length, 1);
  assert.equal(recorder.records[0].terminal, 'context-closed');
  assert.throws(() => recorder.assertComplete(), /bounded capacity/);
});
