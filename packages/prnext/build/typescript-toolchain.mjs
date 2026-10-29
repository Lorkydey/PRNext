import {readFile,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

// Select from the application's installation, never from the framework's own
// development dependencies. Native TypeScript deliberately lacks the old API.
export async function resolveTypeScript(root) {
  const require=createRequire(path.join(root,'package.json'));
  const manifest=require.resolve('typescript/package.json');
  const metadata=JSON.parse(await readFile(manifest,'utf8'));
  const major=Number(/^([0-9]+)\./.exec(metadata.version)?.[1]);
  if(!Number.isInteger(major))throw new Error('The installed TypeScript package has no valid version.');
  if(major<7)return {native:false,compiler:require.resolve('typescript'),version:metadata.version};
  const entry=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.tsc;
  if(typeof entry!=='string'||!entry)throw new Error('The installed TypeScript package has no tsc command. Reinstall TypeScript with its optional native dependencies.');
  const directory=path.dirname(manifest),bin=path.resolve(directory,entry);
  if(!bin.startsWith(directory+path.sep)||!(await stat(bin)).isFile())throw new Error('The installed TypeScript tsc command is invalid.');
  return {native:true,compiler:bin,version:metadata.version};
}
