'use strict';
let implementation;
function renderer() {
  return implementation ||= import('../runtime/og/index.node.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return import('../runtime/og-loader.mjs').then(module => module.loadImageRenderer());
  });
}
class ImageResponse extends Response {
  constructor(element, options = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'image/png');
    if (!headers.has('cache-control')) headers.set('cache-control', process.env.NODE_ENV === 'development' ? 'no-cache, no-store' : 'public, immutable, no-transform, max-age=31536000');
    let reader;
    let cancelled = false;
    super(new ReadableStream({
      async start(controller) {
        try {
          const { ImageResponse: Render } = await renderer();
          if (cancelled) return;
          reader = new Render(element, options).body.getReader();
        } catch (error) { controller.error(error); }
      },
      async pull(controller) {
        try { const chunk = await reader.read(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); }
        catch (error) { controller.error(error); }
      },
      cancel(reason) { cancelled = true; return reader?.cancel(reason); },
    }), { status: options.status, statusText: options.statusText, headers });
  }
}
module.exports = { ImageResponse };
