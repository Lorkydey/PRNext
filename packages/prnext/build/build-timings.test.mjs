import test from 'node:test';
import assert from 'node:assert/strict';
import {withBuildTimings, measureBuildPhase} from './build-timings.mjs';

test('build timings measure awaited work and keep nested phases explicitly non-additive', async () => {
  let now = 0;
  const measured = await withBuildTimings(async () => {
    return measureBuildPhase('app', async () => {now += 2; await measureBuildPhase('compiler-browser', async () => {now += 5;}); now += 3; return 42;});
  }, () => now);
  assert.equal(measured.result, 42); assert.equal(measured.timings.totalMilliseconds, 10);
  assert.equal(measured.timings.nestedPhasesAreAdditive, false);
  assert.deepEqual(measured.timings.phases.app, {calls: 1, failedCalls: 0, milliseconds: 10});
  assert.equal(measured.timings.phases['compiler-browser'].milliseconds, 5);
});

test('timing failures preserve error identity and primitive/frozen rejection values', async () => {
  for (const value of [new Error('original build failure'), Object.freeze(new Error('frozen')), 'primitive']) {
    let now = 0;
    await assert.rejects(withBuildTimings(() => measureBuildPhase('standalone', async () => {now += 7; throw value;}), () => now), error => {
      assert.equal(error, value);
      if (value instanceof Error && !Object.isFrozen(value)) assert.deepEqual(value.buildTimings.phases.standalone, {calls: 1, failedCalls: 1, milliseconds: 7});
      return true;
    });
  }
});

test('independent build contexts do not mix phase timings', async () => {
  const results = await Promise.all([3, 9].map(duration => {
    let now = 0;
    return withBuildTimings(async () => {await measureBuildPhase('configuration', async () => {await new Promise(resolve => setImmediate(resolve)); now += duration;});}, () => now);
  }));
  assert.deepEqual(results.map(row => row.timings.phases.configuration.milliseconds), [3, 9]);
  assert.equal(await measureBuildPhase('configuration', async () => 5), 5);
  await assert.rejects(measureBuildPhase('/private/project/input', () => {}), /Unknown build timing phase/);
});
