import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {incrementalBuild,closeIncrementalCompiler,incrementalCompilerStats} from './incremental.mjs';
import {build as compileGraph,configureCompiler,withCompilation} from './compiler.mjs';

async function within(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Compiler disposal callback did not finish')), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
test('incremental contexts rebind plugins and stage paths, recover from errors and observe dependency edits',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-incremental-'));
  try{
    await writeFile(path.join(root,'module.js'),'export default "first"');
    let loads=0;
    async function compile(index,marker){
      const stage=path.join(root,`.prnext-build-${index}`);await mkdir(stage,{recursive:true});
      const entry=path.join(stage,'entry.js');await writeFile(entry,'import value from "../module.js";console.log(value)');
      return incrementalBuild({absWorkingDir:root,entryPoints:[entry],outdir:path.join(stage,'out'),bundle:true,write:false,metafile:true,plugins:[{name:'test-transform',setup(builder){builder.onLoad({filter:/module\.js$/,namespace:'file'},async args=>{loads++;return {contents:(await readFile(args.path,'utf8'))+`;console.log(${JSON.stringify(marker)})`,loader:'js'}})}}]}, {root,stage});
    }
    const first=await compile(1,'one');assert.match(first.outputFiles[0].text,/first/);assert.match(first.outputFiles[0].text,/one/);
    const second=await compile(2,'two');assert.match(second.outputFiles[0].text,/two/);assert.doesNotMatch(second.outputFiles[0].text,/one/);assert.match(second.outputFiles[0].path,/build-2/);
    assert.ok(Object.keys(second.metafile.outputs).every(file=>!file.includes('incremental-stage')));
    await writeFile(path.join(root,'module.js'),'export default "changed"');assert.match((await compile(3,'three')).outputFiles[0].text,/changed/);
    await writeFile(path.join(root,'module.js'),'export default (');await assert.rejects(compile(4,'four'));
    await writeFile(path.join(root,'module.js'),'export default "fixed"');assert.match((await compile(5,'five')).outputFiles[0].text,/fixed/);assert.ok(loads>=5);assert.equal(incrementalCompilerStats().created,1);assert.equal(incrementalCompilerStats().reused,4);
  }finally{await closeIncrementalCompiler();await rm(root,{recursive:true,force:true})}
});

test('auxiliary compiler reuse has a separate bounded budget and sees changes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-incremental-aux-'));
  try{
    const before=incrementalCompilerStats();
    const stage=path.join(root,'stage');await mkdir(stage);
    const entry=path.join(root,'vendor.js');await writeFile(entry,'export const value=1');
    const options={entryPoints:[entry],outdir:path.join(stage,'out'),bundle:true,format:'esm',write:false};
    await incrementalBuild(options,{root,stage,group:'project'});
    await incrementalBuild(options,{root,stage,group:'auxiliary'});
    await writeFile(entry,'export const value=2');
    assert.match((await incrementalBuild(options,{root,stage,group:'auxiliary'})).outputFiles[0].text,/value = 2/);
    for(let index=0;index<4;index++)await incrementalBuild({...options,define:{A:String(index)}},{root,stage,group:'auxiliary'});
    assert.equal(incrementalCompilerStats().contexts,3,'one project plus two auxiliary contexts');
    const reused=incrementalCompilerStats().reused;
    await incrementalBuild(options,{root,stage,group:'project'});
    assert.equal(incrementalCompilerStats().reused,reused+1,'auxiliary eviction leaves project graphs intact');
    assert.ok(incrementalCompilerStats().created>before.created);
  }finally{await closeIncrementalCompiler();await rm(root,{recursive:true,force:true});}
});

test('twenty CSS scopes retain the six main graphs within the existing context budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-roles-'));
  const started = [], disposed = [];
  const disposals = new Map();
  try {
    async function compile(name, role, generation) {
      if (!disposals.has(name)) {
        let resolve;
        const promise = new Promise(complete => { resolve = complete; });
        disposals.set(name, { promise, resolve });
      }
      const stage = path.join(root, `stage-${generation}`);
      await mkdir(stage, { recursive: true });
      const entry = path.join(root, name + (role === 'styles' ? '.css' : '.js'));
      await writeFile(entry, role === 'styles' ? `.${name} { color: red }` : `export const value = ${generation}`);
      return incrementalBuild({
        absWorkingDir: root,
        entryPoints: [entry],
        outdir: path.join(stage, 'out'),
        bundle: true,
        format: 'esm',
        write: false,
        plugins: [{
          name: 'role-fixture',
          setup(builder) {
            builder.onStart(() => { started.push(`${name}:${generation}`); });
            builder.onDispose(() => {
              disposed.push(`${name}:${generation}`);
              disposals.get(name).resolve();
            });
          },
        }],
      }, { root, stage, role });
    }

    const before = incrementalCompilerStats();
    for (let index = 0; index < 6; index++) await compile(`main${index}`, 'main', 1);
    for (let index = 0; index < 20; index++) await compile(`style${index}`, 'styles', 1);
    const first = incrementalCompilerStats();
    for (let index = 0; index < 6; index++) {
      const result = await compile(`main${index}`, 'main', 2);
      assert.match(result.outputFiles[0].text, /value = 2/);
    }
    const second = incrementalCompilerStats();
    assert.equal(second.reused - first.reused, 6, 'style churn must not discard the six main graphs');
    assert.equal(second.created - before.created, 26);
    assert.equal(second.contexts, 8, 'the existing project context ceiling is unchanged');
    assert.deepEqual(second.roles.main.contexts, 6);
    assert.deepEqual(second.roles.styles.contexts, 2);
    assert.equal(second.roles.styles.evicted - before.roles.styles.evicted, 18);
    assert.equal(second.roles.main.evicted - before.roles.main.evicted, 0);
    assert.equal(started.filter(name => name.endsWith(':2')).length, 6, 'reused contexts run the current plugin callbacks');
    await closeIncrementalCompiler(root);
    // esbuild schedules onDispose callbacks independently of dispose()'s
    // promise. Wait for their actual completion rather than a clock delay.
    await within(Promise.all([...disposals.values()].map(value => value.promise)));
    assert.equal(incrementalCompilerStats().contexts, 0);
    assert.equal(disposed.filter(name => name.startsWith('main') && name.endsWith(':2')).length, 6, 'disposal uses the latest plugin callbacks');
    assert.equal(disposed.length, 26, 'each retained or evicted context is disposed once');
  } finally {
    await closeIncrementalCompiler();
    await rm(root, { recursive: true, force: true });
  }
});

