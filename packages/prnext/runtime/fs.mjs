import { rename as move } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Windows scanners and recently closed file handles can briefly deny rename.
// Keep the atomic swap: never delete the destination to work around a lock.
export async function rename(source, destination) {
  const deadline = Date.now() + 2000;
  for (let attempt = 0; ; attempt++) {
    try { return await move(source, destination); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
      await delay(Math.min(10 * (attempt + 1), 100));
    }
  }
}
