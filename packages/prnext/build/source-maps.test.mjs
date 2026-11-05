import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceMap} from 'node:module';
import {transform} from 'esbuild';
import {withSourceMaps,configureSourceMaps,extractSourceMap,inlineSourceMap} from './source-maps.mjs';
import {stripServerCode} from './transform.mjs';
import {transformDynamicImports} from './dynamic.mjs';
import {createRefreshTransform} from './dev.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {rewriteServerChunks,rewriteServerChunkOutputFiles} from './transform.mjs';
import {withCompilation,configureCompiler} from './compiler.mjs';
import {compileEdge} from './edge.mjs';

function locate(code,needle){const position=code.indexOf(needle);assert.ok(position>=0,needle);const lines=code.slice(0,position).split('\n');return [lines.length-1,lines.at(-1).length];}
test('Pages stripping, dynamic imports, Fast Refresh and esbuild map back to the original TSX line',async()=>withSourceMaps(async()=>{
  configureSourceMaps(true);
  const file='/project/page.tsx';
  const source=`import dynamic from 'next/dynamic';\nconst Lazy=dynamic(()=>import('./lazy'));\nexport const getServerSideProps=async()=>({props:{}});\n\nexport default function Page(){\n  throw new Error('original failure');\n  return <Lazy/>;\n}`;
  let code=transformDynamicImports(source,file,{projectRoot:'/project',mode:'browser'});
  code=stripServerCode(code,file);
  code=await createRefreshTransform('/project')(code,file);
  const result=await transform(code,{loader:'tsx',sourcefile:file,sourcemap:'external',minify:true});
  const entry=new SourceMap(JSON.parse(result.map)).findEntry(...locate(result.code,'original failure'));
  assert.equal(entry.originalSource,file);assert.equal(entry.originalLine,5);
  assert.ok(JSON.parse(result.map).sourcesContent.includes(source));
}));

