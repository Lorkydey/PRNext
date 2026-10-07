import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('diagnostics keep valid UTF-8 events within their disk budget under bursts', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'prnext-diagnostic-budget-'));
  try {
    const source=`import diagnostics from ${JSON.stringify(new URL('../compat/diagnostics.cjs',import.meta.url).href)};
      for(let batch=0;batch<6;batch++) {for(let i=0;i<512;i++)diagnostics.record('sample',{message:'é'.repeat(1000)});await diagnostics.flush();}
      diagnostics.record('oversized',{message:'x'.repeat(10000)});await diagnostics.flush();`;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{env:{...process.env,PRNEXT_INSPECT_DIR:root}});
    const files=await readdir(root);assert.equal(files.length,2);
    for(const name of files){assert.ok((await stat(path.join(root,name))).size<=1024*1024);for(const line of (await readFile(path.join(root,name),'utf8')).trim().split('\n')){const event=JSON.parse(line);assert.equal(event.type,'sample');assert.equal(event.message,'é'.repeat(1000));}}
  } finally {await rm(root,{recursive:true,force:true});}
});
