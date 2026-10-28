'use strict';

// A shared budget across layout slots, rather than a separate page budget at
// every nesting level. Only inactive branches enter this registry.
function createActivityCache({ limit = 4, ttl = 120000, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const entries = new Map(); let timer;
  function arm() {
    cancel(timer); timer = undefined;
    if (entries.size) {
      timer = schedule(prune, Math.max(1, Math.min(...[...entries.values()].map(entry => entry.expires)) - now()));
      timer?.unref?.();
    }
  }
  function prune() {
    for (const [key, entry] of entries) if (entry.expires <= now()) { entries.delete(key); entry.evict(); }
    while (entries.size > limit) { const [key, entry] = entries.entries().next().value; entries.delete(key); entry.evict(); }
    arm();
  }
  return {
    retain(key, evict) { if (!entries.has(key)) entries.set(key, { evict, expires: now() + ttl }); prune(); },
    release(key) { entries.delete(key); arm(); },
    clear() { const previous = [...entries.values()]; entries.clear(); cancel(timer); timer = undefined; for (const entry of previous) entry.evict(); },
    get size() { return entries.size; },
  };
}
module.exports = { createActivityCache };
