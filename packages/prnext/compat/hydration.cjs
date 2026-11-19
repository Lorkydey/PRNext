'use client';
'use strict';
const React = require('react');

const documents = new WeakMap();
const cancelKey = Symbol.for('prnext.cancel-deferred-interactions');
const noSubscribe = () => () => {};
const clientSnapshot = () => false;
const serverSnapshot = () => true;
const intentEvents = ['pointerover', 'pointerdown', 'focusin', 'keydown', 'click', 'submit'];
const maximumAutomaticImports = 2;
const maximumQueuedImports = 64;

function documentState(doc) {
  let state = documents.get(doc);
  if (state) return state;
  state = { gates: new Map(), warming: new Set(), waiting: new Map(), idleImport: undefined };
  state.intent = event => {
    let element = event.target?.closest ? event.target : event.target?.parentElement;
    let gate;
    while (element) {
      const marker = element.closest('[data-prnext-deferred]');
      if (!marker) break;
      gate = state.gates.get(marker.id);
      if (gate && !gate.hydrated) break;
      gate = undefined; element = marker.parentElement;
    }
    if (!gate || event.defaultPrevented) return;
    gate.activate();
    if (event.type !== 'click' && event.type !== 'submit') return;
    if (event.type === 'click' && (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) return;
    // The original activation never reaches an unhydrated handler or native
    // submit. Replay once after React has attached this boundary's handlers.
    event.preventDefault(); event.stopImmediatePropagation();
    if (gate.events.length >= 32) return;
    if (event.type === 'submit') {
      gate.events.push({ type: 'submit', target: event.target, submitter: event.submitter });
    } else {
      const pointer = typeof event.pointerType === 'string';
      gate.events.push({ type: 'click', target: event.target, pointer, init: { bubbles: true, cancelable: true, composed: true,
        button: event.button, buttons: event.buttons, detail: event.detail,
        clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
        ...(pointer ? { pointerType: event.pointerType, pointerId: event.pointerId, isPrimary: event.isPrimary } : {}) },
      });
    }
  };
  documents.set(doc, state);
  return state;
}

function observeIntent(gate, element) {
  const doc = element.ownerDocument, state = documentState(doc);
  if (!state.gates.size) for (const type of intentEvents) doc.addEventListener(type, state.intent, true);
  state.gates.set(element.id, gate);
  if (!state.cancel) {
    let dispatcher = globalThis[cancelKey];
    if (!dispatcher?.listeners) {
      const previous = dispatcher;
      dispatcher = () => {
        dispatcher.epoch = (dispatcher.epoch + 1) >>> 0;
        previous?.(); for (const listener of dispatcher.listeners) listener();
      };
      dispatcher.epoch = 0; dispatcher.listeners = new Set();
      globalThis[cancelKey] = dispatcher;
    }
    state.cancel = () => { for (const entry of state.gates.values()) entry.events.length = 0; };
    state.dispatcher = dispatcher;
    dispatcher.listeners.add(state.cancel);
  }
  return () => {
    if (state.gates.get(element.id) === gate) state.gates.delete(element.id);
    if (!state.gates.size) {
      for (const type of intentEvents) doc.removeEventListener(type, state.intent, true);
      state.dispatcher.listeners.delete(state.cancel);
      state.cancel = undefined;
    }
  };
}

function idle(win, callback, timeout) {
  if (win.requestIdleCallback) {
    const id = win.requestIdleCallback(callback, { timeout });
    return () => win.cancelIdleCallback(id);
  }
  const id = win.setTimeout(callback, 1);
  return () => win.clearTimeout(id);
}

function allowAutomaticImport(doc) {
  const connection = doc.defaultView?.navigator.connection;
  return doc.visibilityState !== 'hidden' && !connection?.saveData && !/^(?:slow-)?2g$/.test(connection?.effectiveType || '');
}

function scheduleAutomaticImport(doc, state) {
  if (state.idleImport !== undefined || !state.waiting.size || state.warming.size >= maximumAutomaticImports) return;
  const win = doc.defaultView;
  if (!win) { state.waiting.clear(); return; }
  state.idleImport = win.requestIdleCallback(() => {
    state.idleImport = undefined;
    if (!allowAutomaticImport(doc)) { state.waiting.clear(); return; }
    for (const [preload, gates] of state.waiting) {
      if (state.warming.size >= maximumAutomaticImports) break;
      state.waiting.delete(preload);
      if (![...gates].some(gate => !gate.open && gate.element?.isConnected)) continue;
      state.warming.add(preload);
      const finished = () => {
        state.warming.delete(preload);
        scheduleAutomaticImport(doc, state);
      };
      void preload().then(finished, finished);
    }
  });
}

function queueAutomaticImport(gate, doc, preload) {
  const win = doc.defaultView, state = documentState(doc);
  if (!win.requestIdleCallback || gate.open || !gate.element?.isConnected ||
      !allowAutomaticImport(doc) || state.warming.has(preload)) return;
  let gates = state.waiting.get(preload);
  if (!gates) {
    if (state.waiting.size >= maximumQueuedImports) return;
    state.waiting.set(preload, gates = new Set());
  }
  gates.add(gate);
  scheduleAutomaticImport(doc, state);
  return () => {
    gates.delete(gate);
    if (!gates.size && state.waiting.get(preload) === gates) state.waiting.delete(preload);
    if (!state.waiting.size && state.idleImport !== undefined) {
      win.cancelIdleCallback(state.idleImport);
      state.idleImport = undefined;
    }
  };
}

function prepare(gate, element, options, preload) {
  const win = element.ownerDocument.defaultView;
  gate.element = element;
  const cleanups = [observeIntent(gate, element)];
  const visible = callback => {
    if (!win.IntersectionObserver) { cleanups.push(idle(win, callback, options.idleTimeout)); return; }
    let observer;
    try {
      observer = new win.IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); callback(); }
      }, { rootMargin: options.rootMargin });
      observer.observe(element); cleanups.push(() => observer.disconnect());
    } catch { cleanups.push(idle(win, callback, options.idleTimeout)); }
  };
  if (options.when === 'visible') visible(gate.activate);
  if (options.when === 'idle') cleanups.push(idle(win, gate.activate, options.idleTimeout));
  const warm = () => { void preload().catch(() => {}); };
  if (options.prefetch === 'idle') cleanups.push(idle(win, warm, options.idleTimeout));
  if (options.prefetch === 'visible') visible(warm);
  if (options.prefetch === 'auto' && options.when === 'interaction') visible(() => {
    const cancel = queueAutomaticImport(gate, element.ownerDocument, preload);
    if (cancel) cleanups.push(cancel);
  });
  return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
}

