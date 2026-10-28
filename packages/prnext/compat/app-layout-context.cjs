'use client';
'use strict';
const React = require('react');
const { AppRouterContext } = require('./app-context.cjs');
const LayoutContext = React.createContext({ children: [] });
const LayoutCacheContext = React.createContext(null);
const ActivityCacheContext = React.createContext(null);

function ActivitySlot({ identity, children, authorizationKey }) {
  const retention = React.useContext(ActivityCacheContext);
  authorizationKey ??= retention?.authorizationKey;
  const router = React.useContext(AppRouterContext);
  const epoch = retention?.epoch ?? 0;
  const authorizationEpoch = retention?.authorizationEpoch ?? 0;
  const registrations = React.useRef(new Set());
  const serial = React.useRef(0);
  const [saved, setSaved] = React.useState(() => ({ epoch, authorizationEpoch, active: identity, entries: new Map() }));
  let entries = saved.entries;
  const current = entries.get(identity);
  if (saved.epoch !== epoch || saved.authorizationEpoch !== authorizationEpoch || current?.children !== children || current?.router !== router || current?.authorizationKey !== authorizationKey) {
    const sameAuthorization = saved.authorizationEpoch === authorizationEpoch && !(current?.authorizationKey && authorizationKey && current.authorizationKey !== authorizationKey);
    entries = saved.epoch === epoch && sameAuthorization ? new Map(entries) : new Map();
    const preserve = current && saved.authorizationEpoch === authorizationEpoch && (sameAuthorization && (saved.epoch === epoch || saved.active === identity)
      || !retention?.strictAuthorization && saved.active === identity);
    entries.set(identity, { children, router, authorizationKey, token: preserve ? current.token : {}, reactKey: preserve ? current.reactKey : ++serial.current });
    setSaved({ epoch, authorizationEpoch, active: identity, entries });
  }
  React.useLayoutEffect(() => {
    const cache = retention?.cache;
    if (!cache) return;
    const inactive = new Set([...entries].filter(([key]) => key !== identity).map(([, entry]) => entry.token));
    for (const token of registrations.current) if (!inactive.has(token)) cache.release(token);
    for (const [key, entry] of entries) {
      if (key === identity) cache.release(entry.token);
      else cache.retain(entry.token, () => setSaved(previous => {
        if (!previous.entries.has(key)) return previous;
        const next = new Map(previous.entries); next.delete(key); return { ...previous, entries: next };
      }));
    }
    registrations.current = inactive;
  }, [entries, identity, retention?.cache]);
  React.useLayoutEffect(() => () => {
    for (const token of registrations.current) retention?.cache.release(token);
    registrations.current.clear();
  }, [retention?.cache]);
  // Identical boundary structure during SSR and hydration. Hidden branches get
  // their original router context and their effects are disconnected by React.
  return [...entries].map(([key, entry]) => React.createElement(React.Activity, { key: entry.reactKey, mode: key === identity ? 'visible' : 'hidden' },
    React.createElement(AppRouterContext.Provider, { value: key === identity ? router : entry.router }, entry.children)));
}

function LayoutProvider({ id, segments, children }) {
  const cache = React.useContext(LayoutCacheContext);
  const previous = React.useRef({});
  const current = {};
  for (const [slot, value] of Object.entries(segments || {})) current[slot] = value === null ? cache?.segments[id]?.[slot] || previous.current[slot] || [] : value;
  React.useLayoutEffect(() => { previous.current = current; if (cache && id) cache.segments[id] = current; });
  return React.createElement(LayoutContext.Provider, { value: current }, children);
}

function LayoutSlot({ id, preserve, children, activityKey, activityPreserve, authorizationKey }) {
  const cache = React.useContext(LayoutCacheContext);
  const previous = React.useRef(children);
  const current = preserve && cache && Object.hasOwn(cache.slots, id) ? cache.slots[id] : preserve ? previous.current : children;
  React.useLayoutEffect(() => { previous.current = current; if (cache && id) cache.slots[id] = current; }, [cache, id, current]);
  const previousKey = React.useRef(activityKey);
  const identity = preserve || activityPreserve ? previousKey.current : activityKey;
  React.useLayoutEffect(() => { previousKey.current = identity; }, [identity]);
  return activityKey === undefined ? current ?? null : React.createElement(ActivitySlot, { identity, authorizationKey }, current);
}

module.exports.LayoutContext = LayoutContext;
module.exports.LayoutCacheContext = LayoutCacheContext;
module.exports.LayoutProvider = LayoutProvider;
module.exports.LayoutSlot = LayoutSlot;
module.exports.ActivitySlot = ActivitySlot;
module.exports.ActivityCacheContext = ActivityCacheContext;
