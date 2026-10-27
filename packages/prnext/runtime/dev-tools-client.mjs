import { safeRequestPath, normalizeEntries } from './dev-tools-model.mjs';

// The development-only sidecar is bound to loopback and authenticated with an
// ephemeral session capability. Diagnostics stay local by default; the explicit
// Host AI relay shares tool responses only when the connected assistant asks.
export function createDevToolsClient({ capture, snapshot = () => ({}), config, target = globalThis } = {}) {
  const nativeFetch = target.fetch?.bind(target), subscribers = new Set();
  const clientId = target.crypto?.randomUUID?.() || 'browser-' + Math.random().toString(36).slice(2);
  const valid = config?.version === 1 && typeof config.token === 'string' && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(config.endpoint || '');
  let disposed = false, data = {}, connection = valid ? 'connecting' : 'unavailable', polling = 0, pollTimer, pollingRequest;
  let requests = [], serial = 0, logSerial = 0, reportTimer, lastSummary, lastContext, lastError;
  let browserInFlight = 0; const browserQueue = [];
  const pending = new Map(), originals = [], localEvents = new AbortController();
  const base = () => target.location?.href || 'http://localhost/';
  const state = () => ({ ...data, connection, available: valid, clientId, localRequests: requests.slice(), context: lastContext, error: lastError || data.error });
  function notify() { for (const subscriber of subscribers) { try { subscriber(state()); } catch {} } }
  async function request(path, body, timeout = 8000) {
    if (!valid || disposed || !nativeFetch) throw Error('The local development tools are unavailable. Restart PRNext dev.');
    const controller = new AbortController(); const timer = target.setTimeout(() => controller.abort(), timeout); pending.set(controller,timer);
    try {
      const response = await nativeFetch(config.endpoint + path, { method: 'POST', mode: 'cors', cache: 'no-store', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json(); if (!response.ok) {const error=Error(result?.error?.message || result?.error || 'Local tools request failed (' + response.status + ').');error.status=response.status;error.code=result?.code;throw error;}
      connection = 'connected'; lastError = undefined; return result;
    } catch (error) { if (!disposed) { connection = error.status&&![401,403].includes(error.status)?'connected':'disconnected'; lastError = error.name === 'AbortError' ? 'Local tools request timed out.' : error.message; } throw error; }
    finally { target.clearTimeout(timer); pending.delete(controller); }
  }
  async function call(name, args = {}) {
    try { return await request('/v1/tools/' + encodeURIComponent(name), args, name === 'dev_verify' ? 35000 : 10000); }
    finally { notify(); }
  }
  async function refresh() {
    if (!valid || disposed) return state();
    if (pollingRequest) return pollingRequest;
    pollingRequest = call('dev_snapshot').then(result => { data = result; notify(); return state(); }).catch(() => state()).finally(() => { pollingRequest = undefined; });
    return pollingRequest;
  }
  function browser(kind, extras = {}) {
    if (!valid || disposed) return Promise.resolve();
    const info = snapshot();
    const body = { session: config.session, clientId, buildId: info.buildId ?? null, sequence: info.sequence || 0,
      path: target.location?.pathname || '/', issues: info.issues || 0, typeErrors: info.typeErrors || 0, building: Boolean(info.building),
      confirmed: info.confirmed === true, hydrated: info.confirmed === true, kind, ...extras };
    return new Promise(resolve => {
      if (browserQueue.length >= 100) browserQueue.shift().resolve();
      browserQueue.push({ body, resolve }); pumpBrowser();
    });
  }
  function pumpBrowser() {
    while (!disposed && browserInFlight < 2 && browserQueue.length) {
      const job = browserQueue.shift(); browserInFlight++;
      void request('/v1/browser', job.body).catch(() => {}).finally(() => { browserInFlight--;job.resolve();pumpBrowser(); });
    }
  }
  function report() {
    if (disposed) return;
    const entries = capture?.snapshot().entries || [];
    const brief = text => text.length > 8000 ? text.slice(0, 7900) + '\n[Truncated for the local AI bridge; full message remains in the browser console.]' : text;
    const unsent = entries.filter(entry => entry.id > logSerial);
    const fresh = unsent.slice(-20).map(entry => ({ ...entry, text: brief(entry.text) }));
    if (fresh.length) logSerial = fresh.at(-1).id;
    const info = snapshot(), summary = [info.buildId, info.sequence, info.issues, info.typeErrors, info.building, info.confirmed].join(':');
    const errors = entries.filter(entry => entry.level === 'error').slice(-10).map(entry => ({ id: entry.id, text: brief(entry.text), time: entry.time }));
    void browser(summary !== lastSummary && !info.building && info.confirmed === true ? 'applied' : info.issues || errors.length ? 'errors' : 'heartbeat', {
      logs: fresh, droppedLogs: Math.max(0, unsent.length - 20) + (capture?.snapshot().dropped || 0), errors, issues: info.issues || 0, typeErrors: info.typeErrors || 0, building: Boolean(info.building),
      visibility: target.document?.visibilityState || 'visible', hydrated: info.confirmed === true, confirmed: info.confirmed === true,
    }); lastSummary = summary;
  }
  function scheduleReport() { if (!reportTimer && valid) reportTimer = target.setTimeout(() => { reportTimer = undefined; report(); }, 300); }
  function recordRequest(entry) {
    if (disposed) return;
    const record = { ...entry, id: ++serial, source: 'browser' };
    requests.push(record); if (requests.length > 300) requests.shift();
    void browser('request', { request: record }); notify();
  }
  function ignored(url) {
    return valid && url.origin === config.endpoint || /\/_prnext\/(?:dev|ensure|assets)\b/.test(url.pathname);
  }
  if (nativeFetch) {
    const original = target.fetch;
    const replacement = function (...args) {
      let url, method = 'GET';
      try { url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0].url, base()); method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase(); } catch {}
      const started = target.performance?.now?.() ?? Date.now(), time = Date.now();
      return Reflect.apply(original, target, args).then(response => {
        if (url && !ignored(url)) recordRequest({ method, path: safeRequestPath(url.href, base()), status: response.status, time,
          duration: Math.max(0, (target.performance?.now?.() ?? Date.now()) - started), kind: 'fetch', failed: !response.ok });
        return response;
      }, error => {
        if (url && !ignored(url)) recordRequest({ method, path: safeRequestPath(url.href, base()), status: null, time,
          duration: Math.max(0, (target.performance?.now?.() ?? Date.now()) - started), kind: 'fetch', failed: true, error: error.name === 'AbortError' ? 'Aborted' : 'Network error' });
        throw error;
      });
    };
    try { target.fetch = replacement; originals.push(() => { if (target.fetch === replacement) target.fetch = original; }); } catch {}
  }
  const xhr = target.XMLHttpRequest?.prototype;
  if (xhr) {
    const open = xhr.open, send = xhr.send, records = new WeakMap();
    const wrappedOpen = function (method, raw, ...args) { const result = Reflect.apply(open, this, [method, raw, ...args]); records.delete(this);try { const url = new URL(raw, base()); if (!ignored(url)) records.set(this, { method: String(method).toUpperCase(), path: safeRequestPath(url.href, base()), kind: 'xhr' }); } catch {} return result; };
    const wrappedSend = function (...args) {
      const entry = records.get(this); if (entry) { const start = target.performance?.now?.() ?? Date.now(), time = Date.now();
        this.addEventListener('loadend', () => { recordRequest({ ...entry, time, status: this.status || null, failed: this.status === 0 || this.status >= 400,
          duration: Math.max(0, (target.performance?.now?.() ?? Date.now()) - start) }); }, { once: true }); }
      return Reflect.apply(send, this, args);
    };
    try { xhr.open = wrappedOpen; xhr.send = wrappedSend; originals.push(() => { if (xhr.open === wrappedOpen) xhr.open = open; if (xhr.send === wrappedSend) xhr.send = send; }); } catch {}
  }
  const unsubscribe = capture?.subscribe(() => { scheduleReport(); notify(); });
  target.addEventListener?.('prnext:refresh', scheduleReport, { signal: localEvents.signal });
  target.addEventListener?.('prnext:devtools:ready', scheduleReport, { signal: localEvents.signal });
  target.addEventListener?.('popstate', scheduleReport, { signal: localEvents.signal });
  target.addEventListener?.('prnext:devtools:ai', event => {
    const detail = event.detail || {};
    lastContext = detail.kind === 'error' ? { ...detail, text: detail.error?.message || String(detail.error || ''),
      source: detail.source?.file ? `${detail.source.file}:${detail.source.line}:${detail.source.column}` : detail.source,
      mappedSource: detail.source?.file ? detail.source : undefined,
    } : detail;
    notify(); target.dispatchEvent(new CustomEvent('prnext:devtools:context', { detail: lastContext }));
  }, { signal: localEvents.signal });
  const heartbeat = valid ? target.setInterval(report, 5000) : undefined;
  if (valid) scheduleReport();
  function watch() {
    polling++; void refresh();
    if (!pollTimer) pollTimer = target.setInterval(() => void refresh(), 1500);
    let watching=true;
    return () => { if(!watching)return;watching=false;if (--polling <= 0) { polling = 0; target.clearInterval(pollTimer); pollTimer = undefined; } };
  }
  function captureFor(store = capture) {
    let clearedAt = 0;
    return {
      snapshot() { const captured = store?.snapshot() || { entries: [], dropped: 0 }; return { entries: normalizeEntries({ ...data, serverLogs: (data.serverLogs || []).filter(entry => (entry.time || entry.timestamp || 0) > clearedAt) }, captured.entries), dropped: captured.dropped }; },
      subscribe(callback) { subscribers.add(callback); const stop = watch(), stopCapture = store !== capture ? store?.subscribe(callback) : undefined; return () => { subscribers.delete(callback); stop(); stopCapture?.(); }; },
      clear() { store?.clear(); clearedAt = Date.now(); notify(); },
    };
  }
  const unified = captureFor();
  return {
    call, refresh, snapshot: state, subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); }, watch,
    consoleCapture: unified, captureFor, localCapture: capture, browser, report, endpoint: config?.endpoint,
    setContext(context) { lastContext = context; notify(); },
    async sendContext(context, prompt) {
      const submitted=lastContext;
      const latest=await refresh();
      if(latest.connection!=='connected'||latest.ai?.connected!==true)throw Error('Connect your assistant before sending a request.');
      let result;
      try{result=await call('dev_ai_context', { kind: context.kind || 'selection', context, prompt });}
      catch(error){if(error.code==='assistant_required'){data={...data,ai:{...data.ai,connected:false}};notify();}throw error;}
      if(result.queued!==true||result.connected!==true){if(result.connected!==true){data={...data,ai:{...data.ai,connected:false}};notify();}throw Error('Your assistant is no longer connected. Reconnect and try again.');}
      if(lastContext===submitted)lastContext = { ...context, sent: true }; notify(); return result;
    },
    dispose() { disposed = true; unsubscribe?.(); localEvents.abort(); target.clearInterval(heartbeat); target.clearInterval(pollTimer); target.clearTimeout(reportTimer);
      for (const job of browserQueue.splice(0)) job.resolve();for (const [controller,timer] of pending) { controller.abort();target.clearTimeout(timer); } pending.clear();for (const restore of originals.reverse()) restore(); subscribers.clear(); requests = []; },
  };
}
