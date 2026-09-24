import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function loadModule(modulePath) {
  return modulePath.endsWith('.cjs') ? require(modulePath) : import(pathToFileURL(modulePath).href);
}

