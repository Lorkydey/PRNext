// Only owned development navigation GETs opt into a partial Flight decoder. An intentional
// supersession closes that decoder while cancelling its sole upstream reader;
// genuine transport errors still reject. This stream never claims genuine EOF
// on behalf of the transport or retains response bytes as a reusable delta base.
export function supersedableDevelopmentFlight(source, signal) {
  const reader = source.getReader();
  let controller, closed = false;
  const clean = () => {
    signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch {}
  };
  const cancel = reason => Promise.resolve(reader.cancel(reason)).catch(() => {}).finally(clean);
  const abort = () => {
    if (closed) return;
    closed = true;
    controller.close();
    void cancel(signal.reason);
  };
  return new ReadableStream({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      if (closed) return;
      try {
        const next = await reader.read();
        if (closed) return;
        // React's ordinary EOF rejects missing rows. With partial decoding
        // enabled, reserve a clean close exclusively for owned supersession.
        if (next.done) { closed = true; clean(); value.error(new Error('Connection closed.')); }
        else value.enqueue(next.value);
      } catch (error) {
        if (closed) return;
        closed = true;
        value.error(error);
        await cancel(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      await cancel(reason);
    },
  }, { highWaterMark: 0 });
}

// A partial decoder also halts an unresolved root on supersession. Race its
// root promise explicitly so cancellation cannot leave navigation waiting on it.
export function developmentFlightRoot(root, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => signal.removeEventListener('abort', abort);
    const abort = () => { clean(); reject(signal.reason || new DOMException('Development refresh cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(root).then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    if (signal.aborted) abort();
  });
}
