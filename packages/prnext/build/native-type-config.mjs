import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseTsconfig,createPathsMatcher} from 'get-tsconfig';
import {parse,modify,applyEdits} from 'jsonc-parser';

// TypeScript 7 has no stable legacy compiler API. Parse configuration only with
// the dedicated JSONC/config resolvers; semantic checking stays in native tsc.
export async function nativeTypeConfig(filename,helper){
  let source=await readFile(filename,'utf8');const errors=[];
  const own=parse(source,errors,{allowTrailingComma:true});
  if(errors.length||!own||typeof own!=='object'||Array.isArray(own))throw new Error('Cannot configure typed routes: invalid tsconfig.');
  const config=parseTsconfig(filename),directory=path.dirname(filename);
  const format={insertSpaces:true,tabSize:2,eol:source.includes('\r\n')?'\r\n':'\n'};
  const update=(location,value)=>{source=applyEdits(source,modify(source,location,value,{formattingOptions:format}));};
  const files=own.files??config.files??[];
  if(!Array.isArray(files)||files.some(file=>typeof file!=='string'))throw new Error('tsconfig.files must be an array.');
  if(!files.some(file=>path.resolve(directory,file)===helper))update(['files'],[...files,path.relative(directory,helper).replaceAll(path.sep,'/')]);
  const options=config.compilerOptions||{},paths=options.paths||{};
  const missing=['next','next/*'].filter(name=>!Object.hasOwn(paths,name));
  if(!missing.length)return source;
  const base=options.baseUrl?path.resolve(directory,options.baseUrl):directory;
  const relative=filename=>{const value=path.relative(base,filename).replaceAll(path.sep,'/');return value.startsWith('.')?value:'./'+value;};
  const resolved=own.compilerOptions?.paths?{...paths}:{};
  if(!own.compilerOptions?.paths){
    const matcher=createPathsMatcher({path:filename,config});
    for(const pattern of Object.keys(paths)){
      const probe='__prnext_type_path__',values=matcher?.(pattern.replace('*',probe));
      if(!values?.length)throw new Error('Cannot resolve inherited TypeScript path: '+pattern);
      resolved[pattern]=values.map(value=>relative(value).replaceAll(probe,'*'));
    }
  }
  const compat=fileURLToPath(new URL('../compat/',import.meta.url));
  for(const name of missing)resolved[name]=[relative(path.join(compat,name==='next'?'index.d.ts':'*.d.cts'))];
  update(['compilerOptions','paths'],resolved);
  return source;
}
