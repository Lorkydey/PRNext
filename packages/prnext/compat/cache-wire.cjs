'use strict';
// Versioned private framing: bounded JSON metadata followed by uninterpreted bytes.
const TYPE = 'application/vnd.prnext.cache-v2';
const MAX_VALUE = 2 * 1024 * 1024;
const MAX_META = 2 * 1024 * 1024;
function encode(operation) {
  const { value, ...metadata } = operation;
  if (value !== undefined && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new TypeError('Cache wire values must be bytes');
  const bytes = value === undefined ? undefined : Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes && (metadata.op !== 'commit' || bytes.length > MAX_VALUE)) throw new Error('Invalid cache wire value');
  if (metadata.op === 'commit' && !bytes) throw new Error('Cache commit requires bytes');
  const json = Buffer.from(JSON.stringify(metadata));
  if (json.length > MAX_META) throw new Error('Cache wire metadata exceeds limit');
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(json.length);
  return bytes ? [prefix, json, bytes] : [prefix, json];
}
function decode(bytes) {
  if (bytes.length < 4) throw new Error('Truncated cache wire frame');
  const length = bytes.readUInt32BE(0);
  if (length > MAX_META || length > bytes.length - 4) throw new Error('Invalid cache wire metadata length');
  const value = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache wire metadata');
  const raw = bytes.subarray(4 + length);
  if (raw.length > MAX_VALUE || (value.value !== true && raw.length) || (value.value !== undefined && value.value !== true)) throw new Error('Invalid cache wire payload');
  if (value.value === true) value.value = raw;
  return value;
}
module.exports = { TYPE, MAX_VALUE, MAX_META, encode, decode };
