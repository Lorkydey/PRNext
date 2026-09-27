import Refresh from 'react-refresh/runtime';

const state = globalThis.__PRNEXT_DEV__ ||= {
  applications: new Map(), modules: new Map(), buildId: null, manifest: null,
  pending: null, applying: false, unsafe: false, queued: null, source: null,
};
if (!state.injected) { Refresh.injectIntoGlobalHook(globalThis); state.injected = true; }
export const register = (type, id) => Refresh.register(type, id);
export const signature = () => Refresh.createSignatureFunctionForTransform();
export function registerModule(id, hash, boundary) {
  const previous = state.modules.get(id);
  if (previous && previous.hash !== hash && (!previous.boundary || !boundary)) state.unsafe = true;
  state.modules.set(id, { hash, boundary });
}

function clearError() { document.getElementById('__prnext_dev_error__')?.remove(); state.overlayError = undefined; }
function errorKey(error) {
  return typeof error?.digest === 'string' ? `${error.digest.slice(0, 256)}:${String(error.message || '').slice(0, 512)}` : null;
}
function showError(error) {
  const key = errorKey(error);
  if (error && typeof error === 'object' && (state.dismissedErrors?.has(error) || (key && state.dismissedDigests?.has(key)))) return;
  state.overlayError = error;
  let host = document.getElementById('__prnext_dev_error__');
  if (!host) {
    host = document.createElement('div'); host.id = '__prnext_dev_error__';
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{color-scheme:dark}section{box-sizing:border-box;overflow:auto;height:100%;padding:32px;background:#17191fee;color:#f4f5f7;font:14px/1.6 ui-monospace,monospace}h1{font:600 22px system-ui;color:#ff7474}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{position:fixed;right:24px;top:24px;padding:8px 14px;border:1px solid #697080;border-radius:6px;background:#292e39;color:white;cursor:pointer}';
    const section = document.createElement('section'); section.setAttribute('role', 'alertdialog'); section.setAttribute('aria-label', 'PRNext development error');
    const heading = document.createElement('h1'); heading.textContent = 'PRNext — development error';
    const close = document.createElement('button'); close.textContent = 'Dismiss'; close.onclick = () => {
      // React may report the same failed model again while its boundary retries.
      // Closing that diagnostic must not block the recovered application.
      if (state.overlayError && typeof state.overlayError === 'object') (state.dismissedErrors ||= new WeakSet()).add(state.overlayError);
      const key = errorKey(state.overlayError);
      if (key) {
        const entries = state.dismissedDigests ||= new Set();
        if (entries.size >= 32) entries.delete(entries.values().next().value);
        entries.add(key);
      }
      clearError();
    };
    const details = document.createElement('pre'); details.id = 'details';
    section.append(heading, close, details); shadow.append(style, section); document.documentElement.append(host);
  }
  host.shadowRoot.getElementById('details').textContent = String(error?.stack || error?.message || error).slice(0, 48 * 1024);
}

async function updateStyles(urls) {
  const wanted = new Set(urls.map(url => new URL(url, location.href).href));
  const old = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => link.href.includes('/_prnext/assets/'));
  const existing = new Set(old.map(link => link.href));
  await Promise.all([...wanted].filter(href => !existing.has(href)).map(href => new Promise((resolve, reject) => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
    const timer = setTimeout(() => { link.remove(); reject(new Error('Stylesheet update timed out')); }, 15_000);
    link.onload = () => { clearTimeout(timer); resolve(); };
    link.onerror = () => { clearTimeout(timer); link.remove(); reject(new Error(`Could not load updated stylesheet ${href}`)); };
    document.head.append(link);
  })));
  for (const link of old) if (!wanted.has(link.href)) link.remove();
}

async function applyUpdate(message) {
  if (state.applying) { state.queued = message; return; }
  if (!message.clientManifest) { location.reload(); return; }
  const changed = message.changed || [];
  if (changed.some(file => /(?:^|\/)(?:(?:next|prnext)\.config\.|package(?:-lock)?\.json|\.env|pages\/_document\.)/.test(file))) { location.reload(); return; }
  state.applying = true; state.unsafe = false; state.pending = null;
  state.dismissedErrors = new WeakSet();
  state.dismissedDigests = new Set();
  try {
    const response = await fetch(message.clientManifest, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Development manifest failed (${response.status})`);
    const manifest = await response.json();
    if (manifest.buildId !== message.buildId) throw new Error('Development build changed during refresh');
    const kind = state.currentKind;
    const application = await state.applications.get(kind);
    const route = kind === 'pages' ? manifest.pages.find(route => route.pattern === application.router.snapshot().pathname) : null;
    const entry = kind === 'pages' ? route?.client : manifest.app?.client;
    if (!entry) { location.reload(); return; }
    await import(/* webpackIgnore: true */ entry);
    const pending = state.pending;
    if (pending) await application.devPrepare?.(pending.options);
    if (state.unsafe) { location.reload(); return; }
    await updateStyles(kind === 'pages' ? route.css : manifest.app.css);
    clearError();
    Refresh.performReactRefresh();
    if (pending) await application.devCommit?.(pending.options);
    state.buildId = message.buildId;
    state.manifest = manifest;
    document.documentElement.dataset.prnextDevBuild = message.buildId;
    globalThis.dispatchEvent(new CustomEvent('prnext:refresh', { detail: { buildId: message.buildId } }));
  } catch (error) { showError(error); }
  finally {
    state.applying = false; state.pending = null;
    if (state.queued) { const queued = state.queued; state.queued = null; if (queued.buildId !== state.buildId) void applyUpdate(queued); }
  }
}

function connect(options) {
  if (state.source) return;
  state.buildId = options.dev.buildId;
  const source = new EventSource(`${options.basePath || ''}/_prnext/dev`);
  state.source = source;
  source.onmessage = event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.state === 'error') { showError(message.error || 'Build failed'); return; }
    if (message.state !== 'ready') return;
    if (message.buildId === state.buildId) return;
    void applyUpdate(message);
  };
  globalThis.addEventListener('error', event => { if (event.error) showError(event.error); });
  globalThis.addEventListener('unhandledrejection', event => showError(event.reason));
  globalThis.addEventListener('pagehide', () => source.close(), { once: true });
}

state.reportError = showError;
state.bootstrap = (kind, options, start) => {
  state.currentKind = kind;
  if (!state.applications.has(kind)) {
    const application = Promise.resolve().then(start);
    state.applications.set(kind, application);
    connect(options);
    application.catch(showError);
  } else if (state.applying) state.pending = { kind, options };
  return state.applications.get(kind);
};
