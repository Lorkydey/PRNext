import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDeploymentRetention} from './deployment-config.mjs';
import {validateProjectConfig} from './config.mjs';

test('deployment retention defaults are independent and explicit revocation is preserved',()=>{
  const first=validateDeploymentRetention(),second=validateDeploymentRetention();
  assert.deepEqual(first,{maxAge:3600,maxGenerations:2,maxBytes:64*1024*1024});
  first.maxAge=1;assert.equal(second.maxAge,3600);
  assert.equal(validateDeploymentRetention(false),false);
  const input={maxAge:120,maxBytes:1024};
  assert.deepEqual(validateDeploymentRetention(input),{maxAge:120,maxGenerations:2,maxBytes:1024});
  assert.deepEqual(input,{maxAge:120,maxBytes:1024});
  assert.equal(validateProjectConfig({deploymentRetention:false}).deploymentRetention,false);
  assert.deepEqual(validateProjectConfig({deploymentRetention:{maxGenerations:1}}).deploymentRetention,{maxAge:3600,maxGenerations:1,maxBytes:64*1024*1024});
});

test('deployment retention refuses unbounded or ambiguous policies',()=>{
  for(const value of [true,null,[],new Date(),{extra:1},{[Symbol('maxAge')]:1},{maxAge:0},{maxAge:86401},{maxAge:1.5},{maxGenerations:0},{maxGenerations:6},{maxBytes:1023},{maxBytes:256*1024*1024+1},{maxBytes:Infinity},{maxBytes:NaN}])assert.throws(()=>validateDeploymentRetention(value),/deploymentRetention/);
  assert.deepEqual(validateDeploymentRetention({maxAge:undefined}),validateDeploymentRetention());
});
