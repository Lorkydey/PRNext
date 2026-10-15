import { MAX_RESPONSE_BYTES } from './http.mjs';

// A raw element cannot be interrupted with a Flight script. Keep its chunks
// until its closing tag arrives, but only scan newly received characters.
// Joining and rescanning a growing inline script on every chunk is quadratic.
const whitespace = /\s/;
function holdRaw(state, text) {
  if (!text) return;
  // Compact small chunks in tiers: even single-character input cannot retain
  // millions of array entries. Each tier joins once per 64 chunks, rather
  // than repeatedly copying the entire accumulated element.
  for (let level = 0;; level++) {
    const parts = state.parts[level] ??= [];
    parts.push(text);
    if (parts.length < 64) return;
    text = parts.join('');
    parts.length = 0;
  }
}
function releaseRaw(state) {
  const parts = [];
  for (let level = state.parts.length - 1; level >= 0; level--) parts.push(...state.parts[level]);
  return parts.join('');
}
function rawEnd(text, state, from = 0) {
  let index = from;
  while (index < text.length) {
    if (!state.matched) {
      const start = text.indexOf('<', index);
      if (start < 0) return -1;
      state.matched = 1;
      index = start + 1;
    } else if (state.matched < state.prefix.length) {
      const code = text.charCodeAt(index);
      if (state.matched === 1 ? code === 47 : (code | 32) === state.prefix.charCodeAt(state.matched)) {
        state.matched++;
        index++;
      } else state.matched = 0;
    } else if (text[index] === '>') {
      return index + 1;
    } else if (whitespace.test(text[index])) {
      index++;
    } else state.matched = 0;
  }
  return -1;
}

// Do not insert Flight/bootstrap scripts inside a split tag or raw-text element.
// Scan by index: ordinary tags stay in one contiguous slice, instead of creating
// a new tail and output string for every cell of a rendered table.
export function htmlEnvelope({ resumed = false } = {}) {
  let pending = '';
  let closing = '';
  let received = 0;
  let rawPending;
  const rawStart = /<(script|style|textarea|title|svg|math)(?:\s|>)/iy;
  const rawEnds = new Map();
  const documentEnd = /<\/(body|html)\s*>/iy;
  return {
    append(text) {
      received += Buffer.byteLength(text);
      if (received > MAX_RESPONSE_BYTES) throw new Error('HTML response exceeds the 16 MiB PRNext limit');
      let ready = '';
      if (rawPending) {
        const end = rawEnd(text, rawPending);
        if (end < 0) { holdRaw(rawPending, text); return ''; }
        holdRaw(rawPending, text.slice(0, end));
        ready = releaseRaw(rawPending);
        rawPending = undefined;
        text = text.slice(end);
      }
      pending += text;
      let cursor = 0, output = 0;
      while (cursor < pending.length) {
        const start = pending.indexOf('<', cursor);
        if (start < 0) { cursor = pending.length; break; }
        cursor = start;
        let end = -1;
        if (pending.startsWith('<!--', start)) {
          const comment = pending.indexOf('-->', start);
          if (comment >= 0) end = comment + 2;
        } else {
          for (let index = start + 1; index < pending.length; index++) {
            const char = pending[index];
            if (char === '"' || char === "'") {
              const close = pending.indexOf(char, index + 1);
              if (close < 0) break;
              index = close;
            } else if (char === '>') { end = index; break; }
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
          if (!match) {
            rawPending = { prefix: `</${name}`, matched: 0, parts: [] };
            holdRaw(rawPending, pending.slice(start));
            rawEnd(pending, rawPending, end + 1);
            ready += pending.slice(output, start);
            pending = '';
            return ready;
          }
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
      if (pending || rawPending || !(resumed ? /^(?:<\/body><\/html>){1,2}$/i : /^<\/body><\/html>$/i).test(closing)) throw new Error('App Router root layout did not close its body and html elements');
      return resumed ? '</body></html>' : closing;
    },
  };
}
