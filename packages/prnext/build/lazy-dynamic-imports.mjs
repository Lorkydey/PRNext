import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import {generateMapped} from './source-maps.mjs';

const traverse=traverseModule.default||traverseModule;
const generate=generateModule.default||generateModule;
const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const client=fileURLToPath(new URL('../runtime/lazy-import-client.mjs',import.meta.url));
export const LAZY_IMPORT_LIMIT=128;
export const LAZY_BRIDGE_LIMIT=4096;
const javascript=/\.(?:[cm]?[jt]s|[jt]sx)$/;
// esbuild exposes JSON as an ESM entry with a shared default object and named
// exports. Give it the same native URL identity as JavaScript export bridges.
const bridgeable=file=>javascript.test(file)||file.endsWith('.json');
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const suffixError=()=>({errors:[{text:'lazyDynamicImports cannot safely defer a module with a query or fragment suffix. Disable experimental.lazyDynamicImports to compile this graph normally.'}]});

/** Development-only graph boundaries. No source path is sent to the browser. */
export function createLazyDynamicImports({root,stage,manifest,request,activated=[]}){
  const modules=new Map(),bridges=new Map(),shared=new Set(),existingShared=new Set(),entries=new Map(),targetFiles=new Map(),nativeOutputs=new Map(),outputs={};
  const active=new Set(activated);
  if(active.size>LAZY_IMPORT_LIMIT)throw Error(`lazyDynamicImports supports at most ${LAZY_IMPORT_LIMIT} active imports`);
  if(request){
    if(!/^[a-f0-9]{24}$/.test(request.id)||!Array.isArray(request.modules)||request.modules.length>LAZY_IMPORT_LIMIT||!Array.isArray(request.bridges)||request.bridges.length>LAZY_BRIDGE_LIMIT||!Array.isArray(request.shared)||request.shared.length>LAZY_BRIDGE_LIMIT)throw Error('Invalid deferred import compiler descriptor');
    for(const item of request.modules){
      const file=path.resolve(root,item.importer);
      if(!file.startsWith(root+path.sep)||file.includes(`${path.sep}node_modules${path.sep}`)||!javascript.test(file)||typeof item.request!=='string'||item.request.length>4096||item.id!==digest(item.importer+'\0'+item.request))throw Error('Invalid deferred import registration');
      modules.set(item.id,item);
    }
    if(!modules.has(request.id))throw Error('Unknown deferred import identifier');
    for(const item of request.bridges){
      if(typeof item.file!=='string'||typeof item.url!=='string'||!item.url.startsWith(manifest.config.assetBase+'/')||/[\r\n\0]/.test(item.url))throw Error('Invalid deferred module bridge');
      bridges.set(path.resolve(root,item.file),item.url);
    }
    for(const file of request.shared){const absolute=path.resolve(root,file);shared.add(absolute);existingShared.add(absolute);}
    active.clear();active.add(request.id);
  }
  const sourceAst=(source,file)=>parse(source,{sourceType:'unambiguous',sourceFilename:file,plugins:['jsx',...(/\.[cm]?tsx?$/.test(file)?['typescript']:[])]});
  const eligible=file=>file.startsWith(root+path.sep)&&!file.includes(`${path.sep}node_modules${path.sep}`)&&!file.includes(`${path.sep}.prnext-build-`);
  function transform(source,file){
    if(!eligible(file)||!source.includes('import'))return source;
    const ast=sourceAst(source,file);let binding,changed=false;
    const replace=node=>{
      const value=t.isStringLiteral(node)?node.value:t.isTemplateLiteral(node)&&!node.expressions.length?node.quasis[0].value.cooked:undefined;
      // Suffixes are part of ESM identity; path-only export bridges cannot
      // represent them. Keep explicit suffixes in the ordinary compiler graph.
      if(!value||value.length>4096||/[?#]/.test(value)||/^(?:[a-z]+:|\/\/)/i.test(value))return;
      const importer=path.relative(root,file).split(path.sep).join('/'),id=digest(importer+'\0'+value);
      if(!modules.has(id)&&modules.size>=LAZY_IMPORT_LIMIT)throw Error(`lazyDynamicImports supports at most ${LAZY_IMPORT_LIMIT} registered imports per generation`);
      modules.set(id,{id,importer,request:value});
      changed=true;return id;
    };
    traverse(ast,{Program(p){binding=p.scope.generateUidIdentifier('prnextLazyImport');},CallExpression(p){
      if(!t.isImport(p.node.callee)||p.node.arguments.length!==1)return;
      const id=replace(p.node.arguments[0]);if(id)p.replaceWith(t.callExpression(t.cloneNode(binding),[t.stringLiteral(id),t.stringLiteral(manifest.config.basePath||'')]));
    },ImportExpression(p){if(p.node.options)return;const id=replace(p.node.source);if(id)p.replaceWith(t.callExpression(t.cloneNode(binding),[t.stringLiteral(id),t.stringLiteral(manifest.config.basePath||'')]));}});
    if(!changed)return source;
    ast.program.body.unshift(t.importDeclaration([t.importSpecifier(t.cloneNode(binding),t.identifier('lazyImport'))],t.stringLiteral(client)));
    return generateMapped(generate,ast,{comments:true},source,file);
  }
  async function discover(metafile){
    for(const input of Object.keys(metafile.inputs)){
      const file=path.resolve(root,input);
      if(!bridgeable(file)||input.startsWith('prnext-')||file.startsWith(packageRoot)||file.startsWith(stage+path.sep)||/\/node_modules\/(?:react|react-dom|react-refresh|react-server-dom-webpack)\//.test(file.split(path.sep).join('/'))||shared.has(file))continue;
      if(shared.size>=LAZY_BRIDGE_LIMIT)throw Error(`lazyDynamicImports supports at most ${LAZY_BRIDGE_LIMIT} static JavaScript modules`);
      shared.add(file);
      // Real ESM entries expose live bindings. CommonJS named exports cannot be
      // approximated with snapshots: a deferred graph sharing one is rejected.
      if(file.endsWith('.json')||sourceAst(await readFile(file,'utf8'),file).program.sourceType==='module')bridges.set(file,undefined);
    }
  }
  async function targetEntries(){
    const result={};
    for(const id of active){
      if(!modules.has(id))continue;
      const name='lazy-'+id,file=path.join(stage,'.entries',name+'.mjs');
      await writeFile(file,`import * as namespace from ${JSON.stringify('prnext-lazy-entry:'+id)};export {namespace as __prnextLazyModule};`);
      entries.set(file,{kind:'target',id});result[name]=file;
    }
    return result;
  }
  function bridgeEntries(){
    const result=Object.fromEntries([...bridges].filter(([,url])=>!url).map(([file])=>{entries.set(file,{kind:'bridge',file});return ['lazy-bridge-'+digest(file),file];}));
    for(const file of targetFiles.values())if(!bridges.has(file)&&bridgeable(file)){
      entries.set(file,{kind:'native',file});result['lazy-native-'+digest(file)]=file;
    }
    return result;
  }
  function plugin(){return {name:'prnext-lazy-dynamic-boundaries',setup(builder){
    builder.onResolve({filter:/^prnext-lazy-entry:/},async args=>{
      const item=modules.get(args.path.slice('prnext-lazy-entry:'.length));
      if(!item)return {errors:[{text:'Unknown deferred module entry'}]};
      const result=await builder.resolve(item.request,{resolveDir:path.dirname(path.resolve(root,item.importer)),kind:'dynamic-import',pluginData:{prnextLazyEntry:true}});
      if(!result.errors.length&&result.suffix)return suffixError();
      const file=path.resolve(result.path||root),url=bridges.get(file);
      if(!result.errors.length&&result.namespace==='file')targetFiles.set(item.id,file);
      if(existingShared.has(file)&&!url)return {errors:[{text:`lazyDynamicImports cannot safely reuse the shared CommonJS module ${path.relative(root,file)}. Convert it to ESM or disable experimental.lazyDynamicImports.`}]};
      return url?{path:url,external:true}:result;
    });
    if(request)builder.onResolve({filter:/.*/},async args=>{
      if(args.pluginData?.prnextLazyResolving||args.pluginData?.prnextLazyEntry||args.kind==='entry-point'||args.namespace&&args.namespace!=='file')return;
      const result=await builder.resolve(args.path,{resolveDir:args.resolveDir,importer:args.importer,kind:args.kind,with:args.with,pluginData:{...args.pluginData,prnextLazyResolving:true}});
      // Aliases and transitive imports may introduce a suffix even when the
      // registered literal had none. Reject it before looking up a bare bridge.
      if(!result.errors.length&&result.suffix)return suffixError();
      if(result.errors.length||result.external||result.namespace!=='file')return;
      const file=path.resolve(result.path);
      if(bridges.get(file))return {path:bridges.get(file),external:true};
      if(existingShared.has(file))return {errors:[{text:`lazyDynamicImports cannot safely reuse the shared CommonJS module ${path.relative(root,file)}. Convert it to ESM or disable experimental.lazyDynamicImports.`}]};
    });
  }};}
  function record(metadata,output){
    const entry=entries.get(path.resolve(root,metadata.entryPoint||''));
    if(!entry||!output.endsWith('.js'))return false;
    const url=manifest.config.assetBase+'/'+path.basename(output);
    if(entry.kind==='bridge'||entry.kind==='native'){
      if(entry.kind==='bridge')bridges.set(entry.file,url);
      nativeOutputs.set(entry.file,{url,css:metadata.cssBundle?[manifest.config.assetBase+'/'+path.basename(metadata.cssBundle)]:[]});
    }
    else outputs[entry.id]={url,css:metadata.cssBundle?[manifest.config.assetBase+'/'+path.basename(metadata.cssBundle)]:[]};
    return true;
  }
  function finish(){
    for(const [id,file]of targetFiles){
      const native=nativeOutputs.get(file),url=native?.url||bridges.get(file);
      if(url&&outputs[id])outputs[id]={url,native:true,css:[...new Set([...outputs[id].css,...(native?.css||[])])]};
    }
    manifest.devLazy={modules:[...modules.values()],bridges:[...bridges].filter(([,url])=>url).map(([file,url])=>({file:path.relative(root,file).split(path.sep).join('/'),url})),shared:[...shared].map(file=>path.relative(root,file).split(path.sep).join('/')),outputs};
  }
  return {transform,discover,targetEntries,bridgeEntries,plugin,record,finish};
}
