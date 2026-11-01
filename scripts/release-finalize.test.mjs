import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finalizeRelease, githubClient, releaseNotes, parseFinalizationArguments, checkFinalizationEnvironment } from './release-finalize.mjs';
import { releasePackages } from './release-publish.mjs';

const version = '0.1.19-alpha';
const sourceSha = 'a'.repeat(40);
const sourceTree = 'b'.repeat(40);
const releaseCommit = 'c'.repeat(40);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const env = {
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  GITHUB_REPOSITORY: 'Lorkydey/PRNext', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'Lorkydey/PRNext/.github/workflows/publish.yml@refs/heads/main',
  GITHUB_SHA: 'd'.repeat(40), GITHUB_TOKEN: 'test-only-github-token',
};
const changelog = `# Changelog

## Unreleased — ${version} candidate

This work is not published on npm. Private maintainer preface.

- Preserve state through compatible updates.
- Compile eligible client imports on first use.

## 0.1.18-alpha

- An older release must not be copied.
`;

function tar(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    const octal = (offset, length, number) => header.write(number.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    header.write(name);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, bytes.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-release-finalize-'));
  const ownedRoot = await realpath(root);
  const ownedParent = await realpath(tmpdir());
  t.after(async () => {
    assert.equal(path.dirname(ownedRoot), ownedParent);
    assert.ok(path.basename(ownedRoot).startsWith('prnext-release-finalize-'));
    await rm(ownedRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'archives'));
  await mkdir(path.join(root, 'receipts'));
  const packages = [];
  const archiveBytes = new Map();
  for (const target of releasePackages) {
    const manifest = { name: target.name, version, repository: { url: 'git+https://github.com/Lorkydey/PRNext.git' }, publishConfig: { access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org/' } };
    const files = {};
    let binary;
    if (target.platform) {
      binary = Buffer.from('synthetic-native-' + target.platform);
      Object.assign(manifest, { os: [target.os], cpu: [target.cpu], ...(target.libc ? { libc: [target.libc] } : {}) });
      files['package/native.json'] = JSON.stringify({ id: target.platform, package: target.name, version, os: target.os, cpu: target.cpu, ...(target.libc ? { libc: target.libc } : {}), sha256: sha256(binary) });
      files['package/bin/prnext' + (target.os === 'win32' ? '.exe' : '')] = binary;
    } else {
      manifest.optionalDependencies = Object.fromEntries(releasePackages.filter(item => item.platform).map(item => [item.name, version]));
    }
    files['package/package.json'] = JSON.stringify(manifest);
    const bytes = tar(files);
    const filename = target.name.replace(/^@/, '').replaceAll('/', '-') + '-' + version + '.tgz';
    await writeFile(path.join(root, 'archives', filename), bytes);
    packages.push({ name: target.name, version, filename, size: bytes.length, sha256: sha256(bytes), integrity: integrity(bytes), kind: target.platform ? 'native' : 'framework', ...(target.platform ? { platform: target.platform, binarySha256: sha256(binary) } : {}), registry: { status: 'absent' } });
    archiveBytes.set(target.name, bytes);
  }
  const framework = packages.find(item => item.kind === 'framework');
  for (const native of packages.filter(item => item.kind === 'native')) {
    for (const strategy of ['hoisted', 'nested']) {
      const receipt = {
        package: '@thomas.f/prnext', version, platform: native.platform, strategy, node: 'v22.23.4',
        generatedAt: '2026-11-01T00:00:00.000Z',
        checks: Array.from({ length: 13 }, (_, index) => 'Verified independent installation check ' + (index + 1)),
        cli: { command: 'prnext', shortcut: 'prn', shortcutAvailable: true, osRelease: '6.8.0-azure' },
        archives: [framework, native].map(item => ({ filename: item.filename, size: item.size, integrity: item.integrity })),
        sha256: Object.fromEntries([framework, native].map(item => [item.filename, item.sha256])),
      };
      if (native.platform === 'win32-x64-msvc') Object.assign(receipt.cli, { shortcutAvailable: false, reason: 'Windows reserves PRN as a device name; use prnext.' });
      await writeFile(path.join(root, 'receipts', `verified-${native.platform}${strategy === 'nested' ? '-nested' : ''}.json`), JSON.stringify(receipt));
    }
    for (const major of [22, 24, 26]) {
      const receipt = { platform: native.platform, node: `v${major}.22.1`, binarySha256: native.binarySha256, mainArchiveSha256: framework.sha256, nativeArchiveSha256: native.sha256, tests: ['shutdown-after', 'actions', 'app'], passed: true, code: 0, signal: null };
      await writeFile(path.join(root, 'receipts', `lifecycle-${native.platform}-node${major}.json`), JSON.stringify(receipt));
    }
  }
  const runs = Object.fromEntries(['ci', 'artifacts', 'performance'].map((name, index) => [name, { id: index + 1, attempt: 1, sha: sourceSha, conclusion: 'success', jobs: [{ id: index + 10, name: 'must-not-appear-either', conclusion: 'success' }] }]));
  const plan = { schemaVersion: 1, repository: 'Lorkydey/PRNext', releaseVersion: version, sourceSha, sourceTree, releaseCommit, releaseTree: sourceTree, packages, runs, counts: { archives: 7, installations: 12, lifecycleReports: 18, frameworkFiles: 436 } };
  const planFile = path.join(root, 'plan.json');
  const planData = Buffer.from(JSON.stringify(plan));
  await writeFile(planFile, planData);
  const verification = {
    schemaVersion: 1, status: 'passed', passed: true, complete: true, version, sourceSha, sourceTree, releaseCommit, planSha256: sha256(planData),
    packages: packages.map(({ name, version, filename, size, sha256, integrity }) => ({ name, version, filename, size, sha256, integrity, tags: { alpha: version, latest: version } })), distTagsVerified: true,
    privatePath: 'must-not-appear', journal: { pid: 123, token: 'must-not-appear' },
  };
  const verificationFile = path.join(root, 'verification.json');
  await writeFile(verificationFile, JSON.stringify(verification));
  return { root, plan, verification, archiveBytes, options: { plan: planFile, directory: root, planSha256: sha256(planData), verification: verificationFile } };
}

function harness(f, settings = {}) {
  const events = [];
  const mutations = [];
  const assets = new Map();
  const bytes = new Map();
  let tag = settings.tag ?? null;
  let release = settings.release ? { id: 99, tag_name: 'v' + version, target_commitish: releaseCommit, prerelease: true, draft: true, ...settings.release } : null;
  const fetcher = async (input, options) => {
    const url = new URL(input);
    const decoded = decodeURIComponent(url.pathname);
    assert.equal(url.origin, 'https://registry.npmjs.org');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers?.Authorization, undefined, 'Registry reads must not receive the GitHub token');
    events.push('registry:' + decoded);
    if (decoded.startsWith('/archives/')) {
      const name = decoded.slice('/archives/'.length, -4);
      return new Response(settings.corruptArchive === name ? Buffer.from('corrupt') : f.archiveBytes.get(name));
    }
    if (decoded.startsWith('/-/package/')) {
      const name = decoded.slice('/-/package/'.length, -'/dist-tags'.length);
      return Response.json({ alpha: settings.wrongTags === name ? '0.1.18-alpha' : version, latest: version });
    }
    const record = f.plan.packages.find(item => decoded === '/' + item.name + '/' + item.version);
    assert.ok(record, 'Unexpected registry URL');
    if (settings.registryFailure === record.name) return new Response(null, { status: 503 });
    return Response.json({ name: record.name, version, dist: { integrity: record.integrity, tarball: settings.foreignArchive === record.name ? 'https://untrusted.invalid/archive.tgz' : 'https://registry.npmjs.org/archives/' + encodeURIComponent(record.name) + '.tgz' } });
  };
  const result = (status, value) => ({ status, value });
  const github = {
    async get(resource) {
      events.push('GET:' + resource);
      if (resource.includes('/commits/')) {
        const sha = resource.split('/').at(-1);
        return result(200, { sha, commit: { tree: { sha: settings.wrongCommit && sha === releaseCommit ? 'e'.repeat(40) : sourceTree } } });
      }
      if (resource.includes('/git/ref/tags/')) return tag ? result(200, { object: { type: 'commit', sha: tag } }) : result(404, {});
      if (resource.includes('/assets?')) return result(200, [...assets.values()]);
      if (resource.includes('/releases?')) return result(200, release ? [release] : []);
      assert.fail('Unexpected GitHub read');
    },
    async post(resource, body) {
      events.push('POST:' + resource);
      mutations.push({ resource, body });
      if (resource.endsWith('/git/refs')) {
        assert.equal(body.sha, releaseCommit, 'Tag must point to the qualified release commit, never the workflow commit');
        tag = body.sha;
        return result(201, { ref: body.ref, object: { type: 'commit', sha: body.sha } });
      }
      assert.ok(resource.endsWith('/releases'));
      assert.equal(body.draft, true);
      assert.equal(body.prerelease, true);
      release = { id: 99, ...body };
      return result(201, release);
    },
    async upload(id, asset) {
      assert.equal(id, 99);
      assert.equal(release.draft, true, 'No asset may be added after publication');
      events.push('UPLOAD:' + asset.name);
      mutations.push({ upload: asset.name });
      const value = { id: assets.size + 1, name: asset.name, state: 'uploaded', size: asset.bytes.length, digest: 'sha256:' + asset.sha256 };
      assert.ok(!assets.has(asset.name), 'Existing assets must not be overwritten');
      assets.set(asset.name, value);
      bytes.set(asset.name, asset.bytes);
      return result(201, settings.badUploadDigest ? { ...value, digest: 'sha256:' + '0'.repeat(64) } : value);
    },
    async patch(resource, body) {
      events.push('PATCH:' + resource);
      mutations.push({ resource, body });
      assert.equal(assets.size, 40, 'All expected assets must be complete before publishing');
      assert.equal(body.draft, false);
      release = { ...release, ...body };
      return result(200, release);
    },
  };
  return { events, mutations, assets, bytes, get release() { return release; }, github, adapters: { env, fetch: fetcher, github, changelog } };
}

test('finalization rechecks seven public archives and tags, then publishes exactly forty bounded assets', async t => {
  const f = await fixture(t);
  const h = harness(f);
  const result = await finalizeRelease(f.options, h.adapters);
  assert.equal(result.status, 'published');
  assert.equal(result.commit, releaseCommit);
  assert.equal(result.assets, 40);
  assert.equal(h.events.filter(event => event.startsWith('registry:')).length, 21);
  const firstMutation = h.events.findIndex(event => event.startsWith('POST:'));
  assert.ok(firstMutation > h.events.findLastIndex(event => event.startsWith('registry:')));
  assert.equal(h.assets.size, 40);
  assert.equal(h.events.filter(event => event.startsWith('UPLOAD:')).length, 40);
  assert.equal(h.events.filter(event => event.startsWith('PATCH:')).length, 1);
  assert.equal(h.release.draft, false);
  assert.equal(h.release.make_latest, 'false');
  assert.doesNotMatch(h.release.body, /not published|Private maintainer|older release/);
  assert.match(h.release.body, /partial/);
  const names = [...h.bytes.keys()];
  assert.equal(names.filter(name => name.endsWith('.tgz')).length, 7);
  assert.equal(names.filter(name => name.startsWith('verified-')).length, 12);
  assert.equal(names.filter(name => name.startsWith('lifecycle-')).length, 18);
  assert.ok(!names.some(name => /plan|qualification|journal|^source\.json$|^provenance\.json$/.test(name)));
  const provenance = JSON.parse(h.bytes.get('source-provenance.json'));
  assert.equal(provenance.releaseCommit, releaseCommit);
  assert.equal(provenance.sourceTree, sourceTree);
  assert.equal(Object.keys(provenance.runs).length, 3);
  assert.equal(JSON.parse(h.bytes.get('registry-verification.json')).packages.length, 7);
  for (const name of names.filter(name => !name.endsWith('.tgz'))) assert.doesNotMatch(h.bytes.get(name).toString('utf8'), /must-not-appear|test-only-github-token|"pid"|"journal"|"privatePath"/);
  const sums = h.bytes.get('SHA256SUMS.txt').toString('utf8').trim().split('\n');
  assert.equal(sums.length, 39);
  for (const line of sums) {
    const [hash, name] = line.split('  ');
    assert.equal(hash, sha256(h.bytes.get(name)));
  }
});

test('registry unavailability, corrupt bytes, foreign origins and stale tags cause no GitHub mutation', async t => {
  const f = await fixture(t);
  for (const settings of [
    { registryFailure: '@thomas.f/prnext' },
    { corruptArchive: '@thomas.f/prnext' },
    { foreignArchive: '@thomas.f/prnext' },
    { wrongTags: '@thomas.f/prnext' },
  ]) {
    const h = harness(f, settings);
    await assert.rejects(finalizeRelease(f.options, h.adapters));
    assert.deepEqual(h.mutations, []);
  }
});

test('wrong release tree, conflicting existing tag and different release commit cannot be overwritten', async t => {
  const f = await fixture(t);
  for (const settings of [
    { wrongCommit: true },
    { tag: 'f'.repeat(40) },
    { tag: releaseCommit, release: { target_commitish: 'f'.repeat(40) } },
  ]) {
    const h = harness(f, settings);
    await assert.rejects(finalizeRelease(f.options, h.adapters));
    assert.deepEqual(h.mutations, []);
  }
});

test('publisher evidence from another commit, version or plan fails before any network request', async t => {
  const f = await fixture(t);
  for (const change of [value => { value.releaseCommit = 'f'.repeat(40); }, value => { value.planSha256 = 'f'.repeat(64); }, value => { value.version = '0.1.18-alpha'; }, value => { value.complete = false; }]) {
    const value = structuredClone(f.verification);
    change(value);
    await writeFile(f.options.verification, JSON.stringify(value));
    const h = harness(f);
    await assert.rejects(finalizeRelease(f.options, h.adapters));
    assert.deepEqual(h.events, []);
  }
});

test('an existing conflicting or unknown asset blocks all writes without deleting or replacing anything', async t => {
  const f = await fixture(t);
  for (const name of [f.plan.packages[0].filename, 'unexpected-private.json']) {
    const h = harness(f, { tag: releaseCommit, release: {} });
    h.assets.set(name, { name, state: 'uploaded', size: 1, digest: 'sha256:' + '0'.repeat(64) });
    await assert.rejects(finalizeRelease(f.options, h.adapters));
    assert.deepEqual(h.mutations, []);
    assert.equal(h.assets.size, 1);
  }
});

test('a missing digest after upload leaves the release draft and never retries the mutation', async t => {
  const f = await fixture(t);
  const h = harness(f, { badUploadDigest: true });
  await assert.rejects(finalizeRelease(f.options, h.adapters), /digest/);
  assert.equal(h.events.filter(event => event.startsWith('UPLOAD:')).length, 1);
  assert.equal(h.release.draft, true);
  assert.equal(h.events.filter(event => event.startsWith('PATCH:')).length, 0);
});

test('an already published matching release is idempotent only with all forty exact assets', async t => {
  const f = await fixture(t);
  const first = harness(f);
  await finalizeRelease(f.options, first.adapters);
  const existing = harness(f, { tag: releaseCommit, release: { draft: false } });
  for (const [name, value] of first.assets) existing.assets.set(name, value);
  const result = await finalizeRelease(f.options, existing.adapters);
  assert.equal(result.status, 'already-published');
  assert.deepEqual(existing.mutations, []);
  existing.assets.delete('SHA256SUMS.txt');
  await assert.rejects(finalizeRelease(f.options, existing.adapters), /incomplete/);
  assert.deepEqual(existing.mutations, []);
});

test('resuming a draft skips exact assets and never uploads an existing name again', async t => {
  const f = await fixture(t);
  const first = harness(f);
  await finalizeRelease(f.options, first.adapters);
  const resumed = harness(f, { tag: releaseCommit, release: {} });
  const [name, asset] = first.assets.entries().next().value;
  resumed.assets.set(name, asset);
  await finalizeRelease(f.options, resumed.adapters);
  assert.equal(resumed.events.filter(event => event.startsWith('UPLOAD:')).length, 39);
  assert.ok(!resumed.events.includes('UPLOAD:' + name));
  assert.ok(!resumed.mutations.some(value => value.resource?.endsWith('/git/refs')));
});

test('a private path or unrecognized field in an installation receipt blocks all writes', async t => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'receipts/verified-linux-x64-gnu.json');
  const original = JSON.parse(await readFile(filename, 'utf8'));
  for (const change of [receipt => { receipt.pid = 123; }, receipt => { receipt.checks[0] = 'Secret source C:\\Users\\private\\project'; }]) {
    const receipt = structuredClone(original);
    change(receipt);
    await writeFile(filename, JSON.stringify(receipt));
    const h = harness(f);
    await assert.rejects(finalizeRelease(f.options, h.adapters));
    assert.deepEqual(h.mutations, []);
  }
});

test('finalization rejects branch, workflow and OIDC escalation and parses only its four fixed arguments', () => {
  checkFinalizationEnvironment(env);
  for (const changed of [{ GITHUB_REF: 'refs/heads/untrusted' }, { GITHUB_WORKFLOW_REF: 'other/workflow' }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'unexpected-oidc' }]) assert.throws(() => checkFinalizationEnvironment({ ...env, ...changed }));
  assert.deepEqual(parseFinalizationArguments(['--plan', 'p', '--directory', 'd', '--plan-sha256', 'a'.repeat(64), '--verification', 'v']), { plan: 'p', directory: 'd', planSha256: 'a'.repeat(64), verification: 'v' });
  assert.throws(() => parseFinalizationArguments(['--plan', 'p', '--plan', 'q']));
  assert.throws(() => parseFinalizationArguments(['--token', 'secret']));
});

