import React from 'react';
import { LayoutCacheContext } from '../compat/app-layout-context.cjs';

// Preserve the same sibling positions during SSR, PPR and hydration. Even an
// empty style slot changes React's useId tree encoding when it is omitted.
export function appContent(tree, { layoutCache = null, styles = null } = {}) {
  return React.createElement(LayoutCacheContext.Provider, { value: layoutCache }, tree, styles);
}
