import assert from 'node:assert/strict';

const maximum = 2 * 1024 ** 2;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function registryAbsenceUrls(record) {
  assert.ok(typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 214);
  const url = 'https://registry.npmjs.org/' + encodeURIComponent(record.name);
  return [url, url + '?write=true'];
}

function metadata(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, 'Invalid reconciliation metadata size');
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf8', {fatal: true}).decode(bytes));
  } catch {
    throw Error('Invalid reconciliation metadata');
  }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid reconciliation metadata');
  return value;
}

// These views prove current registry absence, not rejection of an earlier PUT.
// Callers must first observe the exact version as absent, and must not replace
// any failed or contradictory read with an absent result.
export function confirmRegistryAbsenceViews(record, normalBytes, writeBytes) {
  assert.ok(typeof record.version === 'string' && record.version.length <= 100 && exactVersion.test(record.version));
  const views = [metadata(normalBytes), metadata(writeBytes)];
  for (const value of views) {
    assert.equal(value.name, record.name, 'Reconciliation package name differs');
    assert.ok(typeof value._rev === 'string' && /^[1-9]\d*-[a-f0-9]{1,100}$/.test(value._rev), 'Missing registry revision');
    assert.ok(value.versions && typeof value.versions === 'object' && !Array.isArray(value.versions), 'Missing registry versions');
    assert.ok(!Object.hasOwn(value.versions, record.version), 'Reconciled version is present');
    assert.ok(value.time && typeof value.time === 'object' && !Array.isArray(value.time), 'Missing registry timestamps');
    assert.ok(!Object.hasOwn(value.time, record.version), 'Reconciled version has a timestamp or tombstone');
    assert.ok(typeof value.time.modified === 'string' && value.time.modified.length <= 100 && Number.isFinite(Date.parse(value.time.modified)), 'Missing registry modification time');
    const tags = value['dist-tags'];
    assert.ok(tags && typeof tags === 'object' && !Array.isArray(tags), 'Missing registry tags');
    assert.ok(!Object.values(tags).includes(record.version), 'A registry tag references the reconciled version');
    for (const tag of ['alpha', 'latest']) {
      assert.ok(typeof tags[tag] === 'string' && tags[tag].length <= 100 && exactVersion.test(tags[tag]), 'Invalid registry tag');
    }
  }
  assert.equal(views[0]._rev, views[1]._rev, 'Registry revisions disagree');
  assert.equal(views[0].time.modified, views[1].time.modified, 'Registry modification times disagree');
  for (const tag of ['alpha', 'latest']) {
    assert.equal(views[0]['dist-tags'][tag], views[1]['dist-tags'][tag], 'Registry tags disagree');
  }
  return {
    name: record.name, version: record.version, status: 'absent',
    revision: views[1]._rev, modified: views[1].time.modified,
    tags: {alpha: views[1]['dist-tags'].alpha, latest: views[1]['dist-tags'].latest},
  };
}
