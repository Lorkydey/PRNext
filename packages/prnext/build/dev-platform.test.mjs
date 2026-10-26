import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeTypedRoutes,routeDeclarations} from './typed-routes.mjs';
import {route} from '../runtime/typed-route.mjs';
import {createStyleProcessor} from './styles.mjs';
import {developmentRoute} from '../runtime/development.mjs';
import {startTypeChecker} from './typescript-dev.mjs';
import {privateCacheDirectory,pruneCompilerCache} from './persistent-cache.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const repository=fileURLToPath(new URL('../../../',import.meta.url));
const ts=createRequire(import.meta.url)('typescript');
async function fixture(t){const root=await mkdtemp(path.join(repository,'.prnext-dev-platform-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));await writeFile(path.join(root,'package.json'),'{"type":"module"}');return root;}

test('typed routes validate links, navigation and parameter objects while preserving JSONC config',async t=>{
  const root=await fixture(t);
  const config='{// keep this comment\n"compilerOptions":{"target":"ES2022","lib":["ES2022","DOM"],"module":"ESNext","moduleResolution":"Bundler","jsx":"react-jsx","strict":true,"noEmit":true,"esModuleInterop":true,"skipLibCheck":true,"baseUrl":".","paths":{"@/*":["./src/*"]}},"include":["src/**/*.tsx"]}';
  await writeFile(path.join(root,'tsconfig.json'),config);
  const project={routes:['/','/about','/users/[id]','/files/[...slug]','/docs/[[...slug]]'].map(pattern=>({pattern,kind:'page'}))};
  await mkdir(path.join(root,'src'));
  await writeTypedRoutes(root,project,{typedRoutes:true});
  assert.match(await readFile(path.join(root,'tsconfig.json'),'utf8'),/keep this comment/);
  const source=`import Link from 'next/link';import {useRouter} from 'next/navigation';import {route,type Route} from '@thomas.f/prnext';
const router=useRouter();const valid=<><Link href="/about"/><Link href="/users/alice"/><Link href="/docs"/><Link href={{pathname:'/users/[id]',query:{id:'a'}}}/></>;
router.push('/users/alice?view=one');router.replace('/docs/a/b');router.push(route('/users/[id]',{id:'a'}));const good='/about' satisfies Route;
// @ts-expect-error nonexistent route
const bad=<Link href="/missing"/>;
// @ts-expect-error missing parameter
const empty=<Link href="/users/"/>;
// @ts-expect-error too many segments
const extra=<Link href="/users/a/b"/>;
// @ts-expect-error nonexistent navigation
router.push('/missing');
// @ts-expect-error required catchall
router.push('/files');
// @ts-expect-error missing dynamic parameter
route('/users/[id]',{});
// @ts-expect-error unknown parameter
route('/users/[id]',{id:'a',unexpected:'x'});
// @ts-expect-error missing query parameter
const query=<Link href={{pathname:'/users/[id]',query:{slug:'x'}}}/>;
// @ts-expect-error unknown pattern
route('/missing',{});
// @ts-expect-error invalid route literal
const invalid='/missing' satisfies Route;
`;
  await writeFile(path.join(root,'src/check.tsx'),source);
  const host={...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{}};
  const parsed=ts.getParsedCommandLineOfConfigFile(path.join(root,'tsconfig.json'),{noEmit:true},host);
  const errors=ts.getPreEmitDiagnostics(ts.createProgram({rootNames:parsed.fileNames,options:parsed.options}));
  assert.equal(ts.formatDiagnostics(errors,{getCurrentDirectory:()=>root,getCanonicalFileName:name=>name,getNewLine:()=> '\n'}),'');
});
test('route materialization encodes segments and validates catchalls and extra parameters',()=>{
  assert.equal(route('/users/[id]',{id:'a ?#'}),'/users/a%20%3F%23');
  assert.equal(route('/docs/[[...slug]]'),'/docs');
  assert.equal(route('/files/[...slug]',{slug:['a','b']}),'/files/a/b');
  for(const params of [{id:'../escape'},{id:''},{id:'..'},{id:'a',extra:'b'}])assert.throws(()=>route('/users/[id]',params));
  assert.throws(()=>route('/files/[...slug]',{slug:[]}));
  assert.throws(()=>route('/files/[...slug]',{slug:['a','..']}));
  assert.doesNotMatch(routeDeclarations({routes:[{pattern:'/api/private',kind:'api'}]}),/\/api\/private/);
});
test('development selection preserves literal precedence, locales, base paths and data aliases',()=>{
  const routes=['/[id]','/fixed','/docs/[...slug]','/docs/[[...slug]]','/'].map(pattern=>({pattern}));
  const config={basePath:'/app',i18n:{locales:['en','fr']}};
  assert.equal(developmentRoute(routes,'/app/fr/fixed?x=1',config)?.pattern,'/fixed');
  assert.equal(developmentRoute(routes,'/app/_prnext/data/build/fr/fixed.json',config)?.pattern,'/fixed');
  assert.equal(developmentRoute(routes,'/app/docs/a/b',config)?.pattern,'/docs/[...slug]');
  assert.equal(developmentRoute(routes,'/app/docs',config)?.pattern,'/docs/[[...slug]]');
  assert.equal(developmentRoute(routes,'/other/fixed',config),undefined);
  const precedence=['/[id]/a/b','/fixed/[...slug]','/fixed','/fixed/[[...slug]]'].map(pattern=>({pattern}));
  assert.equal(developmentRoute(precedence,'/fixed/a/b')?.pattern,'/fixed/[...slug]');
  assert.equal(developmentRoute(precedence,'/fixed')?.pattern,'/fixed');
});
test('native CSS compiles nesting and respects a custom PostCSS pipeline',async t=>{
  const root=await fixture(t),file=path.join(root,'style.css');
  await writeFile(file,'.card {color: red;& > span {color: blue}}');
  const native=await createStyleProcessor({projectRoot:root}).process(file);
  assert.match(native.css,/\.card/);assert.match(native.css,/> span/);
  await writeFile(path.join(root,'postcss.config.cjs'),`module.exports={plugins:[]}`);
  await writeFile(file,'.card {color: REBECCAPURPLE}');
  const custom=await createStyleProcessor({projectRoot:root}).process(file);
  assert.match(custom.css,/REBECCAPURPLE/,'custom pipeline must not silently receive native transforms');
});
test('pure development transformations persist between processes and invalidate after env edits',async t=>{
  const root=await fixture(t),module=new URL('./transform-cache.mjs',import.meta.url).href;
  const code=`import {withPersistentTransforms,cachedTransform,transformCacheStats} from ${JSON.stringify(module)};await withPersistentTransforms(${JSON.stringify(root)},{dev:true},()=>cachedTransform('dev-fixture','input',[],()=>'output'));console.log(JSON.stringify(transformCacheStats()));`;
  const run=async()=>JSON.parse((await promisify(execFile)(process.execPath,['--input-type=module','-e',code])).stdout);
  assert.equal((await run()).diskHits,0);assert.equal((await run()).diskHits,1);
  await writeFile(path.join(root,'.env.development'),'PUBLIC_VALUE=changed');assert.equal((await run()).diskHits,0);
});
test('background TypeScript reports and clears errors without emitting application files',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true},include:['check.ts']}));
  const file=path.join(root,'check.ts');await writeFile(file,'const value:number="wrong";export {value};');
  const fileIdentity=async()=>{const {mtimeMs,size,ino}=await stat(file);return {mtimeMs,size,ino};},before=await fileIdentity();let after;
  let latest;const checker=await startTypeChecker(root,{},errors=>{latest=errors;});
  async function wait(check){for(let i=0;i<400;i++){if(check())return;await delay(25);}assert.fail('TypeScript diagnostics did not settle: '+JSON.stringify({latest,before,after,current:await fileIdentity()}));}
  try{await wait(()=>latest?.some(value=>value.includes('2322')));
  await writeFile(file,'const value:number=42;export {value};');after=await fileIdentity();await wait(()=>latest?.length===0);
  assert.equal(await readFile(path.join(root,'check.js'),'utf8').catch(()=>null),null);
  assert.match(await readFile(path.join(root,'.prnext-cache/typescript-dev/project.tsbuildinfo'),'utf8'),/version/);
  }finally{await checker.close();}
});


