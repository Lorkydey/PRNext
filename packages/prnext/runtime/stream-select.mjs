// A read gets one settlement listener. Repeated Promise.race against a slow
// source otherwise accumulates one listener per chunk from the faster source.
// Callers keep at most one outstanding read per source and retain backpressure.
export function streamSelector() {
  const ready = [];
  let wake, closed = false;
  function settle(item) {
    if (closed) return;
    ready.push(item);
    wake?.(); wake = undefined;
  }
  return {
    watch(type, promise) {
      Promise.resolve(promise).then(value => settle({ type, ...value }), error => settle({ error }));
    },
    async next() {
      while (!ready.length && !closed) await new Promise(resolve => { wake = resolve; });
      if (closed) throw new Error('Stream selector closed');
      const item = ready.shift();
      if (Object.hasOwn(item, 'error')) throw item.error;
      return item;
    },
    close() { closed = true; ready.length = 0; wake?.(); wake = undefined; },
  };
}
