import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const invoke = promisify(execFile);
const compiler = new URL('./react-compiler.mjs', import.meta.url).href;
const graph = new URL('./compiler.mjs', import.meta.url).href;
const component = 'export function Card({title}){return <p>{title}</p>}';

async function scenario(mode) {
  const script = `import {registerHooks} from 'node:module';import assert from 'node:assert/strict';
    let resolved=0;
    registerHooks({resolve(specifier,context,next){
      if(specifier==='oxc-transform-react'||specifier.startsWith('oxc-transform-react/')){
        resolved++;if(${JSON.stringify(mode)}==='missing')throw Object.assign(new Error('intentionally absent optional peer'),{code:'MODULE_NOT_FOUND'});
      }return next(specifier,context);
    },load(url,context,next){
      if(url.replaceAll('\\\\','/').endsWith('/oxc-transform-react/package.json')&&${JSON.stringify(mode)}==='version')
        return{format:'json',source:JSON.stringify({name:'oxc-transform-react',version:'99.0.0'}),shortCircuit:true};
      if(url.replaceAll('\\\\','/').endsWith('/oxc-transform-react/index.js')&&${JSON.stringify(mode)}==='binding')
        return{format:'module',source:'export const __napiBindingTarget="wasi"; export const transform=()=>{throw Error("must not run WASI")};',shortCircuit:true};
      if(url.replaceAll('\\\\','/').endsWith('/oxc-transform-react/index.js')&&${JSON.stringify(mode)}==='broken')
        return{format:'module',source:'throw Error("native binding unavailable");',shortCircuit:true};
      return next(url,context);
    }});
    const {createReactCompilerTransform,reactCompilerVersion}=await import(${JSON.stringify(compiler)});
    const {withCompilation,configureCompiler}=await import(${JSON.stringify(graph)});
    assert.equal(resolved,0,'loading the build modules never resolves Oxc');
    const root=process.cwd();const file=root+'/app/Card.jsx';const source=${JSON.stringify(component)};
    assert.equal(await createReactCompilerTransform(root,false)(source,file),source);
    await withCompilation(async()=>{
      configureCompiler({root,config:{reactCompiler:true},buildId:'optional-peer'});
      assert.match(await createReactCompilerTransform(root,true)(source,file),/react\\/compiler-runtime/);
    });
    assert.equal(resolved,0,'disabled and Babel compilation must not touch the optional peer');
    if(${JSON.stringify(mode)}==='missing'||${JSON.stringify(mode)}==='version'){
      const code=${JSON.stringify(mode)}==='missing'?'PRNEXT_OXC_MISSING':'PRNEXT_OXC_VERSION';
      assert.throws(()=>createReactCompilerTransform(root,{backend:'oxc'}),error=>error.code===code&&/npm install --save-dev oxc-transform-react@0.158.0/.test(error.message));
      assert.throws(()=>reactCompilerVersion({backend:'oxc'}),error=>error.code===code);
    }else{
      await assert.rejects(createReactCompilerTransform(root,{backend:'oxc'})(source,file),/native.*oxc-transform-react|native platform binding/);
    }
    console.log('verified:'+${JSON.stringify(mode)});`;
  const {stdout} = await invoke(process.execPath, ['--input-type=module', '-e', script], {windowsHide: true, maxBuffer: 1024 * 1024});
  assert.equal(stdout.trim(), `verified:${mode}`);
}

test('the default package has no mandatory Oxc compiler or external fontkit dependency', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.dependencies['oxc-transform-react'], undefined);
  assert.equal(manifest.dependencies.fontkit, undefined);
  assert.equal(manifest.peerDependencies['oxc-transform-react'], '0.158.0');
  assert.deepEqual(manifest.peerDependenciesMeta['oxc-transform-react'], {optional: true});
});

for (const mode of ['missing', 'version', 'binding', 'broken']) {
  test(`Oxc ${mode} is isolated from Babel and fails explicitly when selected`, () => scenario(mode));
}

test('an external/global framework imports the exact project peer and rejects a project version conflict', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-project-oxc-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const peer = path.join(directory, 'node_modules/oxc-transform-react');
  await mkdir(peer, {recursive: true});
  const manifest = {name: 'oxc-transform-react', version: '0.158.0', type: 'module', main: './index.mjs', exports: {'.': './index.mjs', './package.json': './package.json'}};
  await writeFile(path.join(peer, 'package.json'), JSON.stringify(manifest));
  const native = pathToFileURL(createRequire(import.meta.url).resolve('oxc-transform-react')).href;
  await writeFile(path.join(peer, 'index.mjs'), `export {transform,__napiBindingTarget} from ${JSON.stringify(native)};globalThis.__prnextSelectedOxcPeer='project';`);
  const script = `import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){
      if(context.parentURL===${JSON.stringify(compiler)}&&(specifier==='oxc-transform-react'||specifier.startsWith('oxc-transform-react/')))throw Object.assign(Error('global framework has no Oxc'),{code:'MODULE_NOT_FOUND'});
      return next(specifier,context);
    }});
    const {createReactCompilerTransform,reactCompilerVersion}=await import(${JSON.stringify(compiler)});
    const root=${JSON.stringify(directory)};assert.equal(reactCompilerVersion({backend:'oxc'},root),'0.158.0');
    const output=await createReactCompilerTransform(root,{backend:'oxc'})(${JSON.stringify(component)},root+'/app/Card.jsx');
    assert.match(output,/react\\/compiler-runtime/);assert.equal(globalThis.__prnextSelectedOxcPeer,'project');console.log('project peer compiled');`;
  assert.equal((await invoke(process.execPath, ['--input-type=module', '-e', script], {windowsHide: true})).stdout.trim(), 'project peer compiled');
  await writeFile(path.join(peer, 'package.json'), JSON.stringify({...manifest, version: '99.0.0'}));
  const conflict = `import assert from 'node:assert/strict';const {createReactCompilerTransform}=await import(${JSON.stringify(compiler)});assert.throws(()=>createReactCompilerTransform(${JSON.stringify(directory)},{backend:'oxc'}),{code:'PRNEXT_OXC_VERSION'});console.log('conflict rejected');`;
  assert.equal((await invoke(process.execPath, ['--input-type=module', '-e', conflict], {windowsHide: true})).stdout.trim(), 'conflict rejected');
});
