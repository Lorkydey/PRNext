import { Writable } from 'node:stream';
import { mkdir, open, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Backpressure reaches the child's stdout/stderr; even a noisy app cannot grow
// an unbounded in-memory write queue. Each file retains three older segments.
export class RotatingLog extends Writable {
  constructor(file, { maxBytes = 10 * 1024 * 1024, backups = 3 } = {}) {
    super({ highWaterMark: 64 * 1024 });
    this.file = file; this.maxBytes = maxBytes; this.backups = backups; this.size = 0;
    this.on('error', () => {});
  }
  _construct(callback) {
    (async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.size = await stat(this.file).then(info => info.size, () => 0);
      this.handle = await open(this.file, 'a', 0o600);
    })().then(() => callback(), callback);
  }
  async rotate() {
    await this.handle.close(); this.handle = undefined;
    await rm(`${this.file}.${this.backups}`, { force: true });
    for (let i = this.backups - 1; i >= 0; i--) {
      try { await rename(i ? `${this.file}.${i}` : this.file, `${this.file}.${i + 1}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.handle = await open(this.file, 'a', 0o600); this.size = 0;
  }
  _write(chunk, encoding, callback) {
    (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.size >= this.maxBytes) await this.rotate();
        const count = Math.min(chunk.length - offset, this.maxBytes - this.size);
        const { bytesWritten } = await this.handle.write(chunk.subarray(offset, offset + count));
        if (!bytesWritten) throw new Error('Unable to write application log');
        offset += bytesWritten; this.size += bytesWritten;
      }
    })().then(() => callback(), callback);
  }
  _final(callback) { this.handle?.close().then(() => callback(), callback) ?? callback(); }
  _destroy(error, callback) { this.handle?.close().then(() => callback(error), () => callback(error)) ?? callback(error); }
  message(value) { return this.write(`[${new Date().toISOString()}] ${value}\n`); }
  attach(stream, label) {
    const resume = () => stream.resume();
    stream.on('data', chunk => { if (!this.destroyed && !this.write(Buffer.concat([Buffer.from(`[${label}] `), chunk]))) stream.pause(); });
    this.on('drain', resume);
    const cleanup = () => { this.off('drain', resume); stream.resume(); };
    this.once('error', cleanup);
    stream.once('close', () => { this.off('drain', resume); this.off('error', cleanup); });
  }
}
