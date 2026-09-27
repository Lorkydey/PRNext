import { readFile } from 'node:fs/promises';
import { unstable_cache } from 'next/cache';

export const readMessage = unstable_cache(async () => {
  let message = 'Hello from the shared cache.';
  try { message = JSON.parse(await readFile('.prnext-cache/demo-message.json', 'utf8')).message; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { message, readAt: new Date().toISOString() };
}, ['demo-message'], { tags: ['demo-message'], revalidate: 60 });
