import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export async function validatePublicMetadata(root, pattern, file, dynamic) {
  const publicFile = path.join(root, 'public', pattern.slice(1));
  try {
    const info = await stat(publicFile);
    // Next production serves public files before App metadata handlers. An
    // identical static duplicate is therefore unambiguous and safe to retain.
    if (!dynamic && info.isFile() && info.size <= 16 * 1024 * 1024 && info.size === (await stat(file)).size && (await readFile(publicFile)).equals(await readFile(file))) return;
    throw new Error(`Metadata route ${pattern} conflicts with a different file in public/. Keep a single source for this URL.`);
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
}