test('typed route generation preserves inherited roots, trailing commas, edits and opt-out',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'config'));await writeFile(path.join(root,'config/base.json'),'{"compilerOptions":{"strict":true,"paths":{"@original":["../original.ts"]}},"files":["../original.ts"]}');
  await writeFile(path.join(root,'original.ts'),'export {};');await writeFile(path.join(root,'tsconfig.json'),'{// root comment\n"extends":"./config/base.json",}');
  const project={routes:[{pattern:'/old',kind:'page'}]};await writeTypedRoutes(root,project,{typedRoutes:true});
  const source=await readFile(path.join(root,'tsconfig.json'),'utf8');assert.match(source,/root comment/);
  const parsed=ts.getParsedCommandLineOfConfigFile(path.join(root,'tsconfig.json'),{},{...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{}});
  assert.deepEqual(parsed.errors,[]);assert.equal(path.resolve(root,parsed.options.paths['@original'][0]),path.join(root,'original.ts'));assert.ok(parsed.fileNames.some(file=>path.resolve(file)===path.join(root,'original.ts')));assert.ok(parsed.fileNames.some(file=>path.resolve(file)===path.join(root,'prnext-env.d.ts')));
  await writeTypedRoutes(root,{routes:[{pattern:'/new/[id]',kind:'page'}]},{typedRoutes:true});assert.equal(await readFile(path.join(root,'tsconfig.json'),'utf8'),source);
  const registry=await readFile(path.join(root,'.prnext-types/routes.d.ts'),'utf8');assert.match(registry,/new/);assert.doesNotMatch(registry,/old/);
  await writeTypedRoutes(root,project,{typedRoutes:false});assert.doesNotMatch(await readFile(path.join(root,'.prnext-types/routes.d.ts'),'utf8'),/old|new/);
});

