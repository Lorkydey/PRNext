export function validateProxyBodySize(value = 10 * 1024 * 1024) {
  let bytes = value;
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
    if (!match) throw new TypeError('experimental.proxyClientMaxBodySize expects bytes or a size such as "25mb"');
    bytes = Math.floor(Number(match[1]) * 1024 ** Math.max(0, ['b', 'kb', 'mb', 'gb'].indexOf((match[2] || 'b').toLowerCase())));
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32 * 1024 * 1024) throw new TypeError('experimental.proxyClientMaxBodySize must be between 1 byte and the PRNext 32 MiB buffered transport limit');
  return bytes;
}
