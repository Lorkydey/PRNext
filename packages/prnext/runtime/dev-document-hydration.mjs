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

// ColorZilla adds this keyboard-listener marker before React starts. Temporarily
// remove that known, extension-only difference, then return its original value
// after the first commit. Application-owned props and other mismatches stay intact.
export function prepareDevDocumentHydration(tree, document) {
  const marker = 'cz-shortcut-listen';
  const props = documentBodyProps(tree), body = document?.body;
  if (!props || Object.hasOwn(props, marker) || body?.getAttribute(marker) !== 'true') return;
  const value = body.getAttribute(marker);
  body.removeAttribute(marker);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (document.body === body && !body.hasAttribute(marker)) body.setAttribute(marker, value);
  };
}
