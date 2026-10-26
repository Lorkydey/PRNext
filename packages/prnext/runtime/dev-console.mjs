// Browser-only diagnostics. Records stay in this window, never sent to PRNext.
// Bound both retained entries and formatting work; do not invoke object getters.
const LIMIT = 500, TEXT_LIMIT = 128_000, TEXT_BUDGET = 2 * 1024 * 1024;
const clip = text => text.length > TEXT_LIMIT ? text.slice(0,TEXT_LIMIT) + '\n[Message truncated at 128000 characters]' : text;
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
export function formatConsoleValue(value, depth = 0, seen = new WeakSet()) {
  try {
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'function') return '[Function]';
    if (value === null || typeof value !== 'object') return clip(String(value));
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value instanceof Error) {
      // Custom error properties can also be getters. Do not evaluate them.
      const stack = Object.getOwnPropertyDescriptor(value, 'stack'), message = Object.getOwnPropertyDescriptor(value, 'message');
      // V8 exposes its lazy stack as a shared native getter. Permit that getter,
      // but never a custom accessor installed on a logged error object.
      const nativeStack = nativeStackGetter && stack?.get === nativeStackGetter ? Reflect.apply(nativeStackGetter, value, []) : undefined;
      const text = typeof nativeStack === 'string' ? nativeStack : stack && 'value' in stack && typeof stack.value === 'string' ? stack.value : message && 'value' in message && typeof message.value === 'string' ? message.value : '[Error]';
      return clip(text);
    }
    if (depth >= 3) return Array.isArray(value) ? '[Array]' : '[Object]';
    const keys = Object.keys(value), parts = [];
    let remaining = TEXT_LIMIT;
    for (const key of keys.slice(0, 20)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const text = descriptor && 'value' in descriptor ? formatConsoleValue(descriptor.value, depth + 1, seen) : '[Getter]';
      const part = (Array.isArray(value) ? '' : key.slice(0, 100) + ': ') + text;
      parts.push(part.slice(0, remaining)); remaining -= part.length;
      if (remaining <= 0) break;
    }
    if (keys.length > parts.length) parts.push('…');
    return clip(Array.isArray(value) ? '[' + parts.join(', ') + ']' : '{' + parts.join(', ') + '}');
  } catch { return '[Unavailable]'; }
}

function formatArguments(args) {
  const values = args.slice(0, 20);
  if (typeof values[0] !== 'string') return clip(values.map(value => formatConsoleValue(value)).join(' '));
  let index = 1;
  const message = clip(values[0]).replace(/%[%sdifoOc]/g, token => {
    if (token === '%%') return '%';
    if (index >= values.length) return token;
    const value = values[index++];
    if (token === '%c') return '';
    // Never coerce user objects through custom toString/valueOf methods.
    if (/^%[dif]$/.test(token) && (typeof value === 'string' || typeof value === 'number')) return String(token === '%f' ? parseFloat(value) : parseInt(value, 10));
    return formatConsoleValue(value);
  });
  return clip([message, ...values.slice(index).map(value => formatConsoleValue(value))].join(' '));
}

export function createConsoleCapture(target = globalThis) {
  const entries = [], subscribers = new Set(), replacements = [];
  let serial = 0, busy = false, scheduled = false, disposed = false, dropped = 0, retainedChars = 0;
  function notify() {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) for (const subscriber of subscribers) { try { subscriber(); } catch {} }
    });
  }
  function record(level, args) {
    if (busy || disposed) return;
    busy = true;
    try {
      const text=formatArguments(args);entries.push({id:++serial,time:Date.now(),level,text});retainedChars+=text.length;
      while(entries.length>LIMIT||retainedChars>TEXT_BUDGET){retainedChars-=entries.shift().text.length;dropped++;}
      notify();
    } catch {} finally { busy = false; }
  }
  function clear() { entries.length = 0; dropped = 0;retainedChars=0;notify(); }
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'table', 'trace', 'assert', 'clear']) {
    const original = target.console?.[method];
    if (typeof original !== 'function') continue;
    const replacement = function (...args) {
      // Keep the native console, return value and exception behavior intact.
      try { return Reflect.apply(original, target.console, args); }
      finally {
        if (method === 'clear') clear();
        else if (method === 'assert') { if (!args[0]) record('error', ['Assertion failed:', ...args.slice(1)]); }
        else record(method === 'table' || method === 'trace' ? 'log' : method, args);
      }
    };
    try { target.console[method] = replacement; replacements.push({method, original, replacement}); } catch {}
  }
  const onError = event => { if (event.error || event.message) record('error', [event.error || event.message]); };
  const onRejection = event => record('error', ['Unhandled rejection:', event.reason]);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return {
    snapshot: () => ({ entries: entries.slice(), dropped }), clear,
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    dispose() {
      disposed = true; subscribers.clear(); entries.length = 0;
      for (const {method, original, replacement} of replacements) if (target.console[method] === replacement) target.console[method] = original;
      target.removeEventListener('error', onError); target.removeEventListener('unhandledrejection', onRejection);
    },
  };
}

export function isDevicePreview() {
  try { return globalThis.frameElement?.getAttribute('data-prnext-preview') === 'true'; }
  catch { return false; }
}
