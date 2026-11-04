import {generateMapped,sourceMapsEnabled,extractSourceMap,inlineSourceMap} from './source-maps.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import { cachedTransform } from './transform-cache.mjs';

const traverse = traverseModule.default || traverseModule;
const generate = generateModule.default || generateModule;
const serverExports = new Set(['getServerSideProps', 'getStaticProps', 'getStaticPaths']);

/** esbuild uses publicPath for both assets and chunks; Node needs relative chunk imports. */
export function relativeServerChunkImports(source, chunks, publicPath = '/_prnext/assets') {
  const prefix = publicPath.replace(/\/+$/, '') + '/';
  if (!source.includes(prefix)) return source;
  return cachedTransform('chunk-imports',source,[[...chunks].sort(),prefix],()=>relativeChunksUncached(source,chunks,prefix));
}
function relativeChunksUncached(source,chunks,prefix) {
  const edits = [];
  const ast = parse(source, { sourceType: 'module' });
  function rewrite(node) {
    if (!node || !t.isStringLiteral(node) || !node.value.startsWith(prefix)) return;
    const name = node.value.slice(prefix.length);
    if (chunks.has(name)) {edits.push({ start: node.start, end: node.end, text: JSON.stringify('./' + name) });node.value='./'+name;delete node.extra;}
  }
  traverse(ast, {
    ImportDeclaration(path) { rewrite(path.node.source); },
    ExportNamedDeclaration(path) { rewrite(path.node.source); },
    ExportAllDeclaration(path) { rewrite(path.node.source); },
    CallExpression(path) { if (t.isImport(path.node.callee)) rewrite(path.node.arguments[0]); },
  });
  if(edits.length && sourceMapsEnabled() && extractSourceMap(source).map)return generateMapped(generate,ast,{comments:true},source,'bundle.mjs');
  // Replacing only generated specifiers preserves every source line and asset URL.
  for (const edit of edits.sort((left, right) => right.start - left.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

function rewriteChunkSource(source,map,file,chunks,publicPath){
  const result=relativeServerChunkImports(inlineSourceMap(source,map),chunks,publicPath);
  if(map){
    const mapped=extractSourceMap(result);
    return {source:mapped.code.replace(/\/\/[#@]\s*sourceMappingURL=[^\s]+/g,'')+'\n//# sourceMappingURL='+path.basename(file)+'.map\n',map:JSON.stringify({...mapped.map,file:path.basename(file)})};
  }
  return {source:result};
}

/** Rewrite before the first disk write, without modifying compiler/cache buffers. */
export function rewriteServerChunkOutputFiles(files,chunks,publicPath,importers){
  const outputs=new Map(files.map(file=>[path.resolve(file.path),file])),replacements=new Map();
  const replace=(file,source)=>{
    const contents=Buffer.from(source),metadata=Object.getOwnPropertyDescriptors(file);
    // esbuild's hash describes the original buffer. Do not retain a stale hash.
    // Reading/spreading esbuild's lazy text getter would decode the old buffer
    // again and retain that string even though only the new bytes are needed.
    delete metadata.hash;delete metadata.contents;delete metadata.text;
    const output=Object.create(Object.getPrototypeOf(file),metadata);
    Object.defineProperties(output,{contents:{value:contents,writable:true,enumerable:true,configurable:true},text:{get(){return this.contents.toString();},enumerable:true,configurable:true}});
    replacements.set(file,output);
  };
  for(const file of files){
    if(!file.path.endsWith('.mjs')||importers&&!importers.has(path.resolve(file.path)))continue;
    const source=Buffer.from(file.contents.buffer,file.contents.byteOffset,file.contents.byteLength).toString();
    if(!source.includes(publicPath.replace(/\/+$/,'')+'/'))continue;
    const mapFile=sourceMapsEnabled()&&outputs.get(path.resolve(file.path+'.map'));
    const map=mapFile?JSON.parse(Buffer.from(mapFile.contents).toString()):undefined;
    const result=rewriteChunkSource(source,map,file.path,chunks,publicPath);
    if(result.source!==source)replace(file,result.source);
    if(mapFile)replace(mapFile,result.map);
  }
  return files.map(file=>replacements.get(file)||file);
}

export async function rewriteServerChunks(file,chunks,publicPath){
  const source=await readFile(file,'utf8');
  if(!source.includes(publicPath.replace(/\/+$/,'')+'/'))return;
  let map;
  if(sourceMapsEnabled())try{map=JSON.parse(await readFile(file+'.map','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const result=rewriteChunkSource(source,map,file,chunks,publicPath);
  if(map)await writeFile(file+'.map',result.map);
  await writeFile(file,result.source);
}

function parserOptions(filename) {
  return { sourceType: 'unambiguous', sourceFilename: filename, plugins: ['jsx', ...( /\.[cm]?tsx?$/.test(filename) ? ['typescript'] : [])] };
}

export function assertSupportedSource(source, filename) {
  if (!source.includes('use server')) return;
  const ast = parse(source, parserOptions(filename));
  traverse(ast, {
    Directive(path) {
      if (path.node.value.value === 'use server') throw new Error(`Server Actions ("use server") are not supported in the Pages Router: ${filename}. Move this action to app/ or use pages/api.`);
    },
  });
}

/** Strip loader exports and the now-unused dependency graph before esbuild sees a browser page. */
export function stripServerCode(source, filename = 'page.tsx') {
  return cachedTransform('pages-strip',source,[filename],()=>stripServerCodeUncached(source,filename));
}

function stripServerCodeUncached(source, filename) {
  const ast = parse(source, parserOptions(filename));
  let program;
  traverse(ast, { Program(path) { program = path; path.stop(); } });
  const candidates = new Set();
  const loaders = new Set();
  const exportPaths = [];

  function collect(binding) {
    if (!binding || binding.scope !== program.scope || candidates.has(binding.identifier.name)) return;
    candidates.add(binding.identifier.name);
    binding.path.traverse({
      ReferencedIdentifier(ref) { collect(ref.scope.getBinding(ref.node.name)); },
    });
  }

  for (const statement of program.get('body')) {
    if (!statement.isExportNamedDeclaration()) continue;
    const declaration = statement.get('declaration');
    if (declaration?.node) {
      for (const name of Object.keys(t.getBindingIdentifiers(declaration.node))) {
        if (serverExports.has(name)) { loaders.add(name); collect(program.scope.getBinding(name)); }
      }
    }
    for (const specifier of statement.get('specifiers')) {
      const exported = specifier.node.exported?.name ?? specifier.node.exported?.value;
      if (!serverExports.has(exported)) continue;
      if (specifier.node.local) {
        loaders.add(specifier.node.local.name);
        collect(program.scope.getBinding(specifier.node.local.name));
      }
      exportPaths.push(specifier);
    }
  }

  for (const specifier of exportPaths) {
    const declaration = specifier.parentPath;
    specifier.remove();
    if (!declaration.node.specifiers.length && !declaration.node.declaration) declaration.remove();
  }
  for (const name of loaders) {
    const binding = program.scope.getBinding(name);
    if (!binding) continue;
    if (binding.path.isImportSpecifier() || binding.path.isImportDefaultSpecifier() || binding.path.isImportNamespaceSpecifier()) {
      const declaration = binding.path.parentPath;
      binding.path.remove();
      if (!declaration.node.specifiers.length) declaration.remove();
    } else if (binding.path.isVariableDeclarator()) {
      const declaration = binding.path.parentPath;
      if (declaration.node.declarations.length === 1 && declaration.parentPath.isExportNamedDeclaration()) declaration.parentPath.remove();
      else binding.path.remove();
    } else if (binding.path.parentPath.isExportNamedDeclaration()) binding.path.parentPath.remove();
    else binding.path.remove();
  }

  // Iteration matters: deleting an unused helper can make its database import unused.
  let changed = true;
  while (changed) {
    changed = false;
    program.scope.crawl();
    for (const name of candidates) {
      const binding = program.scope.getBinding(name);
      if (!binding || binding.referenced) continue;
      const declaration = binding.path;
      if (declaration.isImportSpecifier() || declaration.isImportDefaultSpecifier() || declaration.isImportNamespaceSpecifier()) {
        const parent = declaration.parentPath;
        declaration.remove();
        if (!parent.node.specifiers.length) parent.remove();
      } else if (declaration.isVariableDeclarator()) {
        // A destructuring pattern may contain bindings still used by the page.
        const names = Object.keys(t.getBindingIdentifiers(declaration.node.id));
        if (names.some(id => program.scope.getBinding(id)?.referenced)) continue;
        declaration.remove();
      } else if (declaration.isFunctionDeclaration() || declaration.isClassDeclaration()) declaration.remove();
      else continue;
      changed = true;
    }
  }
  // A star export cannot be safely classified without evaluating another module.
  if (program.get('body').some(statement => statement.isExportAllDeclaration())) {
    throw new Error(`Wildcard re-exports in a page are not supported: ${filename}. Explicitly export the page and its data loaders so server code can be excluded from the browser.`);
  }
  return generateMapped(generate, ast, { comments: true }, source, filename);
}
