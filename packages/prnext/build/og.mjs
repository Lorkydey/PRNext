import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export async function prepareImageResponse(stage) {
  const target = path.join(stage, 'runtime/og');
  await mkdir(target, { recursive: true });
  await cp(fileURLToPath(new URL('../runtime/og/', import.meta.url)), target, { recursive: true });
}
