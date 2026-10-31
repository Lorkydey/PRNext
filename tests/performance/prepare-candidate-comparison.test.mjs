import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCandidateComparison,verifyArchiveSource} from './prepare-candidate-comparison.mjs';

test('controlled comparison refuses ambiguous source labels and unsafe affinity before any preparation',async()=>{
  for(const baseline of [undefined,'main','a'.repeat(39),'a'.repeat(41),'$(touch file)'])await assert.rejects(prepareCandidateComparison({baseline}),/exact baseline/);
  for(const affinityCpus of [undefined,'0;echo','0 1','-1'])await assert.rejects(prepareCandidateComparison({baseline:'a'.repeat(40),affinityCpus}),/CPU affinity/);
  await assert.rejects(verifyArchiveSource('unused','main'),/exact Git/);
});
