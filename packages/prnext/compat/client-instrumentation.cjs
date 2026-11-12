'use strict';
const key = Symbol.for('prnext.client-instrumentation');
function registerClientInstrumentation(hooks) {
  globalThis[key] = hooks.filter(hook => typeof hook?.onRouterTransitionStart === 'function');
}
function notifyRouterTransition(url, type, event = null) {
  for (const hook of globalThis[key] || []) {
    try {
      const result = hook.onRouterTransitionStart(url, type, event);
      result?.catch?.(error => console.error('[prnext] client instrumentation failed:', error));
    } catch (error) { console.error('[prnext] client instrumentation failed:', error); }
  }
}
module.exports = { registerClientInstrumentation, notifyRouterTransition };
