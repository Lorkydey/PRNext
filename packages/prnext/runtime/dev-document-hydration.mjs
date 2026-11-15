import { isValidElement } from 'react';

// Read already-resolved server elements only. Do not execute client components,
// unwrap React internals or walk an unbounded application tree before hydration.
function documentBodyProps(tree) {
  let remaining = 128;
  const seen = new WeakSet();
  function visit(value, depth = 0) {
    if (--remaining < 0 || depth > 32 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) {
        const props = visit(child, depth + 1);
        if (props) return props;
        if (remaining <= 0) break;
      }
    } else if (isValidElement(value)) {
      if (value.type === 'body') return value.props;
      return visit(value.props.children, depth + 1);
    }
  }
  return visit(tree);
}

// Extensions can add or reinsert this marker after hydrateRoot schedules work.
// Keep only that unowned attribute normalized until the first commit, then
// disconnect and return its value. Other application differences stay intact.
export function prepareDevDocumentHydration(tree, document) {
  const marker = 'cz-shortcut-listen';
  const props = documentBodyProps(tree), body = document?.body;
  if (!props || Object.hasOwn(props, marker) || !body) return;
  let value, observer, normalizations = 0;
  const normalize = () => {
    if (document.body === body && body.getAttribute(marker) === 'true') {
      // Do not starve React if another observer continuously fights this one.
      if (++normalizations > 16) { observer?.disconnect(); return; }
      value = body.getAttribute(marker);
      body.removeAttribute(marker);
    }
  };
  const Observer = document.defaultView?.MutationObserver;
  observer = typeof Observer === 'function' ? new Observer(normalize) : undefined;
  observer?.observe(body, { attributes: true, attributeFilter: [marker] });
  normalize();
  if (!observer && value === undefined) return;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    observer?.disconnect();
    if (value !== undefined && document.body === body && !body.hasAttribute(marker)) body.setAttribute(marker, value);
  };
}
