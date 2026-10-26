import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationInstallContext, installWithManager, executeManager } from './package-manager.mjs';

async function fixture(t, manager='npm', {workspace=true,version}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-manager & % ! (fixture)-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const rootPackage={name:'workspace-root',private:true,...(workspace?{workspaces:['apps/*']}:{}),...(version?{packageManager:`${manager}@${version}`}:{})};
  await writeFile(path.join(root,'package.json'),JSON.stringify(rootPackage));
  if(manager==='pnpm'&&workspace)await writeFile(path.join(root,'pnpm-workspace.yaml'),"packages:\n  - 'apps/*'\n  - '!apps/excluded'\n");
  const target=workspace?path.join(root,'apps/web'):root;
  await mkdir(target,{recursive:true});
  const pkg={name:'fixture-web',version:'1.0.0',private:true};
  if(workspace)await writeFile(path.join(target,'package.json'),JSON.stringify(pkg));
  return {root,target,pkg:workspace?pkg:rootPackage,rootPackage};
}

test('manager discovery targets only selected npm/pnpm workspace and preserves a shared Yarn root',async t=>{
  for(const manager of ['npm','pnpm','yarn']){
    const f=await fixture(t,manager,{version:manager==='npm'?'10.9.0':manager==='pnpm'?'10.11.0':'4.9.2'});
    const before=await readdir(f.root),context=await migrationInstallContext(f.target,f.pkg);
    assert.equal(context.allowed,true);assert.equal(context.root,f.root);assert.equal(context.target,f.target);assert.equal(context.manager,manager);assert.equal(context.workspaceTarget,'apps/web');
    if(manager==='npm')assert.deepEqual(context.command.args,['install','--workspace','apps/web','--include-workspace-root=false']);
    if(manager==='pnpm')assert.deepEqual(context.command.args,['--filter','fixture-web','--fail-if-no-match','install','--no-frozen-lockfile']);
    if(manager==='yarn')assert.deepEqual(context.command.args,['install']);
    assert.deepEqual(await readdir(f.root),before);
  }
});

test('manager discovery detects conflicting locks, excluded packages and declaration mismatches',async t=>{
  const f=await fixture(t,'pnpm',{version:'10.11.0'});
  await writeFile(path.join(f.root,'pnpm-lock.yaml'),'lockfileVersion: 9.0');
  await writeFile(path.join(f.root,'yarn.lock'),'# yarn lockfile v1');
  let context=await migrationInstallContext(f.target,f.pkg);assert.equal(context.allowed,false);assert.match(context.reason,/Conflicting/);
  await rm(path.join(f.root,'yarn.lock'));
  await mkdir(path.join(f.root,'apps/excluded'));await writeFile(path.join(f.root,'apps/excluded/package.json'),JSON.stringify({name:'excluded'}));
  context=await migrationInstallContext(path.join(f.root,'apps/excluded'),{name:'excluded'});assert.equal(context.allowed,false);assert.match(context.reason,/not listed/);
  context=await migrationInstallContext(f.target,{...f.pkg,packageManager:'yarn@1.22.22'});assert.equal(context.allowed,false);assert.match(context.reason,/disagree|Conflicting/);
  const unnamed=await migrationInstallContext(f.target,{private:true});assert.equal(unnamed.allowed,false);assert.match(unnamed.reason,/valid package name/);
  const duplicate=path.join(f.root,'apps/duplicate');await mkdir(duplicate);await writeFile(path.join(duplicate,'package.json'),JSON.stringify(f.pkg));
  const selected=await migrationInstallContext(f.target,f.pkg);await assert.rejects(installWithManager(selected),/package names must be unique/);
});

