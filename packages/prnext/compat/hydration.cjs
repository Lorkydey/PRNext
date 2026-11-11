'use client';
'use strict';
const React = require('react');

const documents = new WeakMap();
const cancelKey = Symbol.for('prnext.cancel-deferred-interactions');
const noSubscribe = () => () => {};
const clientSnapshot = () => false;
const serverSnapshot = () => true;
const intentEvents = ['pointerover', 'pointerdown', 'focusin', 'keydown', 'click', 'submit'];

function documentState(doc) {
  let state = documents.get(doc);
  if (state) return state;
  state = { gates: new Map() };
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
    gate.events.push(event.type === 'submit' ? { type: 'submit', target: event.target, submitter: event.submitter } : {
      type: 'click', target: event.target, init: { bubbles: true, cancelable: true, composed: true,
        button: event.button, buttons: event.buttons, detail: event.detail,
        clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY },
    });
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

function prepare(gate, element, options, preload) {
  const win = element.ownerDocument.defaultView;
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
  return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
}

function replay(gate) {
  const events = gate.events.splice(0);
  const dispatcher = globalThis[cancelKey], epoch = dispatcher?.epoch;
  queueMicrotask(() => {
    for (const event of events) {
      if (dispatcher?.epoch !== epoch) break;
      const target = event.target;
      if (!target?.isConnected) continue;
      const win = target.ownerDocument.defaultView;
      if (event.type === 'submit') {
        const submitter = event.submitter?.isConnected ? event.submitter : undefined;
        win.HTMLFormElement.prototype.requestSubmit.call(target, submitter);
      } else target.dispatchEvent(new win.MouseEvent('click', event.init));
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
      ![false, 'visible', 'idle'].includes(options.prefetch) || !/^[a-z][a-z0-9-]*$/.test(options.as) ||
      typeof options.rootMargin !== 'string' || options.rootMargin.length > 128 ||
      !Number.isFinite(options.idleTimeout) || options.idleTimeout < 1 || options.idleTimeout > 60_000) throw new TypeError('Invalid deferred hydration options');
  let loading;
  const preload = () => loading ||= Promise.resolve().then(loader);
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
