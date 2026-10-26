import { transformAsync } from '@babel/core';
import refresh from 'react-refresh/babel';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedAsyncTransform } from './transform-cache.mjs';
import {inlineSourceMap} from './source-maps.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const devClientFile = path.join(packageRoot, 'runtime/dev-client.mjs');
const refreshIdentities = new Map();
function namedDefaultComponents({types:t}){
  return {visitor:{Program:{enter(program){
    if(program.node.directives.some(item=>item.value.value==='use server'))return;
    for(const statement of program.get('body')){
      if(!statement.isExportDefaultDeclaration())continue;
      const value=statement.get('declaration');if(!value.isArrowFunctionExpression())continue;
      let jsx=false;value.traverse({JSXElement(p){jsx=true;p.stop();},JSXFragment(p){jsx=true;p.stop();}});if(!jsx)continue;
      let name='PRNextDefaultComponent',suffix=0;
      while(program.scope.hasBinding(name)||program.scope.hasGlobal(name))name='PRNextDefaultComponent'+(++suffix);
      const id=t.identifier(name);
      statement.replaceWithMultiple([t.variableDeclaration('const',[t.variableDeclarator(id,value.node)]),t.exportDefaultDeclaration(t.cloneNode(id))]);
      program.scope.crawl();
    }
  }}}};
}
function sourceElements(id){return ({types:t})=>({visitor:{JSXOpeningElement(node){
  const name=node.node.name;
  if(name.type!=='JSXIdentifier'||!/^[a-z]/.test(name.name)||node.node.attributes.some(attribute=>attribute.type==='JSXAttribute'&&attribute.name.name==='data-prnext-source'))return;
  const start=node.node.loc?.start;if(!start)return;
  node.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-prnext-source'),t.stringLiteral(`${id}:${start.line}:${start.column+1}`)));
}}});}

/** The same original JSX locations must be present in SSR and browser output. */
export function createSourceLocationTransform(projectRoot){
  projectRoot=path.resolve(projectRoot);const canonicalRoot=realpath(projectRoot).catch(()=>projectRoot);
  return async(source,filename)=>{
    filename=path.resolve(filename);
    if(!source.includes('<')||filename.includes(`${path.sep}node_modules${path.sep}`)||filename.includes(`${path.sep}.prnext-build-`))return source;
    const root=filename.startsWith(projectRoot+path.sep)?projectRoot:await canonicalRoot;
    if(!filename.startsWith(root+path.sep))return source;
    const id=path.relative(root,filename).split(path.sep).join('/');
    return cachedAsyncTransform('dev-source-elements',source,[root,filename,'v1'],async()=>{
      const result=await transformAsync(source,{filename,babelrc:false,configFile:false,sourceMaps:true,sourceFileName:filename,sourceType:'unambiguous',parserOpts:{plugins:['jsx',...(/\.tsx?$/.test(filename)?['typescript']:[])]},plugins:[sourceElements(id)]});
      return inlineSourceMap(result.code,result.map);
    });
  };
}

