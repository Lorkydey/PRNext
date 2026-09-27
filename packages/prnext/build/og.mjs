import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
export async function prepareImageResponse(stage) {
  const directory = path.dirname(createRequire(import.meta.url).resolve('@vercel/og'));
  const target = path.join(stage, 'runtime/og');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'index.node.mjs'), `import {createRequire as __prnextRequire} from 'node:module';import {fileURLToPath as __prnextFile} from 'node:url';import {dirname as __prnextDir} from 'node:path';const require=__prnextRequire(import.meta.url),__filename=__prnextFile(import.meta.url),__dirname=__prnextDir(__filename);\n` + await readFile(path.join(directory, 'index.node.js'), 'utf8'));
  for (const name of ['Geist-Regular.ttf', 'resvg.wasm']) await cp(path.join(directory, name), path.join(target, name));
  await cp(path.join(directory, '../LICENSE'), path.join(target, 'LICENSE'));
  await writeFile(path.join(target, 'NOTICE.txt'), 'Image renderer: @vercel/og 1.0.3 (https://github.com/vercel/og). PRNext adds Node CommonJS globals to its bundled ESM entry and includes the adjacent HarfBuzz WASM needed by that entry. Upstream bundled notices are preserved in index.node.mjs.\n');
  const satori = createRequire(path.join(directory, 'index.node.js')).resolve('satori');
  await cp(createRequire(satori).resolve('harfbuzzjs/hb.wasm'), path.join(target, 'hb.wasm'));
}
