import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlEnvelope } from './html-envelope.mjs';

test('fragmented raw elements never expose an insertion point before their complete closing tag', () => {
  for (const name of ['script', 'style', 'textarea', 'title', 'svg', 'math']) {
    const envelope = htmlEnvelope();
    const start = `<${name} data-description="quoted > bracket">`;
    assert.equal(envelope.append('<html><head></head><body>before' + start), '<html><head></head><body>before');
    const chunks = Array.from({ length: 96 }, (_, index) => `Unicode é 🚀 ${index} <lookalike> </${name}ish> ` + 'x'.repeat(4096));
    for (const chunk of chunks) assert.equal(envelope.append(chunk), '', 'Flight must remain outside the raw element');
    const closing = `</${name.toUpperCase()}${' \t\n\r\u00a0'.repeat(40)}>`;
    for (const character of closing.slice(0, -1)) assert.equal(envelope.append(character), '');
    assert.equal(envelope.append('><p>after</p></body></html>'), start + chunks.join('') + closing + '<p>after</p>');
    assert.equal(envelope.finish(), '</body></html>');
  }
});

test('fragmented closing-tag lookalikes do not terminate a held raw element', () => {
  const envelope = htmlEnvelope();
  assert.equal(envelope.append('<html><head></head><body><script>'), '<html><head></head><body>');
  const content = ['</scr', 'iptX>', '</script ', 'x>', '<', '</sc', '<\u000fscript>', '</script', '\t', 'x>', 'é 🚀'];
  for (const chunk of content) assert.equal(envelope.append(chunk), '');
  assert.throws(() => envelope.finish(), /root layout did not close/);
  assert.equal(envelope.append('</ScRiPt><style>a{color:red}</style></body></html>'), '<script>' + content.join('') + '</ScRiPt><style>a{color:red}</style>');
  assert.equal(envelope.finish(), '</body></html>');
});

test('several unfinished raw elements can complete in one chunk without swallowing document closing tags', () => {
  const envelope = htmlEnvelope();
  assert.equal(envelope.append('<html><head></head><body><script>one'), '<html><head></head><body>');
  assert.equal(envelope.append('</script><style>two</style><textarea>three'), '<script>one</script><style>two</style>');
  assert.equal(envelope.append('</textarea><svg><path /></svg></body></html>'), '<textarea>three</textarea><svg><path /></svg>');
  assert.equal(envelope.finish(), '</body></html>');
});

test('a fragmented unterminated raw element still rejects at the response byte limit', () => {
  const envelope = htmlEnvelope();
  envelope.append('<html><head></head><body><script>');
  const chunk = 'x'.repeat(64 * 1024);
  for (let index = 0; index < 255; index++) assert.equal(envelope.append(chunk), '');
  assert.throws(() => envelope.append(chunk), /16 MiB/);
  assert.throws(() => envelope.finish(), /root layout did not close/);
});

test('very small raw-text chunks preserve their order across bounded buffering tiers', () => {
  const envelope = htmlEnvelope();
  assert.equal(envelope.append('<html><head></head><body><script>'), '<html><head></head><body>');
  const text = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(8192);
  for (const character of text) assert.equal(envelope.append(character), '');
  assert.equal(envelope.append('</script></body></html>'), '<script>' + text + '</script>');
  assert.equal(envelope.finish(), '</body></html>');
});

test('long quoted attributes stay intact across chunks containing greater-than signs and opposite quotes', () => {
  for (const quote of ['"', "'"]) {
    const envelope = htmlEnvelope();
    const other = quote === '"' ? "'" : '"';
    const value = `é 🚀 ${other} <script> > </body>`.repeat(1024);
    const tag = `<section data-value=${quote}${value}${quote}>`;
    assert.equal(envelope.append('<html><head></head><body>'), '<html><head></head><body>');
    for (let offset = 0; offset < tag.length - 1; offset += 127) {
      assert.equal(envelope.append(tag.slice(offset, Math.min(offset + 127, tag.length - 1))), '');
    }
    assert.equal(envelope.append('>text</section></body></html>'), tag + 'text</section>');
    assert.equal(envelope.finish(), '</body></html>');
  }
});
