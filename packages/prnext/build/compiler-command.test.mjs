import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build,disposeBuildSession} from './index.mjs';

const execute=promisify(execFile),repository=fileURLToPath(new URL('../../../',import.meta.url));
const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));

test('compiler CLI reports actual transforms and retains the last successful report after a failed build',async()=>{
  const root=await mkdtemp(path.join(repository,'.prnext-compiler-command-'));
  try {
    await writeFile(path.join(root,'package.json'),'{"private":true,"type":"module"}');
    await mkdir(path.join(root,'pages'));
    await writeFile(path.join(root,'prnext.config.mjs'),'export default {reactCompiler:true}');
    const source=`import {useState} from 'react';function OptOut(){'use no memo';return <p>Original</p>}export default function Page(){const [count,setCount]=useState(0);return <><button onClick={()=>setCount(count+1)}>{count}</button><OptOut/></>}`;
    await writeFile(path.join(root,'pages/index.jsx'),source);
    const result=await build(root,{dev:true,incremental:true});
    const command=async(...args)=>execute(process.execPath,[cli,'compiler',root,...args],{maxBuffer:2*1024*1024});
    const report=JSON.parse((await command('--json')).stdout);
    assert.equal(report.buildId,result.buildId);
    assert.equal(report.enabled,true);
    assert.ok(report.summary.optimized>0);
    assert.ok(report.files.flatMap(file=>file.functions).some(fn=>fn.name==='OptOut'&&fn.status==='skipped'));
    const text=(await command()).stdout;
    assert.match(text,/pages\/index.jsx/);assert.match(text,/OptOut.*skipped/);assert.match(text,/observed/i);
    await assert.rejects(command('--bogus','--json'),error=>{assert.equal(error.code,2);assert.match(JSON.parse(error.stdout).error,/accepts only/);return true;});

    await writeFile(path.join(root,'pages/index.jsx'),'export default function Page( {');
    await assert.rejects(build(root,{dev:true,incremental:true}));
    assert.deepEqual(JSON.parse((await command('--json')).stdout),report,'a failed staging generation never replaces the published report');

    const reportFile=path.join(result.outputDirectory,'react-compiler-report.json');
    await writeFile(reportFile,JSON.stringify({...report,buildId:'another-build'}));
    await assert.rejects(command('--json'),error=>{assert.equal(error.code,2);assert.match(JSON.parse(error.stdout).error,/stale/i);return true;});
    await writeFile(reportFile,JSON.stringify(report));
    await writeFile(path.join(root,'pages/index.jsx'),source);
    await writeFile(path.join(root,'prnext.config.mjs'),'export default {reactCompiler:false}');
    await build(root,{dev:true,incremental:true});
    const disabled=JSON.parse((await command('--json')).stdout);
    assert.equal(disabled.enabled,false);assert.equal(disabled.summary.optimized,0);
    assert.match((await command()).stdout,/disabled/);
    assert.doesNotMatch(await readFile(path.join(root,'.prnext/manifest.json'),'utf8'),/reactCompilerReport|observed-transforms/,'diagnostics do not enter runtime metadata');
  } finally {
    await disposeBuildSession(root);await rm(root,{recursive:true,force:true});
  }
});
