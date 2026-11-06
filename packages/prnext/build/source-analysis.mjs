import {parseSync} from 'oxc-parser';
import {createHash} from 'node:crypto';
import parserPackage from 'oxc-parser/package' with {type:'json'};
import {cachedValidatedTransform} from './transform-cache.mjs';

// Read-only analyses share one Rust parse. Transformations still use Babel's
// binding-aware AST: ESTree nodes must never be passed to Babel transforms.
const cache=new Map();
let bytes=0,hits=0,misses=0;
const summaries=new Map();
let summaryBytes=0,summaryHits=0,summaryMisses=0,summaryReplays=0;
const SUMMARY_BYTES=8*1024*1024,SUMMARY_ENTRIES=4096,SUMMARY_ITEM=128*1024;
export const sourceAnalysisStats=()=>({entries:cache.size,bytes,hits,misses,
  summaries:{entries:summaries.size,bytes:summaryBytes,hits:summaryHits,misses:summaryMisses,replays:summaryReplays}});
const summaryFields=['directives','imports','computedRequire','hasServerDirective','runtimeExports','exportStars','frameworkBoundary'];
const text=value=>typeof value==='string'&&value.length<=32768;
const texts=value=>Array.isArray(value)&&value.length<=4096&&value.every(text);
function validSummary(value){
  return value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===summaryFields.length
    &&summaryFields.every(name=>Object.hasOwn(value,name))&&texts(value.directives)&&texts(value.runtimeExports)&&texts(value.exportStars)
    &&['computedRequire','hasServerDirective','frameworkBoundary'].every(name=>typeof value[name]==='boolean')
    &&Array.isArray(value.imports)&&value.imports.length<=4096&&value.imports.every(item=>item&&Object.getPrototypeOf(item)===Object.prototype
      &&Object.keys(item).length===2&&text(item.path)&&['import-statement','dynamic-import','require-call'].includes(item.kind));
}
function immutableSummary(value){
  return Object.freeze({directives:Object.freeze([...value.directives]),imports:Object.freeze(value.imports.map(item=>Object.freeze({path:item.path,kind:item.kind}))),
    computedRequire:value.computedRequire,hasServerDirective:value.hasServerDirective,runtimeExports:Object.freeze([...value.runtimeExports]),
    exportStars:Object.freeze([...value.exportStars]),frameworkBoundary:value.frameworkBoundary});
}

