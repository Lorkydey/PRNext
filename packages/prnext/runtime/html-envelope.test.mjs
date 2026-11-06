import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlEnvelope, flightBootstrap } from './html-envelope.mjs';

test('HTML envelopes preserve bytes across every tag, quote, comment and raw-element split', () => {
  const html = '<!doctype html><html><head><TITLE>a > b</TITLE><style>a::after{content:"<body>"}</style></head><body>' +
    '<!-- <script>never execute</script> --><!--><p title="one > two" data-x=\'a < b\'>caf\u00e9 \ud83d\ude80</p>' +
    '<script nonce="x">let a="</body>";if(a<1){a++}</script><textarea><b>text</b></textarea>' +
    '<svg><path d="M0 0"/></svg><math><mi>x</mi></math><script/><table><tr><td>row</td></tr></table></body></html>';
  for (let split = 0; split <= html.length; split++) {
    const envelope = htmlEnvelope();
    const output = envelope.append(html.slice(0, split)) + envelope.append(html.slice(split));
    assert.equal(output + envelope.finish(), html, `split ${split}`);
  }
  const envelope = htmlEnvelope();
  assert.equal([...html].map(character => envelope.append(character)).join('') + envelope.finish(), html);
});

test('an incomplete tag or raw element stays buffered while preceding HTML flushes', () => {
  for (const [start, end] of [
    ['<p title="one>', 'two">content</p>'],
    ['<!-- <p>', '-->'],
    ['<ScRiPt>const message="', '<p>";</sCrIpT>'],
    ['<style>a{content:"', '<p>"}</style>'],
    ['<textarea>', '<p>plain text</textarea>'],
    ['<svg>', '<path/></svg>'],
  ]) {
    const envelope = htmlEnvelope();
    assert.equal(envelope.append('<html><body>prefix' + start), '<html><body>prefix');
    assert.equal(envelope.append(end + '</body></html>'), start + end);
    assert.equal(envelope.finish(), '</body></html>');
  }
});

test('document closing tags, resumed documents and response bounds retain their validation', () => {
  const resumed = htmlEnvelope({ resumed: true });
  assert.equal(resumed.append('content</body></html></body></html>'), 'content');
  assert.equal(resumed.finish(), '</body></html>');
  const upper = htmlEnvelope();
  assert.equal(upper.append('content</BODY></HTML>'), 'content');
  assert.equal(upper.finish(), '</BODY></HTML>');
  for (const html of ['<html><body>missing close', '</body>', '</html></body>', '<script>unfinished</body></html>', '<!--unfinished</body></html>', 'x</body></html></body></html>']) {
    const envelope = htmlEnvelope();
    envelope.append(html);
    assert.throws(() => envelope.finish(), /root layout did not close/);
  }
  const bounded = htmlEnvelope();
  assert.throws(() => bounded.append('x'.repeat(16 * 1024 * 1024 + 1)), /16 MiB/);
});

test('special-tag prefix filtering preserves ordinary lookalikes and mixed-case raw tags', () => {
  const names = ['script', 'style', 'textarea', 'title', 'svg', 'math'];
  const raw = names.map(name => {
    const mixed = [...name].map((letter, index) => index % 2 ? letter.toUpperCase() : letter).join('');
    return `<${mixed} data-x="quoted > <body>">literal </body><p>child</p></${mixed}>`;
  }).join('');
  const ordinary = ['section', 'strong', 'table', 'tbody', 'tr', 'td', 'main', 'scripture', 'styles', 'textareas', 'titles', 'svgish', 'mathish']
    .map(name => `<${name} title="quoted > <script>">content</${name}>`).join('');
  const html = '<!doctype html><html><head></head><body>' + ordinary + raw + '</body></html>';
  for (let split = 0; split <= html.length; split++) {
    const envelope = htmlEnvelope();
    assert.equal(envelope.append(html.slice(0, split)) + envelope.append(html.slice(split)) + envelope.finish(), html, `split ${split}`);
  }
});

test('binary Flight bootstrap preserves the exact legacy HTML for partial views and every base64 remainder', () => {
  for (const nonceAttribute of ['', ' nonce="abc+/=&amp;&quot;"', ' nonce="caf\u00e9"']) {
    const encode = flightBootstrap(nonceAttribute);
    for (const length of [0, 1, 2, 3, 31, 32768, 65536]) {
      const storage = new Uint8Array(length + 19).fill(255);
      const visible = storage.subarray(7, 7 + length);
      for (let index = 0; index < length; index++) visible[index] = index % 251;
      const original = Buffer.from(visible);
      const expected = `<script${nonceAttribute}>(self.__PRNEXT_FLIGHT_STREAM__||=[]).push("${original.toString('base64')}");document.currentScript.remove()</script>`;
      const result = encode(visible);
      assert.equal(result.toString(), expected);
      assert.deepEqual(Buffer.from(result.toString().match(/push\("([^"]*)"\)/)[1], 'base64'), original);
      assert.deepEqual(Buffer.from(visible), original);
      assert.deepEqual(encode(Buffer.from(visible)), result);
    }
  }
});

test('bootstrap buffers stay independent across writes and private nonces remain response-scoped', () => {
  const first = flightBootstrap(' nonce="first"'), second = flightBootstrap(' nonce="second"');
  const source = Buffer.from('one'), output = first(source), expected = Buffer.from(output);
  source.fill(0); first(Buffer.from('two')); second(Buffer.from('three'));
  assert.deepEqual(output, expected);
  assert.ok(output.includes('nonce="first"'));
  assert.equal(output.includes('second'), false);
  assert.ok(second(new Uint8Array([255])).includes('nonce="second"'));
  assert.throws(() => first('not bytes'), /Invalid Flight bootstrap bytes/);
  assert.throws(() => first(new Uint8Array(16 * 1024 * 1024 + 1)), /Invalid Flight bootstrap bytes/);
});
