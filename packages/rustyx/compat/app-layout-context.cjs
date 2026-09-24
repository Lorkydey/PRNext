'use client';
'use strict';
const React = require('react');
const LayoutContext = React.createContext({ children: [] });
const LayoutCacheContext = React.createContext(null);

function LayoutProvider({ id, segments, children }) {
  const cache = React.useContext(LayoutCacheContext);
  const previous = React.useRef({});
  const current = {};
  for (const [slot, value] of Object.entries(segments || {})) current[slot] = value === null ? cache?.segments[id]?.[slot] || previous.current[slot] || [] : value;
  React.useLayoutEffect(() => { previous.current = current; if (cache && id) cache.segments[id] = current; });
  return React.createElement(LayoutContext.Provider, { value: current }, children);
}

function LayoutSlot({ id, preserve, children }) {
  const cache = React.useContext(LayoutCacheContext);
  const previous = React.useRef(children);
  const current = preserve && cache && Object.hasOwn(cache.slots, id) ? cache.slots[id] : preserve ? previous.current : children;
  React.useLayoutEffect(() => { previous.current = current; if (cache && id) cache.slots[id] = current; }, [cache, id, current]);
  return current ?? null;
}

module.exports.LayoutContext = LayoutContext;
module.exports.LayoutCacheContext = LayoutCacheContext;
module.exports.LayoutProvider = LayoutProvider;
module.exports.LayoutSlot = LayoutSlot;
