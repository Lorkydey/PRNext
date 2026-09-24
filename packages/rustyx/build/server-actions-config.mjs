export function validateServerActions(input) {
  if (input === undefined || input === true) input = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('experimental.serverActions must be an object');
  for (const name of Object.keys(input)) if (!['allowedOrigins', 'bodySizeLimit'].includes(name)) throw new TypeError(`experimental.serverActions.${name} is not implemented`);
  const origins = input.allowedOrigins ?? [];
  if (!Array.isArray(origins) || origins.length > 128) throw new TypeError('serverActions.allowedOrigins must contain at most 128 host patterns');
  for (const origin of origins) {
    if (typeof origin !== 'string' || !origin || origin.length > 256 || /[^\x21-\x7e]|[/\\@?#]/.test(origin)) throw new TypeError('serverActions.allowedOrigins expects host names with optional ports, not URLs');
    if (origin.startsWith('[')) {
      try { const url = new URL('http://' + origin); if (url.host !== origin.toLowerCase() && url.port !== '') throw new Error(); }
      catch { throw new TypeError(`Invalid serverActions.allowedOrigins host: ${origin}`); }
    } else {
      const match = /^([^:]+)(?::([0-9]+))?$/.exec(origin);
      if (!match || match[2] && (Number(match[2]) > 65535 || Number(match[2]) < 1)) throw new TypeError(`Invalid serverActions.allowedOrigins host: ${origin}`);
      const labels = match[1].split('.');
      if (labels.some((part, index) => !/^[a-zA-Z0-9_-]+$/.test(part) && part !== '*' && !(part === '**' && index === 0)) || labels.length === 1 && labels[0].includes('*')) throw new TypeError(`Invalid serverActions.allowedOrigins pattern: ${origin}`);
    }
  }
  let bytes = input.bodySizeLimit ?? 1024 * 1024;
  if (typeof bytes === 'string') {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?$/i.exec(bytes.trim());
    if (!match) throw new TypeError('serverActions.bodySizeLimit expects bytes or a size such as "2mb"');
    bytes = Math.floor(Number(match[1]) * 1024 ** Math.max(0, ['b', 'kb', 'mb', 'gb', 'tb', 'pb'].indexOf((match[2] || 'b').toLowerCase())));
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8 * 1024 * 1024) throw new TypeError('serverActions.bodySizeLimit must be between 1 byte and the 8 MiB request transport limit');
  return { allowedOrigins: [...new Set(origins.map(origin => origin.toLowerCase()))], bodySizeLimit: bytes };
}
