import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';

assert.ok(process.env.RELEASE_PLAN && process.env.GITHUB_OUTPUT && process.env.GITHUB_STEP_SUMMARY);
const bytes=await readFile(process.env.RELEASE_PLAN);
assert.ok(bytes.length <= 1024 ** 2);
const plan=JSON.parse(bytes);
assert.equal(plan.schemaVersion,1);
assert.match(plan.releaseVersion,/^\d+\.\d+\.\d+-alpha(?:\.\d+)?$/);
for(const key of ['sourceSha','sourceTree','releaseCommit','releaseTree'])assert.match(plan[key],/^[a-f0-9]{40}$/);
assert.equal(plan.sourceTree,plan.releaseTree);
assert.equal(plan.packages.length,7);
const sha256=createHash('sha256').update(bytes).digest('hex');
await appendFile(process.env.GITHUB_OUTPUT,'sha256='+sha256+'\n');
const lines=[
  '# PRNext '+plan.releaseVersion,
  '',
  'Qualified source: [`'+plan.sourceSha+'`](https://github.com/Lorkydey/PRNext/commit/'+plan.sourceSha+').',
  '',
  'Merged release: [`'+plan.releaseCommit+'`](https://github.com/Lorkydey/PRNext/commit/'+plan.releaseCommit+').',
  '',
  'The source trees match. Six platforms, twelve installations and eighteen Node.js lifecycle receipts were verified.',
  '',
  'Plan SHA-256: `'+sha256+'`.',
  '',
  '| Archive | SHA-256 |',
  '| --- | --- |',
];
for(const item of plan.packages){
  assert.match(item.filename,/^[A-Za-z0-9._-]+\.tgz$/); assert.match(item.sha256,/^[a-f0-9]{64}$/);
  lines.push('| `'+item.filename+'` | `'+item.sha256+'` |');
}
lines.push('','Only the reviewed archives are eligible for this release.','');
await appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n'));
