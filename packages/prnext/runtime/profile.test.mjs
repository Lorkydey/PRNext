import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeProfile,rscResourceLimits } from './profile.mjs';
import presets from './profiles.json' with {type:'json'};

test('explicit nursery NODE_OPTIONS keep precedence in the RSC isolate as well as the host',()=>{
  for(const NODE_OPTIONS of ['--max-semi-space-size=8','--max_semi_space_size 8','--max-semi-space-size 12'])assert.equal(rscResourceLimits({PRNEXT_PROFILE:'memory',NODE_OPTIONS}),undefined);
  assert.deepEqual(rscResourceLimits({PRNEXT_PROFILE:'memory',NODE_OPTIONS:'--max-old-space-size=384'}),{maxYoungGenerationSizeMb:8});
  assert.equal(rscResourceLimits({NODE_ENV:'development'}),undefined);
});

test('native effective policy reaches RSC unchanged and malformed policies fail closed',()=>{
  const settings={...presets.speed,semiSpaceMiB:4,youngGenerationMiB:16,liveResponses:32};
  assert.deepEqual(runtimeProfile({PRNEXT_PROFILE:'speed',PRNEXT_EFFECTIVE_PROFILE:JSON.stringify(['speed',settings])}),{name:'speed',...settings});
  for(const value of ['bad',JSON.stringify(['memory',settings]),JSON.stringify(['speed',{...settings,youngGenerationMiB:0}]),JSON.stringify(['speed',{...settings,extra:true}])])assert.throws(()=>runtimeProfile({PRNEXT_PROFILE:'speed',PRNEXT_EFFECTIVE_PROFILE:value}),/effective runtime profile/);
});

test('production defaults to balanced, preserves profile overrides and rejects invalid names', () => {
  assert.equal(runtimeProfile({}).name, 'balanced');
  assert.equal(runtimeProfile({ PRNEXT_PROFILE: '' }).name, 'balanced');
  assert.equal(runtimeProfile({ PRNEXT_MEMORY_PROFILE: 'compact' }).name, 'compact');
  assert.equal(runtimeProfile({ PRNEXT_PROFILE: 'speed', PRNEXT_MEMORY_PROFILE: 'compact' }).name, 'speed');
  for (const name of ['cpu', 'fast', '__proto__', 'constructor'])
    assert.throws(() => runtimeProfile({ PRNEXT_PROFILE: name }), /Unknown runtime profile/);
});

test('standard is an alias of classic with the same historical settings', () => {
  const classic = runtimeProfile({ PRNEXT_PROFILE: 'classic' });
  assert.deepEqual(runtimeProfile({ PRNEXT_PROFILE: 'standard' }), classic);
  assert.deepEqual(runtimeProfile({ PRNEXT_PROFILE: 'standard', PRNEXT_MEMORY_PROFILE: 'compact' }), classic);
  assert.equal(classic.optimizeForSize, false);
  assert.equal(classic.semiSpaceMiB, null);
  assert.equal(classic.apiConcurrency, 512);
  assert.equal(classic.responseBufferMiB, 8);
});

test('idle retirement and memory admission preserve distinct profile budgets', () => {
  const balanced = runtimeProfile({ PRNEXT_PROFILE: 'balanced' });
  const memory = runtimeProfile({ PRNEXT_PROFILE: 'memory' });
  const speed = runtimeProfile({ PRNEXT_PROFILE: 'speed' });
  assert.equal(memory.renderIdleSeconds, 30);
  assert.equal(memory.renderStarts, 8);
  assert.equal(memory.liveResponses, 28);
  assert.equal(memory.responseBufferMiB, 1);
  assert.equal(balanced.optimizeForSize, false);
  assert.equal(balanced.semiSpaceMiB, 4);
  assert.equal(balanced.youngGenerationMiB, 16);
  assert.equal(balanced.renderIdleSeconds, 300);
  assert.equal(speed.renderIdleSeconds, null);
  assert.ok(speed.semiSpaceMiB > balanced.semiSpaceMiB);
  assert.ok(memory.liveResponses < balanced.liveResponses);
  assert.ok(balanced.liveResponses < speed.liveResponses);
  assert.ok(memory.responseBufferMiB < balanced.responseBufferMiB);
});

test('production policies do not change development or leak mutations across renderers', () => {
  assert.equal(runtimeProfile({ NODE_ENV: 'development' }).name, 'classic');
  for (const name of ['classic', 'standard', 'compact', 'balanced', 'speed', 'memory']) {
    const environment = { PRNEXT_PROFILE: name, NODE_ENV: 'development' };
    assert.equal(runtimeProfile(environment).name, 'classic');
    assert.equal(runtimeProfile(environment, true).name, name === 'standard' ? 'classic' : name);
    const settings = runtimeProfile(environment, true);
    settings.liveResponses = 0;
    assert.ok(runtimeProfile(environment, true).liveResponses > 0);
  }
});
