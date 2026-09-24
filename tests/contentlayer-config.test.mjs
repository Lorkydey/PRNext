import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {repositoryRoot} from './support.mjs';

test('Next config wrappers generate content from the explicit CLI application directory', async t => {
  const root = await mkdtemp(path.join(repositoryRoot,'.rustyx-content-config-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'pages'));
  await mkdir(path.join(root,'lib'));
  await writeFile(path.join(root,'package.json'),'{}');
  await writeFile(path.join(root,'seed.txt'),'content from project directory');
  await writeFile(path.join(root,'pages/index.jsx'), "import content from '../lib/generated.js';export default function Page(){return <h1>{content}</h1>}");
  await writeFile(path.join(root,'next.config.cjs'), `
    const fs=require('node:fs'),path=require('node:path');
    module.exports=()=>({
      onDemandEntries:{maxInactiveAge:3600000},turbopack:{root:process.cwd()},
      basePath:undefined,images:{unoptimized:undefined},
      webpack(config){
        config.watchOptions={ignored:['**/node_modules/!(.contentlayer)/**/*']};
        config.module.rules.push({test:/\\.m?js$/,type:'javascript/auto',resolve:{fullySpecified:false}});
        config.plugins.push({apply(compiler){compiler.hooks.beforeCompile.tapPromise('ContentGenerator',async()=>{
          for(const directory of [process.cwd(),process.env.INIT_CWD,process.env.PWD]){
            if(fs.realpathSync(directory)!==fs.realpathSync(__dirname))throw new Error('Incorrect plugin working directory');
          }
          fs.writeFileSync(path.join(__dirname,'lib/generated.js'),'export default '+JSON.stringify(fs.readFileSync('seed.txt','utf8')));
        });}});
        return config;
      }
    });
  `);
  const cli=path.join(repositoryRoot,'packages/rustyx/cli.mjs');
  const run=(...args)=>promisify(execFile)(process.execPath,[cli,...args],{cwd:repositoryRoot,env:{...process.env,INIT_CWD:repositoryRoot,PWD:repositoryRoot},timeout:60000});
  const check=JSON.parse((await run('check',root,'--json')).stdout);
  assert.equal(check.ok,true);
  assert.ok(check.notes.some(note=>note.includes('onDemandEntries')));
  await assert.rejects(access(path.join(root,'lib/generated.js')), {code:'ENOENT'});
  await run('build',root);
  const manifest=JSON.parse(await readFile(path.join(root,'.rustyx/manifest.json'),'utf8'));
  const home=manifest.prerendered.find(route=>route.path==='/');
  assert.match(await readFile(path.join(root,'.rustyx',home.file),'utf8'),/content from project directory/);
});