/** Pure, versioned facts only: no AST, source, resolver, registry or generation. */
export function analyzeSourceSummary(source,file='source.js'){
  const digest=createHash('sha256').update(source).digest('hex'),key=file+'\0'+digest;
  const found=summaries.get(key);
  if(found){summaries.delete(key);summaries.set(key,found);summaryHits++;return found.value;}
  summaryMisses++;
  let produced=false,producedAnalysis;
  const validate=raw=>{
    if(typeof raw!=='string'||Buffer.byteLength(raw)>SUMMARY_ITEM)return false;
    const record=JSON.parse(raw);
    return record&&Object.keys(record).length===5&&record.version===1&&record.parser===parserPackage.version
      &&record.file===file&&record.digest===digest&&validSummary(record.analysis);
  };
  const produce=()=>{
    produced=true;
    const analysis=producedAnalysis=analyzeSource(source,file);
    return JSON.stringify({version:1,parser:parserPackage.version,file,digest,analysis:Object.fromEntries(summaryFields.map(name=>[name,analysis[name]]))});
  };
  // Oversized summaries remain ordinary uncached parses, preserving the old
  // accepted input surface without weakening bounded disk/memory retention.
  let raw,value;
  try{raw=cachedValidatedTransform('source-summary',source,[file,parserPackage.version,'v1'],validate,produce);value=JSON.parse(raw).analysis;}
  catch(error){if(error?.message!=='Invalid typed compiler cache result')throw error;value=Object.fromEntries(summaryFields.map(name=>[name,producedAnalysis[name]]));}
  if(!produced)summaryReplays++;
  const immutable=immutableSummary(value),size=Buffer.byteLength(JSON.stringify(value))*2+Buffer.byteLength(key)*2;
  if(size<=SUMMARY_ITEM){
    while(summaries.size&&(summaries.size>=SUMMARY_ENTRIES||summaryBytes+size>SUMMARY_BYTES)){const[old,entry]=summaries.entries().next().value;summaries.delete(old);summaryBytes-=entry.size;}
    summaries.set(key,{value:immutable,size});summaryBytes+=size;
  }
  return immutable;
}
const identifier=(node,name)=>node?.type==='Identifier'&&(name===undefined||node.name===name);
const property=node=>node?.computed?node.property?.value:node?.property?.name;
const moduleExports=node=>node?.type==='MemberExpression'&&identifier(node.object,'module')&&property(node)==='exports';
function bindingNames(node,names){
  if(!node)return;
  if(identifier(node))names.add(node.name);
  else if(node.type==='ObjectPattern')for(const item of node.properties)bindingNames(item.type==='RestElement'?item.argument:item.value,names);
  else if(node.type==='ArrayPattern')for(const item of node.elements)bindingNames(item,names);
  else if(node.type==='RestElement')bindingNames(node.argument,names);
  else if(node.type==='AssignmentPattern')bindingNames(node.left,names);
}
function runtimeDeclaration(node,names){
  if(!node||node.declare)return;
  if(node.type==='VariableDeclaration')for(const item of node.declarations)bindingNames(item.id,names);
  else if(['FunctionDeclaration','ClassDeclaration','TSEnumDeclaration','TSModuleDeclaration'].includes(node.type))bindingNames(node.id,names);
}
export function analyzeSource(source,file='source.js') {
  const key=file+'\0'+createHash('sha256').update(source).digest('hex');
  if(cache.has(key)){const hit=cache.get(key);cache.delete(key);cache.set(key,hit);hits++;return hit.value;}
  misses++;
  // Custom loaders also return JSX under their original asset filenames (for
  // example .svg). Match the compiler's JSX fallback for non-TypeScript inputs,
  // preserving TypeScript's extension rules, including angle assertions in .ts.
  const parsed=parseSync(file,source,{sourceType:'unambiguous',allowReturnOutsideFunction:true,...(/\.(?:[cm]?ts|tsx)$/.test(file)?{}:{lang:'jsx'})});
  if(parsed.errors.length)throw new SyntaxError(`${file}: ${parsed.errors.map(error=>error.message).join('; ')}`);
  const program=parsed.program,directives=[];
  for(const node of program.body){if(!node.directive)break;directives.push(node.directive);}
  const imports=[],runtimeExports=new Set(),exportStars=[];
  for(const node of program.body){
    if(node.exportKind==='type')continue;
    if(node.type==='ExportDefaultDeclaration'&&!node.declaration?.declare&&!['TSInterfaceDeclaration','TSTypeAliasDeclaration'].includes(node.declaration?.type))runtimeExports.add('default');
    if(node.type==='ExportNamedDeclaration'){
      runtimeDeclaration(node.declaration,runtimeExports);
      for(const item of node.specifiers)if(item.exportKind!=='type')runtimeExports.add(item.exported.name??item.exported.value);
    }
    if(node.type==='ExportAllDeclaration'){
      if(node.exported)runtimeExports.add(node.exported.name??node.exported.value);
      else exportStars.push(node.source.value);
    }
  }
  let computedRequire=false,hasServerDirective=false;
  const pending=[program];
  while(pending.length){
    const node=pending.pop();
    if(node.directive==='use server')hasServerDirective=true;
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source&&node.importKind!=='type'&&node.exportKind!=='type')imports.push({path:node.source.value,kind:'import-statement'});
    if(node.type==='ImportExpression'&&typeof node.source?.value==='string')imports.push({path:node.source.value,kind:'dynamic-import'});
    if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='require'){
      const argument=node.arguments[0];
      if(argument?.type==='Literal'&&typeof argument.value==='string')imports.push({path:argument.value,kind:'require-call'});else computedRequire=true;
    }
    if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&identifier(node.callee.object,'Object')&&property(node.callee)==='defineProperty'&&identifier(node.arguments[0],'exports')&&typeof node.arguments[1]?.value==='string'&&node.arguments[1].value!=='__esModule'){
      runtimeExports.add('default');runtimeExports.add(node.arguments[1].value);
    }
    if(node.type==='AssignmentExpression'&&node.left.type==='MemberExpression'){
      const left=node.left;
      if(moduleExports(left)){
        runtimeExports.add('default');
        if(node.right.type==='ObjectExpression')for(const item of node.right.properties){
          const key=item.computed?item.key?.value:item.key?.name??item.key?.value;
          if(typeof key==='string')runtimeExports.add(key);
        }
      }
      if(identifier(left.object,'exports')||moduleExports(left.object)){
        runtimeExports.add('default');if(typeof property(left)==='string')runtimeExports.add(property(left));
      }
    }
    for(const value of Object.values(node)){
      if(Array.isArray(value)){for(let i=value.length-1;i>=0;i--)if(value[i]?.type)pending.push(value[i]);}
      else if(value&&typeof value==='object'&&value.type)pending.push(value);
    }
  }
  runtimeExports.delete('__esModule');
  const value=Object.freeze({program,directives:Object.freeze(directives),imports:Object.freeze(imports.map(Object.freeze)),computedRequire,hasServerDirective,
    runtimeExports:Object.freeze([...runtimeExports]),exportStars:Object.freeze(exportStars),frameworkBoundary:directives.some(item=>item==='use client'||item==='use server')});
  // ASTs are substantially larger than source. Bound both count and estimated
  // retained size; large individual npm modules are analyzed without retention.
  const size=Buffer.byteLength(source)*16+Buffer.byteLength(file);
  if(size<=4*1024*1024){
    while(cache.size&&(cache.size>=64||bytes+size>16*1024*1024)){const [old,hit]=cache.entries().next().value;cache.delete(old);bytes-=hit.size;}
    cache.set(key,{value,size});bytes+=size;
  }
  return value;
}
