import React from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { MAX_RESPONSE_BYTES } from './http.mjs';
import { appTimeoutError } from './app-errors.mjs';

const charset = '<meta charSet="utf-8"/>';
const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1"/>';
const robots = '<meta name="robots" content="noindex"/>';
const envelope = head => `<!DOCTYPE html><html id="__prnext_error__"><head>${head}</head><body></body></html>`;
const defaults = envelope(charset + viewport + robots);

function recoveryHead(markup) {
  let hasCharset = false, hasViewport = false;
  const head = markup.replace(/<meta\b[^>]*>/gi, tag => {
    const attributes = Object.create(null);
    for (const match of tag.slice(5, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    hasCharset ||= Object.hasOwn(attributes, 'charset');
    hasViewport ||= attributes.name?.toLowerCase() === 'viewport';
    // Failed documents must remain noindex even if the route requested index.
    return attributes.name?.toLowerCase() === 'robots' ? '' : tag;
  });
  return (hasCharset ? '' : charset) + (hasViewport ? '' : viewport) + head + robots;
}

/** Render the already-decoded metadata, never the failed page or its layout. */
export async function renderAppRecoveryShell(head, { signal, timeoutMs = 25_000 } = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('Recovery timeout must be a nonnegative number');
  if (head == null) return defaults;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let reader, metadataError, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(combined.reason);
  combined.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(appTimeoutError('recovery metadata', timeoutMs)), timeoutMs);
  try {
    const tree = React.createElement('html', { id: '__prnext_error__' },
      React.createElement('head', null, head), React.createElement('body'));
    const stream = await Promise.race([renderToReadableStream(tree, {
      signal: combined,
      onError(error) { metadataError ||= error || new Error('Metadata rendering failed'); },
    }), aborted]);
    // Waiting for all metadata before pulling lets React hoist suspended title
    // and meta elements into the head, without publishing a partial shell.
    await Promise.race([stream.allReady, aborted]);
    combined.throwIfAborted();
    if (metadataError) throw metadataError;
    reader = stream.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        throw Object.assign(new Error('Recovery HTML exceeds the 16 MiB PRNext limit'), { code: 'PRNEXT_RECOVERY_HTML_TOO_LARGE' });
      }
      chunks.push(Buffer.from(value));
    }
    combined.throwIfAborted();
    if (metadataError) throw metadataError;
    const rendered = Buffer.concat(chunks, length).toString('utf8');
    const metadata = /<head>([\s\S]*?)<\/head>/i.exec(rendered)?.[1];
    if (metadata === undefined) throw new Error('Metadata renderer did not produce a head');
    const html = envelope(recoveryHead(metadata));
    if (Buffer.byteLength(html) > MAX_RESPONSE_BYTES) {
      throw Object.assign(new Error('Recovery HTML exceeds the 16 MiB PRNext limit'), { code: 'PRNEXT_RECOVERY_HTML_TOO_LARGE' });
    }
    return html;
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    if (error?.code === 'PRNEXT_RECOVERY_HTML_TOO_LARGE') throw error;
    // A rejected metadata Flight element must not trigger another route render.
    return defaults;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
    controller.abort();
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}
