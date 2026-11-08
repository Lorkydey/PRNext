import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const report=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.equal(report.mode,'diagnostic');assert.equal(report.requestedSeconds,1200);
assert.equal(report.complete,true);assert.equal(report.qualified,false);
assert.equal(report.platform,'linux');assert.ok(report.sustainedSeconds>=1200);
assert.equal(report.resourceVerification.verified,true);
assert.equal(report.sourceBefore.clean,true);assert.deepEqual(report.sourceAfter,report.sourceBefore);
assert.equal(report.sourceBefore.commit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
assert.ok(report.archiveSource);assert.equal(report.nativeBuildAssociation.verifiedByWorkflow,true);
assert.ok(report.presentation.reads>0&&report.presentation.browserVisits>0);
if(report.presentation.eligible)assert.ok(report.presentation.compactReads>0);
else{assert.equal(report.presentation.compactReads,0);assert.ok(report.presentation.fallbackReason);}
assert.ok(report.observationCoverage.processes>=0.95&&report.observationCoverage.descriptors>=0.95);
assert.ok(report.counters.rotations>=2&&report.counters.renewedSessions>0);
assert.equal(report.databaseConnectionsAfterStop,0);assert.deepEqual(report.pageErrors,[]);
console.log(JSON.stringify({passed:true,mode:'twenty-minute diagnostic',twoHourQualified:false,source:report.sourceBefore.commit,sustainedSeconds:report.sustainedSeconds,counters:report.counters,presentation:report.presentation}));
