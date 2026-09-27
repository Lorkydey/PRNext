// Upstream's Node bundle contains HarfBuzz's CommonJS globals and an adjacent
// hb.wasm reference. Resolve these explicitly for direct prnext/og consumers.
// Production builds prepare a relocatable module instead and avoid this loader.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
export async function loadImageRenderer() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@vercel/og');
  const fontDirectory = path.dirname(entry);
  const satori = createRequire(entry).resolve('satori');
  const harfbuzzDirectory = path.dirname(createRequire(satori).resolve('harfbuzzjs/hb.wasm'));
  const source = (await readFile(entry, 'utf8')).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(entry).href));
  const globals = `import {createRequire as __prnextRequire} from 'node:module';const require=__prnextRequire(${JSON.stringify(pathToFileURL(path.join(fontDirectory, 'index.node.js')).href)}),__filename=${JSON.stringify(entry)},__dirname=${JSON.stringify(harfbuzzDirectory)};\n`;
  return import('data:text/javascript;base64,' + Buffer.from(globals + source).toString('base64'));
}
