const managers = new WeakMap();

function aborted() { return new DOMException('Navigation cancelled', 'AbortError'); }

/** Styles are downloaded while the old page remains visible, but become
 * active together in the new tree's layout effect, before the next paint.
 * Keeping one manager per document also covers development runtime updates. */
export function appStyleManager(document, { timeout = 15_000 } = {}) {
  if (managers.has(document)) return managers.get(document);
  const sheets = new Map();
  let handed = new Map();
  let cleanup = 0;
  const reserved = sheet => handed.get(sheet.link.href) === sheet;
  function urls(values) {
    if (!Array.isArray(values) || values.length > 1024) throw new Error('Invalid App Router stylesheet list');
    return [...new Set(values.map(value => {
      if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid App Router stylesheet URL');
      const url = new URL(value, document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid App Router stylesheet protocol');
      return url.href;
    }))];
  }
  function remove(href, sheet) {
    if (sheet.removed) return;
    sheet.removed = true;
    sheet.detach?.();
    sheet.link.remove();
    const records = sheets.get(href);
    if (records) {
      const index = records.indexOf(sheet);
      if (index >= 0) records.splice(index, 1);
      if (!records.length) sheets.delete(href);
    }
  }
  function acquire(href, before, replace = false) {
    const records = sheets.get(href) || [];
    const current = records.at(-1);
    if (current && !replace) return current;
    // A replacement keeps the old active (or local-reset recovery) occurrence
    // in place until commit. Discard older abandoned candidates immediately.
    if (replace) for (const record of [...records]) if (!record.active && !record.recovery && !reserved(record)) remove(href, record);
    const tracked = new Set(records.map(record => record.link));
    const existing = replace ? undefined : [...document.querySelectorAll('link[rel="stylesheet"]')].find(link => link.href === href && !tracked.has(link));
    const link = existing || document.createElement('link');
    const sheet = { link, active: !!existing, ready: !!existing?.sheet, recovery: false };
    const retained = sheets.get(href) || [];
    retained.push(sheet); sheets.set(href, retained);
    if (sheet.ready) sheet.promise = Promise.resolve();
    else sheet.promise = new Promise((resolve, reject) => {
      let finished = false;
      const detach = () => { clearTimeout(timer); link.removeEventListener('load', loaded); link.removeEventListener('error', failed); };
      const finish = error => {
        if (finished) return;
        finished = true; detach(); sheet.detach = undefined;
        if (error) { remove(href, sheet); reject(error); }
        else { sheet.ready = true; resolve(); }
      };
      const loaded = () => finish();
      const failed = () => finish(new Error(`Could not load stylesheet ${href}`));
      const timer = setTimeout(() => finish(new Error('App Router stylesheet loading timed out')), timeout);
      sheet.detach = () => finish(aborted());
      link.addEventListener('load', loaded);
      link.addEventListener('error', failed);
    });
    // Cancellation and a competing navigation can remove a pending sheet.
    // Each caller still observes the original rejection through prepare().
    void sheet.promise.catch(() => {});
    if (!existing) {
      link.rel = 'stylesheet'; link.href = href; link.media = 'not all';
      link.dataset.prnextAppStyle = '';
      if (before) document.head.insertBefore(link, before);
      else document.head.append(link);
    }
    return sheet;
  }
  const manager = {
    async prepare(values = [], signal) {
      if (signal?.aborted) throw aborted();
      const wanted = urls(values);
      const prepared = [];
      let before;
      // Establish cascade order before downloading. Re-inserting an already
      // loaded link can unload its CSSOM and refetch, even within the same head.
      // Keep a correctly ordered suffix; prepare a separate inactive occurrence
      // when an existing sheet would otherwise need to move across that suffix.
      for (let index = wanted.length - 1; index >= 0; index--) {
        const href = wanted[index];
        let sheet = acquire(href, before);
        if (before && !(sheet.link.compareDocumentPosition(before) & 4)) sheet = acquire(href, before, true);
        prepared.push(sheet.promise);
        before = sheet.link;
      }
      const pending = Promise.all(prepared);
      if (!signal) return pending;
      await new Promise((resolve, reject) => {
        const cancel = () => reject(aborted());
        signal.addEventListener('abort', cancel, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
    },
    handoff(values = []) {
      // A concurrent React render can suspend after its CSS has loaded. Pin
      // these exact occurrences until that render commits or is superseded;
      // pagehide/actions must cancel network work, not its already-ready CSS.
      const next = new Map(urls(values).map(href => {
        const sheet = sheets.get(href)?.at(-1);
        if (!sheet?.ready) throw new Error('App Router styles were not prepared before rendering');
        return [href, sheet];
      }));
      const previous = handed; handed = next;
      for (const [href, sheet] of previous) if (!reserved(sheet) && !sheet.active && !sheet.recovery) remove(href, sheet);
    },
    commit(values = []) {
      cleanup++;
      const wanted = new Set(urls(values));
      const handedUrls = [...handed.keys()];
      const pinned = wanted.size === handed.size && [...wanted].every((href, index) => handedUrls[index] === href) ? handed : null;
      for (const href of wanted) {
        const records = sheets.get(href) || [];
        const prior = !pinned && handed.size ? records.find(record => record.active) || records.find(record => record.recovery) : undefined;
        const sheet = pinned?.get(href) || prior || records.findLast(record => record.ready) || acquire(href);
        // Initial HTML links are render-blocking. A missing sheet is restored
        // on explicit recovery; normal navigation always prepares first.
        sheet.active = true; sheet.recovery = false; sheet.link.media = '';
        for (const previous of [...sheets.get(href)]) if (previous !== sheet && !reserved(previous)) remove(href, previous);
      }
      if (pinned) handed = new Map();
      for (const [href, records] of sheets) {
        for (const sheet of [...records]) if ((!wanted.has(href) || !sheet.active) && !reserved(sheet)) remove(href, sheet);
      }
    },
    release() {
      const revision = ++cleanup;
      // A normal tree update or StrictMode's effect replay commits in the same
      // turn. Only a genuine fatal/global unmount retires the normal styles.
      queueMicrotask(() => {
        if (cleanup !== revision) return;
        const recovery = new Set([...sheets.values()].flat().filter(sheet => sheet.ready && (sheet.active || reserved(sheet))));
        for (const [href, records] of sheets) for (const sheet of [...records]) {
          // Local reset is allowed to remount the same server tree without a
          // request. Keep already loaded sheets inert so that reset can restore
          // them synchronously, rather than painting before a second load event.
          if (recovery.has(sheet)) { sheet.active = false; sheet.recovery = true; sheet.link.media = 'not all'; }
          else if (recovery.size || !sheet.recovery) remove(href, sheet);
        }
      });
    },
    cancel() {
      for (const [href, records] of sheets) for (const sheet of [...records]) if (!sheet.active && !sheet.recovery && !reserved(sheet)) remove(href, sheet);
    },
  };
  managers.set(document, manager);
  return manager;
}
