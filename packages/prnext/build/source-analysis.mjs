import {parseSync} from 'oxc-parser';
import {createHash} from 'node:crypto';

// Read-only analyses share one Rust parse. Transformations still use Babel's
// binding-aware AST: ESTree nodes must never be passed to Babel transforms.
const cache=new Map();
let bytes=0,hits=0,misses=0;
export const sourceAnalysisStats=()=>({entries:cache.size,bytes,hits,misses});
export function analyzeSource(source,file='source.js') {
  const key=file+'\0'+createHash('sha256').update(source).digest('hex');
  if(cache.has(key)){const hit=cache.get(key);cache.delete(key);cache.set(key,hit);hits++;return hit.value;}
  misses++;
  const parsed=parseSync(file,source,{sourceType:'unambiguous',allowReturnOutsideFunction:true});
  if(parsed.errors.length)throw new SyntaxError(`${file}: ${parsed.errors.map(error=>error.message).join('; ')}`);
  const program=parsed.program,directives=[];
  for(const node of program.body){if(!node.directive)break;directives.push(node.directive);}
  const imports=[];
  let computedRequire=false;
  const pending=[program];
  while(pending.length){
    const node=pending.pop();
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source&&node.importKind!=='type'&&node.exportKind!=='type')imports.push({path:node.source.value,kind:'import-statement'});
    if(node.type==='ImportExpression'&&typeof node.source?.value==='string')imports.push({path:node.source.value,kind:'dynamic-import'});
    if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='require'){
      const argument=node.arguments[0];
      if(argument?.type==='Literal'&&typeof argument.value==='string')imports.push({path:argument.value,kind:'require-call'});else computedRequire=true;
    }
    for(const value of Object.values(node)){
      if(Array.isArray(value)){for(let i=value.length-1;i>=0;i--)if(value[i]?.type)pending.push(value[i]);}
      else if(value&&typeof value==='object'&&value.type)pending.push(value);
    }
  }
  const value={program,directives,imports,computedRequire,frameworkBoundary:directives.some(item=>item==='use client'||item==='use server')};
  // ASTs are substantially larger than source. Bound both count and estimated
  // retained size; large individual npm modules are analyzed without retention.
  const size=Buffer.byteLength(source)*16+Buffer.byteLength(file);
  if(size<=4*1024*1024){
    while(cache.size&&(cache.size>=64||bytes+size>16*1024*1024)){const [old,hit]=cache.entries().next().value;cache.delete(old);bytes-=hit.size;}
    cache.set(key,{value,size});bytes+=size;
  }
  return value;
}
