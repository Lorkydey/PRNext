import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {binary} from './support.mjs';
import {buildStatic} from '../packages/prnext/build/static-adapter.mjs';

test('CLI inspect captures native contention counters and exports the real bounded HTTP sample', {timeout:30000}, async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-inspect-cli-'));
  const cli=fileURLToPath(new URL('../packages/prnext/cli.mjs',import.meta.url));
  let child;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/index.html'),'<h1>Inspection fixture</h1>');await buildStatic(root);
  const env={...process.env,PRNEXT_BINARY:binary};delete env.PRNEXT_METRICS_FILE;delete env.PRNEXT_INSPECT_DIR;
  child=spawn(process.execPath,[cli,'start',root,'--hostname','127.0.0.1','--port','0','--inspect'],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  let url;
  for(let i=0;i<100;i++){url=/http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];if(url)break;assert.equal(child.exitCode,null,output);await delay(50);}
  assert.ok(url,output);for(let i=0;i<4;i++)assert.equal((await fetch(url)).status,200);
  let report;
  for(let i=0;i<30;i++){
    report=JSON.parse((await promisify(execFile)(process.execPath,[cli,'inspect',root,'--json'],{env})).stdout);
    if(report.summary.requests>=4&&report.summary.runtimeSampleAt)break;await delay(100);
  }
  assert.ok(report.summary.requests>=4);assert.equal(report.summary.queuedJobs,0);assert.equal(report.summary.workerRssBytes,null);assert.ok(report.summary.p50Ms>=0);
  const otlp=JSON.parse((await promisify(execFile)(process.execPath,[cli,'inspect',root,'--otlp'],{env})).stdout);
  const metric=otlp.resourceMetrics[0].scopeMetrics[0].metrics[0];assert.equal(metric.name,'prnext.http.response.headers.duration');assert.ok(metric.histogram.dataPoints.length>0);
});