test('compiler code-cache pruning keeps recent files and treats unavailable caches as optional',async t=>{
  const root=await fixture(t),directory=await privateCacheDirectory(root,'dev-compiler-v8');await mkdir(path.join(directory,'node-version'));
  for(let i=0;i<5;i++)await writeFile(path.join(directory,'node-version',String(i)),'cache');
  await pruneCompilerCache(directory,{maxFiles:2,maxBytes:100});const {readdir}=await import('node:fs/promises');assert.equal((await readdir(path.join(directory,'node-version'))).length,2);
  await pruneCompilerCache(path.join(root,'missing'));await pruneCompilerCache(null);
});


test('a real typed-routes build binds Next imports and passes the production TypeScript gate',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'pages/users'),{recursive:true});
  await writeFile(path.join(root,'prnext.config.mjs'),'export default {typedRoutes:true,typescript:{}}');
  await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true},include:['pages/**/*.tsx']}));
  await writeFile(path.join(root,'pages/index.tsx'),`import Link from 'next/link';import {route} from '@thomas.f/prnext';export default function Page(){return <Link href={route('/users/[id]',{id:'alice'})}>User</Link>}`);
  await writeFile(path.join(root,'pages/users/[id].tsx'),'export default function Page(){return <p>User detail</p>}');
  await mkdir(path.join(root,'app/app'),{recursive:true});await mkdir(path.join(root,'app/edge'),{recursive:true});
  await writeFile(path.join(root,'app/layout.tsx'),'export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>}');
  await writeFile(path.join(root,'app/app/page.tsx'),`'use client';import {route}from'@thomas.f/prnext';export default function Page(){return <a href={route('/users/[id]',{id:'bob'})}>App user</a>}`);
  await writeFile(path.join(root,'app/edge/route.ts'),`import {route}from'@thomas.f/prnext/route';export const runtime='edge';export function GET(){return Response.json({href:route('/users/[id]',{id:'edge'})})}`);
  const {build}=await import('./index.mjs');const manifest=await build(root);assert.ok(manifest.routes.some(route=>route.pattern==='/users/[id]'));
  const aliases=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile).config.compilerOptions.paths;
  assert.match(aliases['next/*'][0],/compat/);assert.match(aliases.next[0],/index.d.ts$/);
});
