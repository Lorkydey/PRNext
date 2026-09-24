import React from 'react';
import { fontPreloads } from './font-preload.mjs';
import { isDynamicBailout } from '../compat/dynamic-bailout.cjs';
import { renderToReadableStream, resume } from 'react-dom/server';
import { AppRouterProvider } from '../compat/app-context.cjs';
import { appContent } from './app-content.mjs';
import { escapeHtml, MAX_RESPONSE_BYTES } from './http.mjs';
import { appTimeoutError, appErrorDigest } from './app-errors.mjs';
import { navigationResponse } from './navigation.mjs';
import { addBasePath } from '../compat/paths.cjs';
import { renderAppRecoveryShell } from './app-recovery.mjs';
import { partialModel } from './app-partial-model.mjs';

// Do not insert bootstrap scripts inside a split HTML tag or raw-text element.
// React may split a large inline script across arbitrary byte chunks.
function htmlEnvelope({ resumed = false } = {}) {
  let pending = '';
  let closing = '';
  let received = 0;
  return {
    append(text) {
      received += Buffer.byteLength(text);
      if (received > MAX_RESPONSE_BYTES) throw new Error('HTML response exceeds the 16 MiB Rustyx limit');
      pending += text;
      let ready = '';
      while (pending) {
        const start = pending.indexOf('<');
        if (start < 0) { ready += pending; pending = ''; break; }
        if (start) { ready += pending.slice(0, start); pending = pending.slice(start); }
        let end = -1;
        if (pending.startsWith('<!--')) {
          const comment = pending.indexOf('-->');
          if (comment >= 0) end = comment + 2;
        } else {
          let quote;
          for (let index = 1; index < pending.length; index++) {
            const char = pending[index];
            if (quote) { if (char === quote) quote = undefined; }
            else if (char === '"' || char === "'") quote = char;
            else if (char === '>') { end = index; break; }
          }
        }
        if (end < 0) break;
        const tag = pending.slice(0, end + 1);
        const raw = /^<(script|style|textarea|title|svg|math)(?:\s|>)/i.exec(tag);
        if (raw && !tag.endsWith('/>')) {
          const match = new RegExp(`</${raw[1]}\\s*>`, 'i').exec(pending.slice(end + 1));
          if (!match) break;
          end += 1 + match.index + match[0].length;
          ready += pending.slice(0, end); pending = pending.slice(end);
        } else {
          if (/^<\/(body|html)\s*>$/i.test(tag)) closing += tag;
          else ready += tag;
          pending = pending.slice(end + 1);
        }
      }
      return ready;
    },
    finish() {
      if (pending || !(resumed ? /^(?:<\/body><\/html>){1,2}$/i : /^<\/body><\/html>$/i).test(closing)) throw new Error('App Router root layout did not close its body and html elements');
      return resumed ? '</body></html>' : closing;
    },
  };
}

// The SSR decoder and HTML bootstrap share each Flight allocation. Unlike
// ReadableStream.tee(), this tap stops reading when the HTML consumer stalls.
// Before a document shell exists, at most the overall 16 MiB response limit can
// accumulate: an async root layout may need the complete model to produce it.
function flightTap(source) {
  const reader = source.getReader();
  const queue = [];
  let bytes = 0;
  let done = false;
  let failure;
  let outputStarted = false;
  let wakeData;
  let wakeSpace;
  const finish = error => {
    done = true; failure = error;
    wakeData?.(); wakeData = undefined;
    wakeSpace?.(); wakeSpace = undefined;
  };
  const cancel = async reason => { finish(reason); await reader.cancel(reason).catch(() => {}); };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (!done && outputStarted && bytes >= 128 * 1024) await new Promise(resolve => { wakeSpace = resolve; });
        if (done) { if (failure) controller.error(failure); else controller.close(); return; }
        const next = await reader.read();
        if (next.done) { finish(); controller.close(); return; }
        queue.push(next.value); bytes += next.value.byteLength;
        wakeData?.(); wakeData = undefined;
        controller.enqueue(next.value);
      } catch (error) { finish(error); controller.error(error); }
    },
    cancel,
  }, { highWaterMark: 0 });
  return {
    body, cancel,
    startOutput() { outputStarted = true; },
    async next() {
      while (!queue.length && !done) await new Promise(resolve => { wakeData = resolve; });
      if (queue.length) {
        const value = queue.shift(); bytes -= value.byteLength;
        wakeSpace?.(); wakeSpace = undefined;
        return { value, done: false };
      }
      if (failure) throw failure;
      return { done: true };
    },
  };
}

