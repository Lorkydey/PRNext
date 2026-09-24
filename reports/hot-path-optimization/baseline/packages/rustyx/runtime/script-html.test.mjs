import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptNonce } from './script-html.mjs';

test('App script nonces follow script-src precedence, report-only fallback and ignore malformed sources', () => {
  assert.equal(scriptNonce({ 'Content-Security-Policy': "default-src 'nonce-default'; script-src 'self' 'nonce-script=='" }), 'script==');
  assert.equal(scriptNonce({ 'content-security-policy': "default-src 'nonce-default'; script-src 'self'" }), undefined);
  assert.equal(scriptNonce({ 'content-security-policy-report-only': "default-src 'nonce-report_only'" }), 'report_only');
  assert.equal(scriptNonce({ 'content-security-policy': "script-src 'nonce-<invalid>' 'nonce-valid+/'" }), 'valid+/');
  assert.equal(scriptNonce({ 'content-security-policy': "img-src 'nonce-image'" }), undefined);
});
