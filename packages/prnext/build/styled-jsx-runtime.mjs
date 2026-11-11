import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
export function styledJsxModule(specifier){return /^styled-jsx(?:\/(?:style|css)(?:\.js)?)?$/.test(specifier)?'styled-jsx'+(specifier==='styled-jsx'?'':specifier.includes('/css')?'-css':'-style'):undefined;}
export async function prepareStyledJsxRuntime(stage){
  await build({entryPoints:[fileURLToPath(new URL('../compat/styled-jsx.cjs',import.meta.url))],outfile:path.join(stage,'compat/styled-jsx.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22',external:['react'],logLevel:'silent'});
  const owner=path.dirname(createRequire(import.meta.url).resolve('styled-jsx/package.json'));
  await writeFile(path.join(stage,'compat/styled-jsx.LICENSE.txt'),await readFile(path.join(owner,'license.md')));
}