function replay(gate) {
  const events = gate.events.splice(0);
  const dispatcher = globalThis[cancelKey], epoch = dispatcher?.epoch;
  queueMicrotask(() => {
    for (const event of events) {
      if (dispatcher?.epoch !== epoch) break;
      const target = event.target;
      if (!target?.isConnected || !gate.element?.contains(target)) continue;
      const win = target.ownerDocument.defaultView;
      if (event.type === 'submit') {
        const submitter = event.submitter;
        if (submitter && (!submitter.isConnected || submitter.form !== target)) continue;
        win.HTMLFormElement.prototype.requestSubmit.call(target, submitter ?? undefined);
      } else {
        const Event = event.pointer && win.PointerEvent || win.MouseEvent;
        target.dispatchEvent(new Event('click', event.init));
      }
    }
  });
}

function Ready({ gate, children }) {
  React.useLayoutEffect(() => {
    gate.hydrated = true;
    gate.cleanup?.(); gate.cleanup = undefined;
    gate.completed?.(); replay(gate);
  }, [gate]);
  return children;
}

function Gate({ gate, children }) {
  if (!gate.open) React.use(gate.promise);
  return React.createElement(Ready, { gate }, children);
}

/** Explicit SSR-preserving, initially deferred client component. */
function deferHydration(loader, input = {}) {
  const options = { when: 'visible', as: 'div', rootMargin: '400px', idleTimeout: 2000, prefetch: false, ...input };
  if (typeof loader !== 'function' || !['visible', 'idle', 'interaction'].includes(options.when) ||
      ![false, 'visible', 'idle', 'auto'].includes(options.prefetch) || !/^[a-z][a-z0-9-]*$/.test(options.as) ||
      typeof options.rootMargin !== 'string' || options.rootMargin.length > 128 ||
      !Number.isFinite(options.idleTimeout) || options.idleTimeout < 1 || options.idleTimeout > 60_000) throw new TypeError('Invalid deferred hydration options');
  let loading;
  const preload = () => {
    if (loading) return loading;
    const pending = loading = Promise.resolve().then(loader);
    // A failed speculative load must not poison an unopened boundary. Once
    // React subscribes, its normal error boundary still owns render failures.
    void pending.catch(() => { if (loading === pending) loading = undefined; });
    return pending;
  };
  const Lazy = React.lazy(preload);
  const Deferred = React.memo(function Deferred(props) {
    const initial = React.useSyncExternalStore(noSubscribe, clientSnapshot, serverSnapshot);
    const deferredProps = React.useDeferredValue(props);
    const id = 'prnext-deferred-' + React.useId();
    const element = React.useRef(null);
    const [requested, setRequested] = React.useState(false);
    const [completed, setCompleted] = React.useState(false);
    const [gate] = React.useState(() => {
      let resolve;
      const value = { open: !initial || typeof window === 'undefined', hydrated: false, props, events: [],
        promise: new Promise(done => { resolve = done; }), activate(notify = true) {
          if (value.open) return;
          value.open = true; resolve();
          void preload().catch(() => {});
          if (notify) value.requested?.();
        } };
      return value;
    });
    // Updated data must not stay frozen behind an offscreen hydration strategy.
    // Drop queued intent from the old props before applying a new snapshot.
    if (gate.props !== props) { gate.props = props; gate.events.length = 0; gate.activate(false); }
    const childProps = gate.hydrated ? props : deferredProps;
    const content = React.useMemo(() => React.createElement(React.Suspense, { fallback: options.fallback ?? null },
      React.createElement(Gate, { gate }, React.createElement(Lazy, childProps))), [gate, childProps]);
    React.useLayoutEffect(() => {
      gate.requested = () => setRequested(true);
      gate.completed = () => setCompleted(true);
      if (!gate.open && element.current) gate.cleanup = prepare(gate, element.current, options, preload);
      return () => {
        gate.cleanup?.(); gate.cleanup = undefined;
        gate.element = undefined;
        gate.events.length = 0; gate.requested = gate.completed = undefined;
      };
    }, [gate]);
    return React.createElement(options.as, { id, ref: element, 'data-prnext-deferred': options.when,
      'aria-busy': requested && !completed ? true : undefined }, content);
  });
  Deferred.displayName = 'DeferredHydration';
  Deferred.preload = preload;
  return Deferred;
}

module.exports = { deferHydration };
