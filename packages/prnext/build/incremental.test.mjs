import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink,realpath as canonicalRoot} from 'node:fs/promises';
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
    const firstCanonical = await canonicalRoot(firstRoot), secondCanonical = await canonicalRoot(secondRoot);
    const first = stats.projects.find(project => project.root === firstCanonical);
    const second = stats.projects.find(project => project.root === secondCanonical);
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
    assert.equal(stats.projects[0].root, firstCanonical);
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

test('compiler roots close through aliases and still dispose after a canonical root is removed', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-alias-'));
  const actual = path.join(parent, 'actual'), alias = path.join(parent, 'alias');
  try {
    await mkdir(path.join(actual, 'stage'), { recursive: true });
    await writeFile(path.join(actual, 'entry.js'), 'export const value = 1');
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const options = { absWorkingDir: alias, entryPoints: [path.join(alias, 'entry.js')], outdir: path.join(alias, 'stage/out'), bundle: true, write: false };
    await incrementalBuild(options, { root: alias, stage: path.join(alias, 'stage') });
    assert.equal(incrementalCompilerStats().projects[0].root, await canonicalRoot(actual));
    await closeIncrementalCompiler(alias);
    assert.equal(incrementalCompilerStats().contexts, 0, 'a lexical alias must close its canonical project');
    await incrementalBuild(options, { root: alias, stage: path.join(alias, 'stage') });
    const resolved = await canonicalRoot(actual);
    await rm(actual, { recursive: true, force: true });
    await closeIncrementalCompiler(resolved);
    assert.equal(incrementalCompilerStats().contexts, 0, 'a removed canonical root must not prevent context cleanup');
  } finally {
    await closeIncrementalCompiler();
    await rm(parent, { recursive: true, force: true });
  }
});

for (const source of ['define', 'stdin', 'banner']) {
  test(`alias ownership preserves application ${source} strings`, async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-literals-'));
    const actual = path.join(parent, 'actual'), alias = path.join(parent, 'alias');
    try {
      await mkdir(actual);
      await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
      // Forward slashes are valid paths on both platforms and keep the alias
      // present verbatim in JSON, including on Windows.
      const root = alias.replaceAll(path.sep, '/'), stage = root + '/stage';
      await mkdir(stage);
      const literal = JSON.stringify(root);
      const options = {
        absWorkingDir: root,
        stdin: { contents: 'export const value = ROOT_VALUE;', resolveDir: root, sourcefile: 'entry.js' },
        outfile: stage + '/entry.mjs',
        bundle: true,
        format: 'esm',
        write: false,
        define: { ROOT_VALUE: literal },
      };
      if (source !== 'define') delete options.define;
      if (source === 'stdin') options.stdin.contents = `export const value = ${literal};`;
      if (source === 'banner') {
        options.stdin.contents = '';
        options.banner = { js: `export const value = ${literal};` };
      }
      const result = await incrementalBuild(options, { root, stage });
      const compiled = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
      assert.equal(compiled.value, root, 'compiler ownership must not rewrite application values');
      assert.equal(options.absWorkingDir, root, 'the caller retains its lexical options');
      assert.equal(incrementalCompilerStats().projects[0].root, await canonicalRoot(actual));
      await closeIncrementalCompiler(actual);
      assert.equal(incrementalCompilerStats().contexts, 0, 'canonical ownership still disposes a lexical graph');
    } finally {
      await closeIncrementalCompiler();
      await rm(parent, { recursive: true, force: true });
    }
  });
}

test('retargeting a lexical root keeps each canonical compiler owner independently disposable', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-retarget-'));
  const first = path.join(parent, 'first'), second = path.join(parent, 'second'), alias = path.join(parent, 'alias');
  try {
    await Promise.all([first, second].map(root => mkdir(path.join(root, 'stage'), { recursive: true })));
    await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const stage = path.join(alias, 'stage');
    const options = {
      absWorkingDir: alias,
      stdin: { contents: 'export const value = 1;', resolveDir: alias },
      outfile: path.join(stage, 'entry.mjs'),
      bundle: true,
      format: 'esm',
      write: false,
    };
    await incrementalBuild(options, { root: alias, stage });
    await rm(alias, { recursive: true });
    await symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await incrementalBuild(options, { root: alias, stage });
    const firstOwner = await canonicalRoot(first), secondOwner = await canonicalRoot(second);
    assert.deepEqual(incrementalCompilerStats().projects.map(project => project.root).sort(), [firstOwner, secondOwner].sort());
    assert.equal(incrementalCompilerStats().contexts, 2, 'the same lexical root cannot reuse another canonical owner');
    await closeIncrementalCompiler(second);
    assert.deepEqual(incrementalCompilerStats().projects.map(project => project.root), [firstOwner]);
    assert.equal(incrementalCompilerStats().contexts, 1, 'closing the new owner preserves the old owner');
    await closeIncrementalCompiler(first);
    assert.equal(incrementalCompilerStats().contexts, 0);
  } finally {
    await closeIncrementalCompiler();
    await rm(parent, { recursive: true, force: true });
  }
});

test('staging entries through a root alias rebind canonical resolver paths and current load hooks', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'prnext-incremental-stage-alias-'));
  const actual = path.join(parent, 'actual'), alias = path.join(parent, 'alias');
  const loaded = [], resolved = [];
  try {
    await mkdir(actual);
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    async function compile(generation) {
      const stage = path.join(alias, 'build-' + generation), entries = path.join(stage, '.entries');
      await mkdir(entries, { recursive: true });
      const entry = path.join(entries, 'entry.js'), dependency = path.join(entries, 'dependency.js');
      await writeFile(entry, 'import value from "./dependency.js"; export default value;');
      await writeFile(dependency, `export default ${JSON.stringify('source-' + generation)};`);
      const result = await incrementalBuild({
        absWorkingDir: alias,
        entryPoints: [entry],
        outdir: path.join(stage, 'out'),
        bundle: true,
        format: 'esm',
        write: false,
        metafile: true,
        plugins: [{ name: 'canonical-stage-fixture', setup(builder) {
          // Real resolvers may return canonical files, just as esbuild does on
          // macOS when /var is an alias of /private/var.
          builder.onResolve({ filter: /entry\.js$/ }, async args => {
            resolved.push(args.path);
            assert.equal(args.path, entry);
            return { path: await canonicalRoot(args.path) };
          });
          builder.onLoad({ filter: /dependency\.js$/, namespace: 'file' }, async args => {
            loaded.push(args.path);
            assert.equal(args.path, dependency);
            return { contents: (await readFile(args.path, 'utf8')).replace('source-', 'hook-' + generation + '-'), loader: 'js' };
          });
        } }],
      }, { root: alias, stage });
      const compiled = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
      assert.equal(compiled.default, `hook-${generation}-${generation}`);
      assert.ok(result.outputFiles.every(file => file.path.startsWith(stage + path.sep)));
      assert.ok(!JSON.stringify(result.metafile).includes('.prnext-incremental-stage'));
    }
    const before = incrementalCompilerStats();
    await compile(1);
    await compile(2);
    const after = incrementalCompilerStats();
    assert.equal(after.created - before.created, 1);
    assert.equal(after.reused - before.reused, 1, 'canonical stage paths must not create a new graph for each generation');
    assert.equal(loaded.length, 2);
    assert.equal(resolved.length, 2);
    await closeIncrementalCompiler(actual);
    assert.equal(incrementalCompilerStats().contexts, 0);
  } finally {
    await closeIncrementalCompiler();
    await rm(parent, { recursive: true, force: true });
  }
});
