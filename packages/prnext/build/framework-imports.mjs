import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
import {analyzeSource} from './source-analysis.mjs';
import {cachedTransform} from './transform-cache.mjs';
const adapters = new Map([
  ['dist/shared/lib/router-context.shared-runtime','next-router-context'],
  ['dist/shared/lib/router-context','next-router-context'],
  ['dist/shared/lib/app-router-context.shared-runtime','next-app-router-context'],
]);
// Keep the historical import alias for existing applications. npm's scoped
// package name adds a slash of its own, so strip the entire package prefix.
export const frameworkPackages = ['next', 'prnext', '@thomas.f/prnext'];
export const frameworkImportPattern = /^(?:next|prnext|@thomas\.f\/prnext)(?:\/|$)/;
export const frameworkSubpathPattern = /^(?:next|prnext|@thomas\.f\/prnext)\//;
export const frameworkRuntimeImportPattern = /^(?:next(?:\/|$)|(?:prnext|@thomas\.f\/prnext)\/)/;
// Only explicit, tested private contracts are adapted. Unknown internals still
// fail instead of silently importing a second framework runtime from npm.
export function frameworkImportName(specifier) {
  const name=specifier.replace(frameworkSubpathPattern, '').replace(/\.js$/,'');
  return adapters.get(name) || name;
}

// Application graphs must not traverse the programmatic build API's native tools.
// Outside a compiled application, the package root retains its full Node API.
export function applicationEntry(builder,readSource=(file,override)=>override??readFile(file,'utf8')){
  // esbuild understands .mts/.cts, but our framework transforms do not. Never
  // silently bundle a server implementation or misclassify a client boundary.
  builder.onLoad({filter:/\.[cm]ts$/i,namespace:'file'},async args=>{
    // Loader bridges dispatch framework callbacks independently of their filters.
    if(!/\.[cm]ts$/i.test(args.path))return;
    const source=await readSource(args.path,args.prnextSource);
    const original=args.prnextSource===undefined?source:await readSource(args.path);
    // A loader may remove a directive as well as introduce one. Both versions
    // must be safe before its output can become an ordinary browser module.
    for(const candidate of new Set([original,source])){
     const unsupported=cachedTransform('unsupported-framework-directives',candidate,[args.path,'v3'],()=>{
      const analysis=analyzeSource(candidate,args.path);
      if(analysis.frameworkBoundary)return 'yes';
      const pending=[analysis.program];
      while(pending.length){
        const node=pending.pop();
        if(node.type==='ExpressionStatement'&&node.directive==='use server')return 'yes';
        for(const value of Object.values(node)){
          if(Array.isArray(value)){for(const item of value)if(item?.type)pending.push(item);}
          else if(value&&typeof value==='object'&&value.type)pending.push(value);
        }
      }
      return 'no';
     });
     if(unsupported==='yes')throw new Error(`React server/client directives are not supported in ${args.path}. Rename this file to .ts or .tsx.`);
    }
    return {contents:source,loader:args.prnextSource===undefined?'ts':'tsx',resolveDir:dirname(args.path)};
  });
  builder.onResolve({filter:/^(?:prnext|@thomas\.f\/prnext)(?:\/route(?:\.js)?)?$/},()=>
    ({path:fileURLToPath(new URL('../runtime/typed-route.mjs',import.meta.url))}));
}