test('role reservations lend spare capacity, reclaim it across roots and isolate project statistics', async () => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-first-'));
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-second-'));
  try {
    async function compile(root, index, role, value) {
      const stage = path.join(root, 'stage');
      await mkdir(stage, { recursive: true });
      const entry = path.join(root, `entry-${index}.js`);
      await writeFile(entry, `export const value = ${JSON.stringify(value)}`);
      return incrementalBuild({
        absWorkingDir: root,
        entryPoints: [entry],
        outdir: path.join(stage, 'out'),
        bundle: true,
        format: 'esm',
        write: false,
        define: { GRAPH: String(index) },
      }, { root, stage, role });
    }

    for (let index = 0; index < 8; index++) await compile(firstRoot, index, 'styles', 'first');
    assert.equal(incrementalCompilerStats().roles.styles.contexts, 8, 'styles can borrow unused main capacity');
    for (let index = 0; index < 6; index++) await compile(secondRoot, index, 'main', 'second');
    let stats = incrementalCompilerStats();
    assert.equal(stats.contexts, 8);
    assert.equal(stats.roles.main.contexts, 6);
    assert.equal(stats.roles.styles.contexts, 2);
    assert.equal(stats.projects.length, 2);
    const first = stats.projects.find(project => project.root === firstRoot);
    const second = stats.projects.find(project => project.root === secondRoot);
    assert.equal(first.created, 8);
    assert.equal(first.evicted, 6);
    assert.equal(second.created, 6);
    assert.equal(second.evicted, 0);
    const before = stats.reused;
    const result = await compile(firstRoot, 7, 'styles', 'updated-first');
    assert.match(result.outputFiles[0].text, /updated-first/);
    assert.equal(incrementalCompilerStats().reused, before + 1);
    assert.match((await compile(secondRoot, 7, 'styles', 'second-project')).outputFiles[0].text, /second-project/);
    await closeIncrementalCompiler(secondRoot);
    stats = incrementalCompilerStats();
    assert.equal(stats.projects.length, 1, 'closed projects leave no historical metrics registry');
    assert.equal(stats.projects[0].root, firstRoot);
    assert.equal(stats.contexts, 1);
    for (let index = 0; index < 8; index++) await compile(firstRoot, index, 'main', 'first-main');
    assert.equal(incrementalCompilerStats().roles.main.contexts, 7);
    assert.equal(incrementalCompilerStats().roles.styles.contexts, 1);
    await compile(firstRoot, 8, 'styles', 'reclaimed');
    assert.equal(incrementalCompilerStats().roles.main.contexts, 6, 'styles reclaim their reserved capacity from borrowed main slots');
    assert.equal(incrementalCompilerStats().roles.styles.contexts, 2);
    assert.equal(incrementalCompilerStats().contexts, 8);
  } finally {
    await closeIncrementalCompiler();
    await Promise.all([firstRoot, secondRoot].map(root => rm(root, { recursive: true, force: true })));
  }
});

test('the compiler routes style graph metadata outside esbuild options and keeps roles separate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-compiler-role-'));
  try {
    const stage = path.join(root, 'stage');
    await mkdir(stage);
    const entry = path.join(root, 'entry.css');
    await writeFile(entry, '.fixture { color: red }');
    await withCompilation(async () => {
      configureCompiler({ root, stage, incremental: true, dev: true, config: {} });
      const options = {
        absWorkingDir: root,
        entryPoints: [entry],
        outdir: path.join(stage, 'out'),
        bundle: true,
        write: false,
        plugins: [{ name: 'prnext-app-browser', setup() {} }],
      };
      const before = incrementalCompilerStats();
      await compileGraph(options, { role: 'styles' });
      await compileGraph(options);
      await compileGraph(options, { role: 'styles' });
      const after = incrementalCompilerStats();
      assert.equal(after.created - before.created, 2);
      assert.equal(after.reused - before.reused, 1);
      assert.equal(after.roles.styles.contexts, 1);
      assert.equal(after.roles.main.contexts, 1);
      await assert.rejects(compileGraph(options, { role: 'unbounded-custom-role' }), /Invalid compiler graph role/);
    });
    await assert.rejects(incrementalBuild({}, { root, stage, role: 'unbounded-custom-role' }), /Invalid incremental compiler/);
  } finally {
    await closeIncrementalCompiler();
    await rm(root, { recursive: true, force: true });
  }
});
