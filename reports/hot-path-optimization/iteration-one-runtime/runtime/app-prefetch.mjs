// Prefetch contains only prerendered segments. Request-dependent holes are
// resolved by a fresh, authenticated navigation; they never enter this cache.
export const PARTIAL_PREFETCH_TYPE = 'application/x-rustyx-ppr+json';
export const PARTIAL_PREFETCH_BYTES = 768 * 1024;
export const PARTIAL_PREFETCH_CACHE_BYTES = 2 * 1024 * 1024;

export async function readPartialPrefetch(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PARTIAL_PREFETCH_BYTES) throw new Error('Partial prefetch exceeds the segment cache limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (value?.version !== 1 || typeof value.id !== 'string' || value.id.length !== 64 ||
      (value.flight !== undefined && typeof value.flight !== 'string') || !Array.isArray(value.keys) ||
      typeof value.router?.pathname !== 'string') throw new Error('Invalid partial prefetch response');
  return value;
}

export function partialFlightStream(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