export async function renderProgressiveAppHtml({ result, request, route, responseHeaders, decodeFlight, signal, timeoutMs = 25_000, partial }) {
  const nonceAttribute = request.nonce ? ` nonce="${escapeHtml(request.nonce)}"` : '';
  const tap = flightTap(result.body);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(appTimeoutError('HTML stream', timeoutMs)), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let reader;
  let renderError;
  let committed = Boolean(partial?.shellSent);
  let control;
  let model;
  const cancel = async reason => {
    clearTimeout(timeout);
    combinedSignal.removeEventListener('abort', onAbort);
    if (!abort.signal.aborted) abort.abort(reason || new Error('App Router response was cancelled'));
    await Promise.allSettled([tap.cancel(reason), reader?.cancel(reason)]);
  };
  const onAbort = () => { void cancel(combinedSignal.reason); };
  combinedSignal.addEventListener('abort', onAbort, { once: true });
  try {
    model = await decodeFlight(tap.body, request.clientModules, request.distDir, { production: request.production });
    const renderOptions = {
      signal: combinedSignal,
      nonce: request.nonce,
      bootstrapScriptContent: 'self.__RUSTYX_FLIGHT_STREAM__=self.__RUSTYX_FLIGHT_STREAM__||[];',
      bootstrapModules: route.client ? [route.client] : undefined,
      onError(error) {
        if (isDynamicBailout(error)) return error.digest;
        if (combinedSignal.aborted) return error?.digest;
        const navigation = navigationResponse(error);
        if (navigation) {
          if (committed) control = navigation;
          else renderError ??= error;
        } else console.error('[rustyx]', error?.stack || error);
        return appErrorDigest(error);
      },
    };
    const resumedModel = partial?.resumeKeys?.length ? partialModel(model, { keyMap: new Map(partial.resumeKeys) }) : model;
    const element = React.createElement(request.strictMode !== false ? React.StrictMode : React.Fragment, null, React.createElement(AppRouterProvider, { router: resumedModel.router, nonce: request.nonce }, appContent(resumedModel.tree)));
    // React owns and mutates its opaque continuation during resume. Parsed
    // artifacts can be shared, but each HTML request needs its own continuation.
    const html = partial ? await resume(element, structuredClone(partial.postponed), renderOptions) : await renderToReadableStream(element, renderOptions);
    reader = html.getReader();
    const decoder = new TextDecoder();
    let prefix = partial?.shell || '';
    let htmlDone = false;
    // Validate the actual rendered root before handing headers to the transport.
    // A Suspense shell already contains these tags, so delayed children do not
    // block the first byte. A root that omits them fails before a 200 is sent.
    while (!/<body(?:\s[^>]*)?>/i.test(prefix)) {
      const next = await reader.read();
      if (next.done) { htmlDone = true; prefix += decoder.decode(); break; }
      prefix += decoder.decode(next.value, { stream: true });
      if (Buffer.byteLength(prefix) > MAX_RESPONSE_BYTES) throw new Error('HTML shell exceeds the 16 MiB Rustyx limit');
    }
    if (renderError) throw renderError;
    if (!/<html(?:\s|>)/i.test(prefix) || !/<body(?:\s|>)/i.test(prefix) || !/<\/head>/i.test(prefix)) {
      throw Object.assign(new Error('App Router root layout must render <html>, <head> and <body> elements'), { code: 'RUSTYX_INVALID_ROOT_LAYOUT' });
    }
    const styles = fontPreloads(route.fonts, request.nonce) + (route.css || []).map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('');
    if (styles && !partial) prefix = prefix.replace(/<\/head>/i, `${styles}</head>`);
    tap.startOutput();
    committed = true;
    const body = (async function* () {
      let total = 0;
      const envelope = htmlEnvelope({ resumed: Boolean(partial) });
      const encode = value => {
        const bytes = Buffer.from(value);
        total += bytes.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB Rustyx limit');
        return bytes;
      };
      let flightDone = false;
      let nextHtml = htmlDone ? null : reader.read().then(value => ({ type: 'html', ...value }));
      let nextFlight = tap.next().then(value => ({ type: 'flight', ...value }));
      // Attach rejection handlers immediately; either stream can fail while the
      // other one is waiting on a browser with a slow connection.
      nextHtml?.catch(() => {}); nextFlight.catch(() => {});
      try {
        const first = envelope.append(prefix);
        prefix = '';
        if (first && !partial?.shellSent) yield encode(first);
        while (!htmlDone || !flightDone) {
          combinedSignal.throwIfAborted();
          const next = await Promise.race([nextHtml, nextFlight].filter(Boolean));
          if (next.type === 'html') {
            if (next.done) {
              htmlDone = true; nextHtml = null;
              const text = envelope.append(decoder.decode());
              if (text) yield encode(text);
            } else {
              const text = envelope.append(decoder.decode(next.value, { stream: true }));
              nextHtml = reader.read().then(value => ({ type: 'html', ...value }));
              nextHtml.catch(() => {});
              if (text) yield encode(text);
            }
          } else {
            if (next.done) { flightDone = true; nextFlight = null; }
            else {
              const encoded = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength).toString('base64');
              nextFlight = tap.next().then(value => ({ type: 'flight', ...value }));
              nextFlight.catch(() => {});
              yield encode(`<script${nonceAttribute}>(self.__RUSTYX_FLIGHT_STREAM__||=[]).push("${encoded}");document.currentScript.remove()</script>`);
            }
          }
          if (control) {
            const current = control; control = null;
            if (current.headers.location) yield encode(`<meta http-equiv="refresh" content="${current.status === 308 ? 0 : 1};url=${escapeHtml(addBasePath(current.headers.location, request.basePath || ''))}">`);
            else if (current.status === 404) yield encode('<meta name="robots" content="noindex">');
          }
        }
        yield encode(`<script${nonceAttribute}>self.__RUSTYX_FLIGHT_STREAM__.push(null);document.currentScript.remove()</script>` + envelope.finish());
      } finally {
        combinedSignal.removeEventListener('abort', onAbort);
        await cancel();
      }
    })();
    // An error encoded in Flight may be contained by a valid Suspense shell.
    // Ordinary GET errors select HTTP 500 only when that shell also fails.
    const status = result.rscError && result.status === 500 && ['GET', 'HEAD'].includes(request.method) ? 200 : result.status;
    return { status, headers: { ...responseHeaders, ...result.headers, 'content-type': 'text/html; charset=utf-8' }, body, cancel };
  } catch (error) {
    if (!committed && !combinedSignal.aborted && error?.statusCode !== 504 &&
        error?.code !== 'RUSTYX_INVALID_ROOT_LAYOUT' && !isDynamicBailout(error) && (!navigationResponse(error) || (route.parallel && navigationResponse(error).status === 404))) {
      try {
        // Next emits an empty document after a shell failure. The original
        // Flight stream still carries the failing subtree to client boundaries;
        // never rerun a GET just to render an error UI on the server.
        const shell = await renderAppRecoveryShell(model?.head, { signal: combinedSignal, timeoutMs });
        const end = shell.lastIndexOf('</body>');
        const bootstrap = `<script${nonceAttribute}>self.__RUSTYX_FLIGHT_STREAM__=self.__RUSTYX_FLIGHT_STREAM__||[];</script>` +
          (route.client ? `<script type="module" async${nonceAttribute} src="${escapeHtml(route.client)}"></script>` : '');
        const prefix = shell.slice(0, end) + bootstrap;
        const closing = shell.slice(end);
        tap.startOutput();
        const body = (async function* () {
          let total = 0;
          const encode = value => {
            const bytes = Buffer.from(value);
            total += bytes.byteLength;
            if (total > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB Rustyx limit');
            return bytes;
          };
          try {
            yield encode(prefix);
            for (;;) {
              combinedSignal.throwIfAborted();
              const next = await tap.next();
              if (next.done) break;
              const encoded = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength).toString('base64');
              yield encode(`<script${nonceAttribute}>(self.__RUSTYX_FLIGHT_STREAM__||=[]).push("${encoded}");document.currentScript.remove()</script>`);
            }
            yield encode(`<script${nonceAttribute}>self.__RUSTYX_FLIGHT_STREAM__.push(null);document.currentScript.remove()</script>` + closing);
          } finally { await cancel(); }
        })();
        return { status: route.parallel && navigationResponse(error)?.status === 404 ? 404 : 500, headers: { ...responseHeaders, ...result.headers, 'content-type': 'text/html; charset=utf-8' }, body, cancel };
      } catch (recoveryError) {
        await cancel(recoveryError);
        throw combinedSignal.reason?.statusCode === 504 ? combinedSignal.reason : recoveryError;
      }
    }
    combinedSignal.removeEventListener('abort', onAbort);
    await cancel(error);
    if (combinedSignal.reason?.statusCode === 504) throw combinedSignal.reason;
    throw error;
  }
}
