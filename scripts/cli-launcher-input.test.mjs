import test from 'node:test';
import assert from 'node:assert/strict';
import {executeLauncher} from './cli-launchers.mjs';

test('noninteractive launcher probes deliver EOF to a child that consumes input', async()=>{
  const script="let bytes=0;process.stdin.on('data',chunk=>bytes+=chunk.length);process.stdin.on('end',()=>process.stdout.write('EOF:'+bytes));";
  const result=await executeLauncher(process.execPath,['-e',script],{timeout:2000,windowsHide:true});
  assert.equal(result.stdout,'EOF:0');
});

test('launcher execution preserves exit codes and both output streams',async()=>{
  await assert.rejects(executeLauncher(process.execPath,['-e',"process.stdout.write('out');process.stderr.write('err');process.exitCode=7"],{timeout:2000,windowsHide:true}),error=>{
    assert.equal(error.code,7);assert.equal(error.stdout,'out');assert.equal(error.stderr,'err');return true;
  });
});
