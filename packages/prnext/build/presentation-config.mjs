import {open} from 'node:fs/promises';
import path from 'node:path';
import {parseExpression} from '@babel/parser';

const limit=256*1024;
const unsafe='JSX configuration cannot be certified for compact presentation';
async function readConfig(file) {
  let handle;
  try {
    handle=await open(file,'r');const info=await handle.stat();
    if(!info.isFile()||info.size>limit)return {file,reason:unsafe};
    const buffer=Buffer.alloc(info.size+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if(bytesRead!==info.size)return {file,reason:unsafe};
    return {file,source:buffer.subarray(0,bytesRead).toString('utf8')};
  }catch(error){if(error.code==='ENOENT')return;return {file,reason:unsafe};}
  finally{await handle?.close();}
}
function properties(object) {
  if(object?.type!=='ObjectExpression'||object.properties.some(item=>item.type!=='ObjectProperty'||item.computed||item.key.type!=='StringLiteral'))return;
  return object.properties.map(item=>[item.key.value,item.value]);
}
function inspect(config) {
  if(!config)return;
  if(config.reason)return config.reason;
  try {
    // JSONC comments/trailing commas and escaped keys are parsed, never evaluated.
    const root=properties(parseExpression(config.source));if(!root)return unsafe;
    if(root.some(([name])=>name==='extends'))return 'Extended JSX configuration retains ordinary rendering';
    for(const [,value]of root.filter(([name])=>name==='compilerOptions')){
      const options=properties(value);if(!options)return unsafe;
      if(options.some(([name,value])=>['jsxImportSource','jsxFactory','jsxFragmentFactory'].includes(name)&&!(name==='jsxImportSource'&&value.type==='StringLiteral'&&value.value==='react')))return 'Custom JSX configuration retains ordinary rendering';
    }
  }catch{return unsafe;}
}

/** Per-build ownership: generated entries must use the same standard JSX input
 * as their source. Never silently move a nested/custom JSX runtime to the client.
 */
export function createPresentationConfigPolicy({root,tsconfig,customTransforms=false}) {
  const directories=new Map(),files=new Map(),inspections=new Map();
  const read=file=>{if(!files.has(file))files.set(file,readConfig(file));return files.get(file);};
  function nearest(directory) {
    if(!directories.has(directory))directories.set(directory,(async()=>{
      for(const name of ['tsconfig.json','jsconfig.json']){const found=await read(path.join(directory,name));if(found)return found;}
      const parent=path.dirname(directory);return parent===directory?undefined:nearest(parent);
    })());
    return directories.get(directory);
  }
  return async file=>{
    if(customTransforms)return 'Custom source transforms retain ordinary rendering';
    const [source,generated]=tsconfig?await Promise.all([read(tsconfig),read(tsconfig)]):await Promise.all([nearest(path.dirname(file)),nearest(root)]);
    if(source?.file!==generated?.file)return 'Per-directory JSX configuration retains ordinary rendering';
    if(!source)return;
    if(!inspections.has(source.file))inspections.set(source.file,inspect(source));
    return inspections.get(source.file);
  };
}
