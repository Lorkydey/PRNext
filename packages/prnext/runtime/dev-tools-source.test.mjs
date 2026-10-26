import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,symlink } from 'node:fs/promises';
import path from 'node:path';
import { createDevSourceTools } from './dev-tools-source.mjs';

async function fixture(t){const root=await mkdtemp(path.resolve('.prnext-source-test-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));await mkdir(path.join(root,'components'));await writeFile(path.join(root,'components/Counter.jsx'),'export default function Counter(){\n  throw new Error("broken");\n}\n');return {root,tools:createDevSourceTools(root)};}
test('source excerpts and editor URLs use original local files without shell execution',async t=>{
 const {root,tools}=await fixture(t),result=await tools.source({source:'components/Counter.jsx:2:3'});
 assert.equal(result.file,'components/Counter.jsx');assert.equal(result.line,2);assert.equal(result.column,3);assert.equal(result.mapped,false);assert.match(result.frame,/>\s+2 \|\s+throw new Error/);assert.equal(result.excerpt[1].line,2);
 const cursor=await tools.editor({file:result.file,line:2,column:3,editor:'cursor'});assert.match(cursor.editorUrl,/^cursor:\/\/file\//);assert.ok(cursor.editorUrl.includes('Counter.jsx:2:3'));
 await assert.rejects(tools.editor({file:result.file,editor:'powershell -c anything'}),/VS Code or Cursor/);
 await assert.rejects(tools.source({file:path.resolve(root,'../outside.jsx')}),/No original/);
});
test('source lookup follows generated browser maps and ignores framework/external frames',async t=>{
 const {root,tools}=await fixture(t);await mkdir(path.join(root,'.prnext/assets'),{recursive:true});
 await writeFile(path.join(root,'.prnext/assets/chunk-example.js'),'// bundled\nthrow Error("broken");\n');
 await writeFile(path.join(root,'.prnext/assets/chunk-example.js.map'),JSON.stringify({version:3,file:'chunk-example.js',sources:['../../components/Counter.jsx'],sourcesContent:['export default function Counter(){\n  throw new Error("original running build");\n}\n'],names:[],mappings:'AAAA;AACA;AACA'}));
 const result=await tools.source({stack:'Error: broken\n    at internal (http://127.0.0.1:3000/framework.js:100:2)\n    at Counter (http://127.0.0.1:3000/docs/_prnext/assets/chunk-example.js:2:1)'});
 assert.equal(result.file,'components/Counter.jsx');assert.equal(result.line,2);assert.equal(result.mapped,true);assert.match(result.frame,/original running build/,'the frame belongs to the evaluated build even when the current file has changed');
});
test('secrets, dependencies, external symlinks and malicious map targets are inaccessible',async t=>{
 const {root,tools}=await fixture(t);for(const file of ['.env','secrets/data.json','node_modules/secret/index.js']){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),'private');await assert.rejects(tools.source({file}),/No original/);}
 await writeFile(path.join(root,'components/outside.jsx'),'placeholder');
 const external=await mkdtemp(path.resolve('.prnext-outside-test-'));t.after(()=>rm(external,{recursive:true,force:true}));await writeFile(path.join(external,'Hidden.jsx'),'secret');
 await symlink(external,path.join(root,'external'),'junction');await assert.rejects(tools.source({file:'external/Hidden.jsx'}),/No original/);
 await mkdir(path.join(root,'.prnext/assets'),{recursive:true});await writeFile(path.join(root,'.prnext/assets/bad.js'),'x');await writeFile(path.join(root,'.prnext/assets/bad.js.map'),JSON.stringify({version:3,sources:[path.join(external,'Hidden.jsx')],names:[],mappings:'AAAA'}));await assert.rejects(tools.source({url:'http://127.0.0.1:3000/_prnext/assets/bad.js',line:1,column:1}),/No original/);
});
test('generated capabilities and custom dist files stay private through aliases',async t=>{
 const {root,tools}=await fixture(t);await mkdir(path.join(root,'.prnext-dev'),{recursive:true});await writeFile(path.join(root,'.prnext-dev/tools.json'),'{"token":"local-only"}');await symlink(path.join(root,'.prnext-dev/tools.json'),path.join(root,'components/alias.json'),'file');
 for(const file of ['.prnext-dev/tools.json','components/alias.json'])await assert.rejects(tools.source({file}),/No original/);
 await writeFile(path.join(root,'.prnext-output.json'),'{"distDir":"output"}');await mkdir(path.join(root,'output'));await writeFile(path.join(root,'output/manifest.json'),'{"token":"hidden"}');await assert.rejects(tools.source({file:'output/manifest.json'}),/No original/);
});
