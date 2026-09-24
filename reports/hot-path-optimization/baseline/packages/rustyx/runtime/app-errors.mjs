import { createHash } from 'node:crypto';

export function appErrorDigest(error) {
  return typeof error?.digest === 'string' ? error.digest
    : createHash('sha256').update(String(error?.stack || error?.message || error)).digest('hex').slice(0, 16);
}

export function appTimeoutError(phase, milliseconds) {
  const error = new Error(`App Router ${phase} timed out after ${milliseconds / 1000} seconds`);
  error.statusCode = 504;
  return error;
}
