import test from 'node:test';
import assert from 'node:assert/strict';
import { isReplaySensitiveField } from './dev-replay-client.mjs';

function input({ type = 'text', name = '', id = '', autocomplete, ariaLabel, label } = {}) {
  return {
    name, id, labels: label ? [{ textContent: label }] : [],
    getAttribute(key) { return ({ autocomplete, 'aria-label': ariaLabel })[key] ?? null; },
    matches(selector) {
      if (selector === 'input,textarea,select,[contenteditable]') return true;
      return ['password', 'hidden', 'file'].includes(type);
    },
  };
}

test('ordinary fields with absent optional attributes remain recordable', () => {
  assert.equal(isReplaySensitiveField(input()), false);
  assert.equal(isReplaySensitiveField(input({ name: 'query', label: 'Search query' })), false);
  assert.equal(isReplaySensitiveField({ matches: () => false }), false);
  assert.equal(isReplaySensitiveField(null), false);
});

test('sensitive field types and semantic hints are excluded without reading values', () => {
  for (const options of [
    { type: 'password' }, { type: 'hidden' }, { type: 'file' },
    { name: 'auth_token' }, { name: 'apiKey' }, { id: 'cardholder' }, { autocomplete: 'username' },
    { autocomplete: 'one-time-code' }, { autocomplete: 'cc-number' },
    { ariaLabel: 'Security code' }, { label: 'Private token' },
  ]) {
    const element = input(options);
    Object.defineProperty(element, 'value', { get() { throw Error('A form value must never be read.'); } });
    assert.equal(isReplaySensitiveField(element), true, JSON.stringify(options));
  }
  const authInput = input({ name: 'email' }); authInput.form = { id: 'login-form', getAttribute: () => null };
  assert.equal(isReplaySensitiveField(authInput), true);
});