test('release notes use only the chosen version changes and omit the unpublished candidate preface', () => {
  const notes = releaseNotes({ releaseVersion: version, sourceSha, releaseCommit }, changelog);
  assert.match(notes, /Preserve state/);
  assert.doesNotMatch(notes, /not published|Private maintainer|older release/);
  assert.throws(() => releaseNotes({ releaseVersion: '0.1.20-alpha', sourceSha, releaseCommit }, changelog));
});

test('GitHub client scopes credentials to exact API and upload origins with redirects disabled', async () => {
  const calls = [];
  const client = githubClient({ token: 'test-token', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true });
  } });
  await client.get('/repos/Lorkydey/PRNext/releases?per_page=100&page=1');
  await client.upload(99, { name: 'archive.tgz', bytes: Buffer.from('data'), contentType: 'application/gzip' });
  assert.equal(new URL(calls[0].url).origin, 'https://api.github.com');
  assert.equal(new URL(calls[1].url).origin, 'https://uploads.github.com');
  for (const { options } of calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
  }
  await assert.rejects(client.get('/repos/attacker/other/releases'));
  await assert.rejects(client.get('https://untrusted.invalid/'));
  await assert.rejects(client.get('/repos/Lorkydey/PRNext/../other'));
  assert.equal(calls.length, 2);
});
