'use strict';
// Opt-in, bounded diagnostics. Never retain request headers, cookies or bodies.
const directory = process.env.PRNEXT_INSPECT_DIR;
const { threadId } = require('node:worker_threads');
let queue = [], scheduled = false, writing = false, size;
const limit = 1024 * 1024;
function record(type, fields = {}) {
  if (!directory || queue.length >= 256) return;
  const line = JSON.stringify({ time: Date.now(), pid: process.pid, type, ...fields }) + '\n';
  if (Buffer.byteLength(line) > 4096) return;
  queue.push(line);
  if (!scheduled) { scheduled = true; setTimeout(flush, 100).unref(); }
}
async function flush() {
  scheduled = false;
  if (writing || !queue.length) return;
  writing = true;
  const fs = require('node:fs/promises'), path = require('node:path');
  const file = path.join(directory, `worker-${process.pid}-${threadId}.jsonl`);
  const batch = queue.join(''); queue = [];
  try {
    await fs.mkdir(directory, { recursive: true });
    if (size === undefined) {
      size = await fs.stat(file).then(value => value.size, () => 0);
      // Retain the most recent worker sessions. Each has at most two 1 MiB files.
      const files = await Promise.all((await fs.readdir(directory)).filter(name => /^worker-\d+-\d+\.jsonl(?:\.1)?$/.test(name)).map(async name => ({ name, modified: await fs.stat(path.join(directory, name)).then(value => value.mtimeMs, () => 0) })));
      for (const old of files.sort((a, b) => b.modified - a.modified).slice(62)) await fs.rm(path.join(directory, old.name), { force: true }).catch(() => {});
    }
    if (size + Buffer.byteLength(batch) > limit) { await fs.rm(file + '.1', { force: true }); await fs.rename(file, file + '.1').catch(error => { if (error.code !== 'ENOENT') throw error; }); size = 0; }
    await fs.appendFile(file, batch, { mode: 0o600 }); size += Buffer.byteLength(batch);
  } catch { /* Diagnostics must never fail an application request. */ }
  finally { writing = false; if (queue.length && !scheduled) { scheduled = true; setTimeout(flush, 100).unref(); } }
}
function route(context) { return String(context?.routePattern || '<unattributed>').slice(0, 256); }
function destination(input) {
  try { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); return (url.origin + url.pathname).slice(0, 256); }
  catch { return '<unknown>'; }
}
function label(value) { return require('node:crypto').createHash('sha256').update(String(value)).digest('hex').slice(0, 12); }
module.exports = { enabled: Boolean(directory), record, route, destination, label, flush };
