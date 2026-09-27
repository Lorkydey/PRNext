'use client';
'use strict';
const React = require('react');
const { formatUrl, RouterContext } = require('./router.cjs');
const { AppRouterContext } = require('./app-context.cjs');
const { addBasePath, hasBasePath, normalizeTrailingSlash } = require('./paths.cjs');
const { localizedHref } = require('./locale.cjs');

const Link = React.forwardRef(function Link({ href, as, children, replace, scroll, shallow, prefetch,
  locale, legacyBehavior, passHref, onClick, onNavigate, onMouseEnter, onTouchStart, ...props }, ref) {
  const app = React.useContext(AppRouterContext);
  const pages = React.useContext(RouterContext);
  const anchorRef = React.useRef(null);
  const setRef = React.useCallback(node => { anchorRef.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; }, [ref]);
  const target = localizedHref(formatUrl(as || href), pages, locale);
  const basePath = app?.basePath || pages?.basePath || '';
  const policy = app || pages || {};
  const mounted = basePath && /^\/(?:[?#]|$)/.test(target) && !policy.trailingSlash && !policy.skipTrailingSlashRedirect ? `${basePath}${target.slice(1)}`
    : target.startsWith('//') ? target : addBasePath(target, basePath);
  const publicTarget = normalizeTrailingSlash(mounted, policy);
  const source = formatUrl(href);
  const requestPrefetch = React.useCallback(() => {
    if (app?.router.partialPrefetch && prefetch !== false && process.env.NODE_ENV === 'production') app.router.prefetch(target);
    if (!app && pages && process.env.NODE_ENV === 'production') void pages.prefetch(source, as ? target : undefined, {locale}).catch(() => {});
  }, [app, pages, source, target, as, prefetch]);
  React.useEffect(() => {
    if ((app ? !app.router.partialPrefetch : !pages) || prefetch === false || process.env.NODE_ENV !== 'production' || typeof IntersectionObserver === 'undefined' || !anchorRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); requestPrefetch(); }
    }, { rootMargin: '200px' });
    observer.observe(anchorRef.current);
    return () => observer.disconnect();
  }, [app, pages, prefetch, requestPrefetch]);
  if (/^[\s\u0000-\u001f]*javascript:/i.test(target.replace(/[\r\n\t]/g, ''))) {
    throw new Error('Link does not permit javascript: URLs');
  }
  function click(event) {
    onClick?.(event);
    const anchor = event.currentTarget;
    const anchorTarget = anchor?.getAttribute('target') || props.target;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        (anchorTarget && anchorTarget.toLowerCase() !== '_self') || anchor?.hasAttribute('download') || props.download !== undefined) return;
    const destination = new URL(publicTarget, window.location.href);
    if (destination.origin !== window.location.origin || !hasBasePath(destination.pathname, basePath) || !['http:', 'https:'].includes(destination.protocol)) return;
    let prevented = false;
    onNavigate?.({ preventDefault() { prevented = true; event.preventDefault(); } });
    if (prevented) return;
    if (app) {
      event.preventDefault();
      app.router[replace ? 'replace' : 'push'](target, { scroll });
    } else if (pages) {
      event.preventDefault();
      void pages[replace ? 'replace' : 'push'](href, as, { scroll, shallow, locale }).catch(error => console.error(error));
    } else if (replace) { event.preventDefault(); window.location.replace(publicTarget); }
  }
  function hover(event) { onMouseEnter?.(event); requestPrefetch(); }
  function touch(event) { onTouchStart?.(event); requestPrefetch(); }
  if (legacyBehavior) {
    const child = React.Children.only(children);
    return React.cloneElement(child, { ...props, href: publicTarget, ref: setRef,
      onMouseEnter(event) { child.props.onMouseEnter?.(event); hover(event); },
      onTouchStart(event) { child.props.onTouchStart?.(event); touch(event); },
      onClick(event) { child.props.onClick?.(event); if (!event.defaultPrevented) click(event); } });
  }
  return React.createElement('a', { ...props, href: publicTarget, ref: setRef, onClick: click, onMouseEnter: hover, onTouchStart: touch }, children);
});
module.exports = Link;
module.exports.default = Link;
