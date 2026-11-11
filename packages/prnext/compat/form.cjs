'use client';
'use strict';
const React = require('react');
const { AppRouterContext } = require('./app-context.cjs');
const { RouterContext } = require('./router.cjs');
const { addBasePath, hasBasePath } = require('./paths.cjs');

// FormData and the native submit event retain keyboard, constraint-validation,
// successful-control and Server Action semantics. Only same-origin GETs route.
const Form = React.forwardRef(function Form({ action, replace, scroll, prefetch, onSubmit, children, method, encType, target, ...props }, ref) {
  const app = React.useContext(AppRouterContext);
  const pages = React.useContext(RouterContext);
  const element = React.useRef(null);
  const setRef = React.useCallback(node => { element.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; }, [ref]);
  const navigating = typeof action === 'string';
  if (action == null || (!navigating && typeof action !== 'function')) throw new TypeError('Form action must be a URL string or a function');
  const basePath = app?.basePath || pages?.basePath || '';
  const href = navigating ? addBasePath(action, basePath) : action;
  React.useEffect(() => {
    if (!navigating || !app?.router.partialPrefetch || prefetch === false || process.env.NODE_ENV !== 'production' || !element.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); app.router.prefetch(action, { priority: 'viewport', full: false }); }
    }, { rootMargin: '200px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [navigating, app, action, prefetch]);
  function submit(event) {
    onSubmit?.(event);
    if (!navigating || event.defaultPrevented || !(app || pages)) return;
    const submitter = event.nativeEvent?.submitter;
    if (submitter) {
      if (submitter.formTarget && submitter.formTarget.toLowerCase() !== '_self') return;
      if (submitter.formMethod && submitter.formMethod.toLowerCase() !== 'get') return;
      if (submitter.formEnctype && submitter.formEnctype !== 'application/x-www-form-urlencoded') return;
    }
    const override = submitter?.getAttribute('formaction');
    if (override && /^\s*javascript:/i.test(override)) return;
    const destination = new URL(override == null ? href : override, window.location.href);
    if (destination.origin !== window.location.origin || !['http:', 'https:'].includes(destination.protocol) || !hasBasePath(destination.pathname, basePath)) return;
    const data = submitter ? new FormData(event.currentTarget, submitter) : new FormData(event.currentTarget);
    destination.search = '';
    for (const [key, value] of data) destination.searchParams.append(key, typeof value === 'string' ? value : value.name);
    event.preventDefault();
    if (app) app.router[replace ? 'replace' : 'push'](destination.href, { scroll });
    else void pages[replace ? 'replace' : 'push'](destination.href, undefined, { scroll }).catch(error => console.error(error));
  }
  // Next Form reserves these props for its GET/action contract; button-level
  // overrides continue to use their native fallback above.
  return React.createElement('form', { ...props, action: href, ref: setRef, onSubmit: submit }, children);
});
module.exports = Form;
module.exports.default = Form;
