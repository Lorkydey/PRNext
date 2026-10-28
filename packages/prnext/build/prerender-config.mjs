import { availableParallelism, freemem } from 'node:os';

const MIB = 1024 * 1024;

export function validatePrerenderConfig(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('prerender must be an object.');
  for (const key of Object.keys(value)) if (!['workers', 'maxMemoryMb'].includes(key)) throw new TypeError(`prerender.${key} is not supported.`);
  const result = {};
  if (value.workers !== undefined) {
    if (!Number.isInteger(value.workers) || value.workers < 1 || value.workers > 8) throw new TypeError('prerender.workers must be an integer from 1 to 8.');
    result.workers = value.workers;
  }
  if (value.maxMemoryMb !== undefined) {
    if (!Number.isInteger(value.maxMemoryMb) || value.maxMemoryMb < 256 || value.maxMemoryMb > 16384) throw new TypeError('prerender.maxMemoryMb must be an integer from 256 to 16384.');
    result.maxMemoryMb = value.maxMemoryMb;
  }
  return result;
}

// This is an admission budget, not an OS memory sandbox. Reserve memory for the
// coordinator/compiler and derive the process count from currently free RAM.
export function prerenderResources(value, { cpus = availableParallelism(), free = Math.min(freemem(), process.availableMemory?.() ?? Infinity) } = {}) {
  const config = validatePrerenderConfig(value);
  const availableMb = Math.max(0, Math.floor(free / MIB) - 512);
  const maxMemoryMb = Math.min(config.maxMemoryMb ?? 2048, Math.max(256, Math.floor(availableMb / 2)));
  const workers = Math.max(1, Math.min(config.workers ?? 4, Math.max(1, cpus - 1), Math.floor(maxMemoryMb / 384)));
  return { workers, maxMemoryMb, heapMb: Math.max(64, Math.floor(maxMemoryMb / workers / 3)), explicit: config.workers !== undefined };
}
