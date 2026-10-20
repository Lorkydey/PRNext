// Consumers must not resolve Satori's exact vulnerable fflate dependency.
// Upstream also embeds the vulnerable implementation, so rebuild that bundle.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const entry = require.resolve('@vercel/og');
const directory = path.dirname(entry);
const target = fileURLToPath(new URL('../packages/prnext/runtime/og/', import.meta.url));
let source = await readFile(entry, 'utf8');
const start = '// node_modules/.pnpm/fflate@0.7.3/node_modules/fflate/esm/index.mjs';
const end = '// node_modules/.pnpm/satori@0.33.5/node_modules/satori/dist/index.js';
const boundary = source.indexOf(end, source.indexOf(start));
if (source.split(start).length !== 2 || boundary < 0) throw new Error('Upstream renderer changed; review the fflate replacement before releasing.');
source = source.slice(0, source.indexOf(start)) + 'import { inflateSync as inflateSync2 } from "fflate";\n' + source.slice(boundary);
await mkdir(target, { recursive: true });
await build({ stdin: { contents: source, resolveDir: directory, sourcefile: 'prnext-og.mjs', loader: 'js' },
  outfile: path.join(target, 'index.node.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  legalComments: 'inline', banner: { js: "import {createRequire as __prnextRequire} from 'node:module';import {fileURLToPath as __prnextFile} from 'node:url';import {dirname as __prnextDir} from 'node:path';const require=__prnextRequire(import.meta.url),__filename=__prnextFile(import.meta.url),__dirname=__prnextDir(__filename);" },
});
for (const file of ['Geist-Regular.ttf', 'resvg.wasm']) await cp(path.join(directory, file), path.join(target, file));
const satori = createRequire(entry).resolve('satori');
await cp(createRequire(satori).resolve('harfbuzzjs/hb.wasm'), path.join(target, 'hb.wasm'));
await cp(path.join(path.dirname(satori), '../LICENSE'), path.join(target, 'LICENSE.satori'));
await cp(path.join(path.dirname(createRequire(satori).resolve('harfbuzzjs')), 'LICENSE'), path.join(target, 'LICENSE.harfbuzzjs'));
await cp(path.join(directory, '../LICENSE'), path.join(target, 'LICENSE'));
await cp(path.join(path.dirname(require.resolve('fflate')), '../LICENSE'), path.join(target, 'LICENSE.fflate'));
await writeFile(path.join(target, 'NOTICE.txt'), 'Image renderer: @vercel/og 1.0.3 (https://github.com/vercel/og), with bundled Satori 0.33.5 (https://github.com/vercel/satori). PRNext replaces embedded fflate 0.7.3 with fflate 0.7.5, bundles it, adds Node CommonJS globals and includes adjacent WASM/font assets. Upstream bundled licenses are retained. Rebuild: node scripts/prepare-og.mjs.\nGeist Regular 1.800: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git), SIL OFL 1.1; LICENSE.Geist is the upstream OFL.txt.\nHarfBuzzJS 0.10.0: https://github.com/harfbuzz/harfbuzzjs; see LICENSE.harfbuzzjs.\nresvg-js 2.4.1: https://github.com/yisibl/resvg-js/tree/v2.4.1, MPL-2.0 (LICENSE).\n');
if ((await readFile(path.join(target, 'index.node.mjs'), 'utf8')).includes('fflate@0.7.3')) throw new Error('Vulnerable embedded fflate remains');
console.log('Prepared vendored OG renderer with fflate 0.7.5.');
