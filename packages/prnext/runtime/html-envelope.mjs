import { MAX_RESPONSE_BYTES } from './http.mjs';

// Do not insert Flight/bootstrap scripts inside a split tag or raw-text element.
// Scan by index: ordinary tags stay in one contiguous slice, instead of creating
// a new tail and output string for every cell of a rendered table.
export function htmlEnvelope({ resumed = false } = {}) {
  let pending = '';
  let closing = '';
  let received = 0;
  const rawStart = /<(script|style|textarea|title|svg|math)(?:\s|>)/iy;
  const rawEnds = new Map();
  const documentEnd = /<\/(body|html)\s*>/iy;
  return {
    append(text) {
      received += Buffer.byteLength(text);
      if (received > MAX_RESPONSE_BYTES) throw new Error('HTML response exceeds the 16 MiB PRNext limit');
      pending += text;
      let cursor = 0, output = 0, ready = '';
      while (cursor < pending.length) {
        const start = pending.indexOf('<', cursor);
        if (start < 0) { cursor = pending.length; break; }
        cursor = start;
        let end = -1;
        if (pending.startsWith('<!--', start)) {
          const comment = pending.indexOf('-->', start);
          if (comment >= 0) end = comment + 2;
        } else {
          let quote;
          for (let index = start + 1; index < pending.length; index++) {
            const char = pending[index];
            if (quote) { if (char === quote) quote = undefined; }
            else if (char === '"' || char === "'") quote = char;
            else if (char === '>') { end = index; break; }
          }
        }
        if (end < 0) break;
        // Most tags need no special handling. Reject their ASCII prefixes
        // before running the raw-element and document-closing expressions;
        // the expressions still validate every candidate in full.
        const first = pending.charCodeAt(start + 1) | 32;
        const second = pending.charCodeAt(start + 2) | 32;
        const rawCandidate = first === 115 && (second === 99 || second === 116 || second === 118) ||
          first === 116 && (second === 101 || second === 105) || first === 109 && second === 97;
        rawStart.lastIndex = start;
        const raw = rawCandidate && rawStart.exec(pending);
        if (raw && pending[end - 1] !== '/') {
          const name = raw[1].toLowerCase();
          let pattern = rawEnds.get(name);
          if (!pattern) { pattern = new RegExp(`</${name}\\s*>`, 'ig'); rawEnds.set(name, pattern); }
          pattern.lastIndex = end + 1;
          const match = pattern.exec(pending);
          if (!match) break;
          cursor = pattern.lastIndex;
        } else {
          documentEnd.lastIndex = start;
          if (first === 47 && (second === 98 || second === 104) && documentEnd.test(pending) && documentEnd.lastIndex === end + 1) {
            ready += pending.slice(output, start);
            closing += pending.slice(start, end + 1);
            output = end + 1;
          }
          cursor = end + 1;
        }
      }
      ready += pending.slice(output, cursor);
      pending = pending.slice(cursor);
      return ready;
    },
    finish() {
      if (pending || !(resumed ? /^(?:<\/body><\/html>){1,2}$/i : /^<\/body><\/html>$/i).test(closing)) throw new Error('App Router root layout did not close its body and html elements');
      return resumed ? '</body></html>' : closing;
    },
  };
}