test('server chunk rewrites retain original columns and update their external map',async t=>withSourceMaps(async()=>{
  configureSourceMaps(true);
  const root=await mkdtemp(path.join(tmpdir(),'prnext-chunk-maps-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'entry.mjs'),original='/project/server.ts';
  const result=await transform(`import {value} from '/_prnext/assets/chunk.mjs';\nthrow new Error('chunk mapping failure');`,{sourcefile:original,format:'esm',sourcemap:'external'});
  await writeFile(file,result.code);await writeFile(file+'.map',result.map);
  await rewriteServerChunks(file,new Set(['chunk.mjs']),'/_prnext/assets');
  const code=await readFile(file,'utf8');assert.match(code,/\.\/chunk\.mjs/);
  const map=new SourceMap(JSON.parse(await readFile(file+'.map','utf8')));
  const entry=map.findEntry(...locate(code,'chunk mapping failure'));
  assert.equal(entry.originalSource,original);assert.equal(entry.originalLine,1);
}));

test('in-memory chunk rewrites preserve external source maps and never mutate shared output buffers',async()=>withSourceMaps(async()=>{
  configureSourceMaps(true);
  const file=path.resolve('virtual-output/entry.mjs'),original='/project/original.ts';
  const result=await transform(`import {value} from '/base/_prnext/assets/chunk.mjs';\nconst asset='/base/_prnext/assets/picture.png';\nthrow new Error('mapped buffer failure');`,{sourcefile:original,format:'esm',sourcemap:'external'});
  const files=[{path:file,contents:Buffer.from(result.code),hash:'original'},{path:file+'.map',contents:Buffer.from(result.map),hash:'map-original'},{path:path.resolve('virtual-output/picture.png'),contents:Buffer.from('image'),hash:'asset'}];
  const originals=files.map(item=>Buffer.from(item.contents));
  const rewritten=rewriteServerChunkOutputFiles(files,new Set(['chunk.mjs']),'/base/_prnext/assets',new Set([file]));
  assert.notEqual(rewritten[0],files[0]);assert.notEqual(rewritten[1],files[1]);assert.equal(rewritten[2],files[2]);assert.equal(rewritten[0].hash,undefined);
  assert.match(rewritten[0].text,/\.\/chunk\.mjs/);assert.match(rewritten[0].text,/\/base\/_prnext\/assets\/picture\.png/);
  const map=new SourceMap(JSON.parse(rewritten[1].text)),entry=map.findEntry(...locate(rewritten[0].text,'mapped buffer failure'));
  assert.equal(entry.originalSource,original);assert.equal(entry.originalLine,2);
  assert.equal(JSON.parse(rewritten[1].text).file,'entry.mjs');
  for(let i=0;i<files.length;i++)assert.deepEqual(files[i].contents,originals[i]);
  const replay=rewriteServerChunkOutputFiles(files,new Set(['chunk.mjs']),'/base/_prnext/assets',new Set([file]));assert.deepEqual(replay.map(item=>item.contents),rewritten.map(item=>item.contents));
  assert.deepEqual(rewriteServerChunkOutputFiles(files,new Set(['chunk.mjs']),'/base/_prnext/assets',new Set()),files);
}));

test('in-memory chunks without source maps rewrite only generated module specifiers',()=>withSourceMaps(()=>{
  configureSourceMaps(false);
  const source=`export {x} from '/_prnext/assets/a.mjs';const lazy=import('/_prnext/assets/b.mjs');const asset='/_prnext/assets/a.mjs';`;
  const file={path:path.resolve('entry.mjs'),contents:Buffer.from(source),get text(){throw new Error('The original text getter must not be evaluated.');}};
  const [rewritten]=rewriteServerChunkOutputFiles([file],new Set(['a.mjs','b.mjs']),'/_prnext/assets');
  assert.match(rewritten.text,/from "\.\/a\.mjs"/);assert.match(rewritten.text,/import\("\.\/b\.mjs"\)/);assert.match(rewritten.text,/const asset='\/_prnext\/assets\/a\.mjs'/);assert.equal(file.contents.toString(),source);
}));

test('Edge async factories retain source maps after export removal and require validation',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-edge-maps-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'route.js'),stage=path.join(root,'stage');await mkdir(stage);
  await writeFile(file,`export const kind=typeof require;\nexport function GET(){throw new Error('edge mapped failure')}`);
  await withCompilation(async()=>{
    configureCompiler({root,stage,dev:true,config:{}});
    await compileEdge({file,outfile:path.join(stage,'server','route.mjs'),projectRoot:root,dev:true});
  });
  const source=await readFile(path.join(stage,'server','route.edge.js'),'utf8'),mapped=extractSourceMap(source);
  const entry=new SourceMap(mapped.map).findEntry(...locate(source,'edge mapped failure'));
  assert.equal(entry.originalSource,file);assert.equal(entry.originalLine,1);
});

test('input loader mappings survive framework AST transformations and separate cache modes',async()=>withSourceMaps(async()=>{
  const file='/project/generated.js',code=`\n\nexport default function Page(){throw new Error('mapped loader failure')}`;
  const input=inlineSourceMap(code,{version:3,sources:['/project/original.template'],sourcesContent:['\n'.repeat(7)+'original template'],names:[],mappings:';;AAOA'});
  configureSourceMaps(false);assert.equal(extractSourceMap(stripServerCode(code,file)).map,undefined);
  configureSourceMaps(true);
  const mapped=stripServerCode(input,file);
  const result=await transform(mapped,{loader:'js',sourcefile:file,sourcemap:'external'});
  const entry=new SourceMap(JSON.parse(result.map)).findEntry(...locate(result.code,'mapped loader failure'));
  assert.equal(entry.originalSource,'/project/original.template');assert.equal(entry.originalLine,7);
  assert.ok(extractSourceMap(stripServerCode(code,file)).map,'plain cached transform does not hide the mapped result');
}));