test('pnpm inline package globs and Yarn Classic lockfiles are recognized without invoking installers',async t=>{
  const f=await fixture(t,'pnpm');await writeFile(path.join(f.root,'pnpm-workspace.yaml'),`packages: ['apps/*', '!apps/excluded']\n`);
  assert.equal((await migrationInstallContext(f.target,f.pkg)).allowed,true);
  const yarn=await fixture(t,'yarn',{workspace:false});await writeFile(path.join(yarn.root,'yarn.lock'),'# yarn lockfile v1\n');
  const context=await migrationInstallContext(yarn.target,yarn.pkg);assert.equal(context.manager,'yarn');assert.equal(context.berry,false);
  await rm(path.join(yarn.root,'yarn.lock'));await writeFile(path.join(yarn.root,'.yarnrc.yml'),'nodeLinker: pnp\n');
  const berry=await migrationInstallContext(yarn.target,yarn.pkg);assert.equal(berry.manager,'yarn');assert.equal(berry.berry,true);
});

test('Yarn release paths cannot escape through a linked ancestor and workspace ancestors are protected',async t=>{
  const f=await fixture(t,'yarn',{version:'4.9.2'}),outside=await mkdtemp(path.join(tmpdir(),'prnext-manager-outside-'));
  t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(path.join(outside,'release.cjs'),'throw Error("must-not-run")');await mkdir(path.join(f.root,'.yarn'));
  await symlink(outside,path.join(f.root,'.yarn/releases'),process.platform==='win32'?'junction':'dir');
  await writeFile(path.join(f.root,'.yarnrc.yml'),'yarnPath: .yarn/releases/release.cjs\n');
  const context=await migrationInstallContext(f.target,f.pkg);
  await assert.rejects(executeManager(context,['--version']),/inside the workspace/);
  await rm(path.join(f.root,'.yarnrc.yml'));
  // A source symlink that could contain another workspace is rejected before
  // any manager invocation; the selected target itself remains a real path.
  await symlink(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
  context.workspacePatterns.push('linked/*');
  await assert.rejects(installWithManager(context),/ancestors must not be symlinks/);
});

// Run explicitly when Corepack/managers are available. All dependencies are
// local stubs; downloads/caches and installation stay inside owned fixtures.
for(const [manager,version]of [['npm',null],['pnpm','10.11.0'],['yarn','1.22.22'],['yarn','4.9.2']]){
  test(`real ${manager}${version?` ${version}`:''} installs a selected workspace using local packages`,{skip:process.env.PRNEXT_TEST_PACKAGE_MANAGERS!=='1',timeout:180000},async t=>{
    const f=await fixture(t,manager,{version});
    const stubRepository=path.join(f.root,'stubs/repository'),stub=path.join(stubRepository,'packages/prnext');await mkdir(stub,{recursive:true});
    await mkdir(path.join(stubRepository,'crates/prnext'),{recursive:true});await writeFile(path.join(stubRepository,'package.json'),'{"name":"prnext-monorepo","private":true}');await writeFile(path.join(stubRepository,'crates/prnext/Cargo.toml'),'[package]\nname="prnext"\n');
    await writeFile(path.join(stub,'package.json'),JSON.stringify({name:'@thomas.f/prnext',version:'0.0.0',bin:{prnext:'cli.cjs',prn:'cli.cjs'}}));
    await writeFile(path.join(stub,'cli.cjs'),`#!/usr/bin/env node\nif(process.argv.includes('--help'))import(${JSON.stringify(new URL('../cli.mjs',import.meta.url).href)});else console.log("fixture-prnext");\n`,{mode:0o755});
    const sibling=path.join(f.root,'apps/sibling');await mkdir(sibling);const siblingManifest='{"name":"fixture-sibling","private":true,"version":"1.0.0"}\n';await writeFile(path.join(sibling,'package.json'),siblingManifest);
    const protocol=manager==='npm'?'file':manager==='yarn'&&version.startsWith('4.')?'portal':'link';
    const dependencies={'@thomas.f/prnext':`${protocol}:../../stubs/repository/packages/prnext`};
    if(manager==='yarn'&&version.startsWith('4.')){
      const peers=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).peerDependencies;
      for(const name of ['react','react-dom']){
        const directory=path.join(f.root,'stubs',name);await mkdir(directory);await writeFile(path.join(directory,'package.json'),JSON.stringify({name,version:peers[name]}));
        dependencies[name]=`file:../../stubs/${name}`;
      }
      await mkdir(path.join(f.target,'pages'));await writeFile(path.join(f.target,'pages/index.jsx'),'export default function Page(){return <p>PnP fixture</p>}');
    }
    const pkg={...f.pkg,dependencies};await writeFile(path.join(f.target,'package.json'),JSON.stringify(pkg));
    const env={COREPACK_HOME:path.join(f.root,'.corepack'),COREPACK_ENABLE_DOWNLOAD_PROMPT:'0',npm_config_cache:path.join(f.root,'.npm-cache'),YARN_CACHE_FOLDER:path.join(f.root,'.yarn-cache'),YARN_ENABLE_GLOBAL_CACHE:'false',YARN_GLOBAL_FOLDER:path.join(f.root,'.yarn-global'),PNPM_HOME:path.join(f.root,'.pnpm-home')};
    // Keep pnpm's content-addressed store scoped to this fixture too.
    if(manager==='pnpm')await writeFile(path.join(f.root,'.npmrc'),`store-dir=${path.join(f.root,'.pnpm-store').replaceAll('\\','/')}\n`);
    const context=await migrationInstallContext(f.target,pkg),rootBefore=await readFile(path.join(f.root,'package.json'),'utf8');
    const result=await installWithManager(context,{json:true,env,local:true});
    assert.equal(await readFile(path.join(sibling,'package.json'),'utf8'),siblingManifest);
    assert.equal(await readFile(path.join(f.root,'package.json'),'utf8'),rootBefore);
    assert.equal((await executeManager(context,['--version'],{env})).stdout.trim(),result.version);
    const lock=manager==='npm'?'package-lock.json':manager==='pnpm'?'pnpm-lock.yaml':'yarn.lock';assert.ok((await readFile(path.join(f.root,lock))).length);
    if(manager==='yarn'&&version.startsWith('1.')){
      const help=await executeManager(context,['run','prnext','--help'],{cwd:f.target,env});assert.match(help.stdout,/Generate route types without building the app/);
      const foreign=path.join(f.target,'node_modules/.bin',process.platform==='win32'?'prnext.cmd':'prnext');
      const original=await readFile(foreign);await writeFile(foreign,'foreign launcher preserved\n');
      await assert.rejects(installWithManager(context,{json:true,env,local:true}),/launcher was preserved/);
      assert.equal(await readFile(foreign,'utf8'),'foreign launcher preserved\n');await writeFile(foreign,original);
    }
    if(manager==='yarn'&&version.startsWith('4.')){
      assert.equal(result.pnp,true);
      const resolved=await executeManager(context,['node','-e',"console.log(require('@thomas.f/prnext/package.json').version)"],{cwd:f.target,env});
      assert.equal(resolved.stdout.trim(),'0.0.0');
      // Exercise the exact Yarn-node CLI preflight used after PnP migration.
      // Local React/native access fixtures do not assert npm release availability.
      const checked=await executeManager(context,['node',fileURLToPath(new URL('../cli.mjs',import.meta.url)),'check',f.target,'--json'],{cwd:f.target,env});
      const preflight=JSON.parse(checked.stdout);assert.equal(preflight.ok,true);assert.ok(preflight.routes.some(route=>route.pattern==='/'));assert.equal(preflight.versions.react,JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).peerDependencies.react);
      const probe=`import{createRequire}from'node:module';import path from'node:path';import{sourceCheckout}from ${JSON.stringify(new URL('../native/resolve.mjs',import.meta.url).href)};const require=createRequire(${JSON.stringify(path.join(f.target,'package.json'))});console.log(sourceCheckout(path.dirname(require.resolve('@thomas.f/prnext/package.json'))));`;
      const probeFile=path.join(f.target,'checkout-probe.mjs');await writeFile(probeFile,probe);
      const checkout=await executeManager(context,['node',probeFile],{cwd:f.target,env});
      assert.equal(checkout.stdout.trim(),stubRepository);
    }
  });
}
