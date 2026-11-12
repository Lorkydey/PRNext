import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
export async function resolveStyledComponents(args,root){
  const resolve=createRequire(path.join(args.resolveDir||root,'package.json')).resolve;
  const metadata=resolve('styled-components/package.json'),pkg=JSON.parse(await readFile(metadata,'utf8'));
  // Native ESM importing the CJS namespace does not expose the default styled
  // factory expected by the browser build. Bundle the package's ESM distribution.
  if(pkg.module)return {path:path.resolve(path.dirname(metadata),pkg.module)};
}
