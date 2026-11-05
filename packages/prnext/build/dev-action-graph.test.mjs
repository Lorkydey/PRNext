import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {developmentActionMetadata} from './dev-action-graph.mjs';
import {recordDevDependencies,developmentDependencies,developmentModules} from './dev-dependencies.mjs';
import {createServerActions} from './actions.mjs';

const root=path.resolve('action-graph-project');
const action=(file='actions.js',binding='save',id='1'.repeat(64))=>({id,file:path.join(root,file),binding,runtimes:new Set(['nodejs'])});
test('Action provenance is bounded, relative and contains no source, arguments or encryption key',()=>{
  assert.deepEqual(developmentActionMetadata(root,[action()]),{version:1,complete:true,actions:[{id:'1'.repeat(64),file:'actions.js',binding:'save',runtimes:['nodejs']}]});
  for(const invalid of [{...action(),file:path.resolve(root,'../external.js')},{...action(),file:path.join(root,'node_modules/pkg/index.js')},{...action(),id:'bad'},{...action(),runtimes:new Set(['other'])}])assert.equal(developmentActionMetadata(root,[invalid]).complete,false);
  assert.equal(developmentActionMetadata(root,[action(),action('actions.js','save','2'.repeat(64))]).complete,false);
});
test('merged RSC/browser imports connect Action helpers and shared importers to the precise route closure',()=>{
  const state={root,stage:path.join(root,'.stage'),dev:true};
  const record=inputs=>recordDevDependencies(state,{absWorkingDir:root},{metafile:{inputs,outputs:{}}});
  // RSC replaces the client boundary; the browser replaces the Action body.
  record({'app/a/page.jsx':{imports:[{path:'components/A.jsx'}]},'components/A.jsx':{imports:[]},'actions.js':{imports:[{path:'shared.js'}]},'shared.js':{imports:[{path:'leaf.js'}]},'leaf.js':{imports:[]}});
  record({'components/A.jsx':{imports:[{path:'actions.js'}]},'components/B.jsx':{imports:[{path:'actions.js'}]},'actions.js':{imports:[]},'app/b/page.jsx':{imports:[{path:'components/B.jsx'}]},'app/c/page.jsx':{imports:[]}});
  const project={root,routes:['a','b','c'].map(id=>({id,file:path.join(root,`app/${id}/page.jsx`)}))};
  const routes=developmentDependencies(state,project,{routes:project.routes.map(({id})=>({id,pattern:'/'+id}))});
  assert.deepEqual(routes.filter(route=>route.files.includes('leaf.js')).map(route=>route.route),['/a','/b']);
  assert.ok(developmentModules(state,root).find(record=>record.route==='actions.js').files.includes('shared.js'));
});
test('actual Action transforms change only the edited owner identities in one development session',()=>{
  const create=()=>createServerActions({projectRoot:root,developmentSession:'test-session',developmentSecret:Buffer.alloc(32,7).toString('base64')});
  const before=create(),after=create();
  for(const [name,version]of [['a',1],['b',1]])before.transform(`'use server';export async function save(){return ${version}}`,path.join(root,name+'.js'),'rsc');
  for(const [name,version]of [['a',2],['b',1]])after.transform(`'use server';export async function save(){return ${version}}`,path.join(root,name+'.js'),'rsc');
  const old=developmentActionMetadata(root,before.actions.values()),next=developmentActionMetadata(root,after.actions.values());
  assert.equal(old.complete,true);assert.equal(next.complete,true);assert.notEqual(old.actions[0].id,next.actions[0].id);assert.equal(old.actions[1].id,next.actions[1].id);
});
