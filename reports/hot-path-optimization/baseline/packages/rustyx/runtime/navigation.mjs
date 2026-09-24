/** Decode Next's navigation control signals without treating user errors as 500s. */
export function navigationResponse(error) {
  const digest = error?.digest;
  if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from('Not Found') };
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT;')) return null;
  const parts = digest.split(';');
  if (parts.at(-1) === '') parts.pop();
  const status = Number(parts.pop());
  const destination = parts.slice(2).join(';');
  if (![307, 308].includes(status) || !destination || /[\r\n]/.test(destination)) return null;
  let parsed;
  try { parsed = new URL(destination, 'http://rustyx.invalid'); }
  catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  return { status, headers: { location: destination, 'cache-control': 'no-store' }, body: Buffer.alloc(0) };
}
