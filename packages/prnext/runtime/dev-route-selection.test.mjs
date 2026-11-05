import test from 'node:test';
import assert from 'node:assert/strict';
import {selectiveDevelopmentRoutes,canSkipDevelopmentUpdate} from './dev-route-selection.mjs';

const id = n => String(n).repeat(64);
function manifest() {
  return { config:{basePath:'/docs'}, customRoutes:{}, routes:[{id:'a',pattern:'/a',kind:'page',client:'/old.js'},{id:'b',pattern:'/b',kind:'page'}],
    app:{actions:{[id(1)]:{},[id(2)]:{}},actionKey:'private-session-key'},devDependencyStatus:{complete:true},
    devModules:[{route:'app/a/actions.js'},{route:'app/b/actions.js'}],
    devDependencies:[{route:'/a',files:['app/a/actions.js']},{route:'/b',files:['app/b/actions.js']}],
    devActions:{version:1,complete:true,actions:[{id:id(1),file:'app/a/actions.js',binding:'save',runtimes:['nodejs']},{id:id(2),file:'app/b/actions.js',binding:'save',runtimes:['nodejs']}]}};
}
const selection = () => ({changed:['app/a/actions.js'],affectedRoutes:['/a'],affectedModules:['app/a/actions.js'],nextAffected:{complete:true,unknown:[],routes:['/a'],modules:['app/a/actions.js']}});
test('changed Action implementation targets its importers while other Action IDs stay valid',()=>{
  const old=manifest(),next=manifest();delete next.app.actions[id(1)];next.app.actions[id(3)]={};next.devActions.actions[0].id=id(3);next.routes[0].client='/new.js';
  assert.deepEqual(selectiveDevelopmentRoutes(old,next,selection()),['/a']);
  assert.equal(next.devActions.actions[1].id,old.devActions.actions[1].id);
});
test('old and new dependency closures are united for removed, new and shared imports',()=>{
  const input=selection();input.affectedRoutes=['/b'];input.nextAffected.routes=['/a'];
  assert.deepEqual(selectiveDevelopmentRoutes(manifest(),manifest(),input),['/a','/b']);
});
test('unknown, unpublished, saturated and global changes never certify a selection',()=>{
  const cases=[input=>input.nextAffected=undefined,input=>input.nextAffected.complete=false,input=>input.nextAffected.unknown=['new.js'],input=>input.affectedRoutes=undefined,input=>input.changed=[],
    ...['prnext.config.mjs','.env.local','src/middleware.ts','proxy.js','tsconfig.json','package.json','pnpm-lock.yaml','app/global-error.jsx'].map(file=>input=>input.changed=[file])];
  for(const change of cases){const input=selection();change(input);assert.equal(selectiveDevelopmentRoutes(manifest(),manifest(),input),undefined);}
  for(const side of ['old','next']){const old=manifest(),next=manifest();({old,next})[side].devDependencyStatus.complete=false;assert.equal(selectiveDevelopmentRoutes(old,next,selection()),undefined);}
});
test('URL aliases and simultaneously visible route branches cannot certify an unrelated page',()=>{
  for(const mutate of [next=>next.middleware={},next=>next.customRoutes.rewrites={beforeFiles:[{source:'/alias',destination:'/a'}]},next=>next.config.i18n={locales:['en','fr']},next=>next.routes[0].parallel=true,next=>next.routes[0].interception=true]){
    const next=manifest();mutate(next);assert.equal(selectiveDevelopmentRoutes(manifest(),next,selection()),undefined);
  }
});
test('Action contracts, owner coverage, unexplained identities and route semantics fall back globally',()=>{
  const mutations=[next=>delete next.devActions,next=>next.devActions.complete=false,next=>next.devModules=[],next=>next.devDependencies=[],next=>delete next.devDependencyStatus,next=>next.devActions.actions[0].binding='renamed',next=>next.devActions.actions[0].runtimes=['edge'],next=>next.app.actionKey='other-key',next=>next.routes[0].cacheConfig={runtime:'edge'},next=>next.routes.push({id:'c',pattern:'/c'}),next=>next.config.basePath='/other',
    next=>{delete next.app.actions[id(2)];next.app.actions[id(3)]={};next.devActions.actions[1].id=id(3);}];
  for(const mutate of mutations){const next=manifest();mutate(next);assert.equal(selectiveDevelopmentRoutes(manifest(),next,selection()),undefined);}
});
test('Pages without Actions retain selection, but navigation and unconfirmed clients always synchronize',()=>{
  const old=manifest(),next=manifest();delete old.app;delete next.app;delete old.devActions;delete next.devActions;
  assert.deepEqual(selectiveDevelopmentRoutes(old,next,selection()),['/a']);
  const base={confirmed:true,affectedRoutes:['/a'],routes:['/a','/b'],pathname:'/b'};
  assert.equal(canSkipDevelopmentUpdate(base),true);
  for(const override of [{confirmed:false},{navigation:true},{ensuring:1},{affectedRoutes:undefined},{routes:undefined},{pathname:'/missing'},{pathname:'/a/'}])assert.equal(canSkipDevelopmentUpdate({...base,...override}),false);
});
test('dynamic selections match only their own route, including catch-all and encoded paths',()=>{
  const skip=(patterns,pathname)=>canSkipDevelopmentUpdate({confirmed:true,affectedRoutes:patterns,routes:['/[[...all]]'],pathname});
  assert.equal(skip(['/products/[id]'],'/account'),true);assert.equal(skip(['/products/[id]'],'/products/123'),false);
  assert.equal(skip(['/products/[id]'],'/products/123/reviews'),true);assert.equal(skip(['/docs/[...slug]'],'/docs'),true);
  assert.equal(skip(['/docs/[...slug]'],'/docs/a/b'),false);assert.equal(skip(['/docs/[[...slug]]'],'/docs'),false);
  assert.equal(skip(['/café/[id]'],'/caf%C3%A9/1'),false);assert.equal(skip(['/'],'/'),false);assert.equal(skip(['/[id]'],'/'),true);
  assert.equal(skip(['/a'],'/%zz'),false);
});