/** Keep React renderers and framework contexts identical across rebuilt ESM chunks. */
export function devSingletonsPlugin() {
  return { name: 'prnext-development-singletons', setup(build) {
    build.onLoad({ filter: /\.[cm]?js$/, namespace: 'file' }, async args => {
      const filename = args.path.replaceAll(path.sep, '/');
      if (!/\/node_modules\/(?:react|react-dom|react-refresh|react-server-dom-webpack)\//.test(filename) && !(args.path.startsWith(path.join(packageRoot, 'compat') + path.sep) && args.path.endsWith('.cjs'))) return;
      const source = await readFile(args.path, 'utf8');
      // These packages and adapters expose CommonJS entry points. ESM files are
      // left alone; wrapping their declarations would change module semantics.
      if (!/\b(?:module\.exports|exports\.)/.test(source)) return;
      return { contents: `const __prnextModules=globalThis.__PRNEXT_DEV_MODULES__||=new Map();const __prnextKey=${JSON.stringify(filename)};if(__prnextModules.has(__prnextKey)){module.exports=__prnextModules.get(__prnextKey)}else{\n${source}\n__prnextModules.set(__prnextKey,module.exports);}`, loader: 'js', resolveDir: path.dirname(args.path) };
    });
  } };
}

function componentExports(program) {
  let count = 0;
  for (const statement of program.body) {
    if (statement.type === 'ExportAllDeclaration') return false;
    if (statement.type === 'ExportDefaultDeclaration') {
      count++;
      const value = statement.declaration;
      const name = value.id?.name || (value.type === 'Identifier' ? value.name : '');
      if (!/^[A-Z]/.test(name)) return false;
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue;
    if (statement.source) return false;
    const declaration = statement.declaration;
    const names = declaration?.type === 'VariableDeclaration' ? declaration.declarations.map(item => item.id.name)
      : declaration?.id ? [declaration.id.name] : statement.specifiers.filter(item => item.exportKind !== 'type').map(item => item.local?.name);
    for (const name of names) { count++; if (!name || !/^[A-Z]/.test(name)) return false; }
  }
  return count > 0;
}

/** The official React transform records hook signatures and refresh families. */
export function createRefreshTransform(projectRoot, { generation,forceGeneration=false,forceFiles } = {}) {
  projectRoot = path.resolve(projectRoot);
  const affected=forceFiles&&new Set(forceFiles.map(file=>path.resolve(projectRoot,file)));
  const canonicalRoot = realpath(projectRoot).catch(() => projectRoot);
  return async (source, filename) => {
    filename = path.resolve(filename);
    if (filename.includes(`${path.sep}node_modules${path.sep}`) || filename.includes(`${path.sep}.prnext-build-`)) return source;
    // Bundlers resolve symlinks (including /var -> /private/var on macOS).
    // Compare against both spellings so temporary/linked apps still refresh.
    const root = filename.startsWith(projectRoot + path.sep) ? projectRoot : await canonicalRoot;
    if (!filename.startsWith(root + path.sep)) return source;
    const hash = createHash('sha256').update(source).digest('hex');
    const transformed = await cachedAsyncTransform('fast-refresh',source,[projectRoot,filename,'source-elements-v2'],async () => {
      const id = path.relative(root, filename).replaceAll(path.sep, '/');
      const result = await transformAsync(source, { filename, babelrc: false, configFile: false,
        ast: true, sourceMaps: true, sourceFileName:filename, sourceType: 'unambiguous',
        parserOpts: { plugins: ['jsx', ...(/\.tsx?$/.test(filename) ? ['typescript'] : [])] },
        plugins: [namedDefaultComponents,[refresh, { skipEnvCheck: true, refreshReg: '__prnextRefreshReg', refreshSig: '__prnextRefreshSig' }],sourceElements(id)],
      });
      // An ESM import changes webpack's interpretation of module.exports.
      // Keep script/CommonJS inputs in their original module format.
      const runtime = result.ast.program.sourceType === 'script'
        ? `const{register:__prnextRegister,signature:__prnextRefreshSig,registerModule:__prnextRegisterModule}=require(${JSON.stringify(devClientFile)});`
        : `import{register as __prnextRegister,signature as __prnextRefreshSig,registerModule as __prnextRegisterModule}from ${JSON.stringify(devClientFile)};`;
      const strict = result.ast.program.directives.some(item => item.value.value === 'use strict') ? '"use strict";' : '';
      const prefix = `${strict}${runtime}function __prnextRefreshReg(type,id){__prnextRegister(type,${JSON.stringify(id + ':')}+id)};\n`;
      return inlineSourceMap(prefix + result.code + `\n__prnextRegisterModule(${JSON.stringify(id)},${JSON.stringify(hash)},${componentExports(result.ast.program)});\n`,{...result.map,mappings:';'+result.map.mappings});
    });
    // ESM URLs are cached forever by the browser. A -> B -> exact A otherwise
    // imports an already evaluated content-hashed chunk and never registers A
    // with React Refresh again. Mark project modules per generation, after the
    // persistent transform cache. Keep the marker stable for unchanged modules:
    // esbuild can retain their parsed graph rather than reparsing every route.
    if(!generation)return transformed;
    const identity=refreshIdentities.get(filename);
    if((affected?affected.has(filename):forceGeneration)||!identity||identity.hash!==hash){
      if(refreshIdentities.size>=50_000&&!identity)refreshIdentities.delete(refreshIdentities.keys().next().value);
      refreshIdentities.set(filename,{hash,generation});
    }
    return transformed + `\nglobalThis.__PRNEXT_DEV__.evaluatedGeneration=${JSON.stringify(refreshIdentities.get(filename).generation)};\n`;
  };
}
