import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';
import { loadPublishInputs, releasePackages } from './release-publish.mjs';

const repository = 'Lorkydey/PRNext';
const registry = 'https://registry.npmjs.org/';
const shaPattern = /^[a-f0-9]{64}$/;
const gitPattern = /^[a-f0-9]{40}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function object(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
}

function keys(value, allowed, label) {
  object(value, label);
  assert.ok(Object.keys(value).every(key => allowed.includes(key)), `Unexpected ${label} field`);
}

async function readRegular(filename, maximum) {
  const stat = await lstat(filename);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'Expected a bounded regular evidence file');
  const bytes = await readFile(filename);
  assert.equal(bytes.length, stat.size, 'Evidence changed during reading');
  return bytes;
}

async function responseBytes(response, maximum) {
  assert.ok(response.body, 'Response body is missing');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= maximum, 'Response exceeds its size bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function publicPackage(record) {
  return {
    name: record.name, version: record.version, filename: record.filename,
    size: record.size, sha256: record.sha256, integrity: record.integrity,
  };
}

export function checkFinalizationEnvironment(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.RUNNER_OS, 'Linux');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/publish.yml@refs/heads/main`);
  assert.ok(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN, 'Scoped GitHub token is required');
  for (const [name, value] of Object.entries(env)) {
    assert.ok(!value || !/^ACTIONS_ID_TOKEN_REQUEST_/i.test(name), 'Finalization must not receive OIDC permissions');
  }
}

export function checkPublicationVerification(value, input) {
  const { plan, planSha256, records } = input;
  object(value, 'publication verification');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'passed');
  assert.equal(value.passed, true);
  assert.equal(value.complete, true);
  assert.equal(value.distTagsVerified, true);
  for (const [name, expected] of Object.entries({ version: plan.releaseVersion, sourceSha: plan.sourceSha, sourceTree: plan.sourceTree, releaseCommit: plan.releaseCommit, planSha256 })) {
    assert.equal(value[name], expected, 'Publication evidence belongs to different release inputs');
  }
  assert.ok(Array.isArray(value.packages) && value.packages.length === 7, 'Seven verified packages are required');
  for (const record of records) {
    const matching = value.packages.filter(item => item.name === record.name);
    assert.equal(matching.length, 1, 'Publication package is missing or duplicated');
    assert.deepEqual(matching[0], { ...publicPackage(record), tags: { alpha: record.version, latest: record.version } });
  }
}

export async function verifyPublicRegistry(input, fetcher = fetch) {
  const packages = [];
  for (const record of input.records) {
    const response = await fetcher(registry + encodeURIComponent(record.name) + '/' + encodeURIComponent(record.version), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, 'Public registry version is unavailable');
    const manifest = JSON.parse((await responseBytes(response, 2 * 1024 ** 2)).toString('utf8'));
    assert.equal(manifest.name, record.name);
    assert.equal(manifest.version, record.version);
    assert.equal(manifest.dist?.integrity, record.integrity, 'Public registry integrity differs');
    const url = new URL(manifest.dist.tarball);
    assert.ok(url.origin === 'https://registry.npmjs.org' && !url.username && !url.password && !url.search && !url.hash, 'Unexpected registry archive origin');
    const archive = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.equal(archive.status, 200, 'Public registry archive is unavailable');
    const bytes = await responseBytes(archive, record.size);
    assert.equal(bytes.length, record.size);
    assert.equal(sha256(bytes), record.sha256, 'Public registry archive bytes differ');
    const tagsResponse = await fetcher(registry + '-/package/' + encodeURIComponent(record.name) + '/dist-tags', { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.equal(tagsResponse.status, 200, 'Public registry tags are unavailable');
    const tags = JSON.parse((await responseBytes(tagsResponse, 128 * 1024)).toString('utf8'));
    assert.equal(tags.alpha, record.version, 'Public alpha tag differs');
    assert.equal(tags.latest, record.version, 'Public latest tag differs');
    packages.push({ ...publicPackage(record), tags: { alpha: record.version, latest: record.version } });
  }
  assert.equal(packages.length, 7);
  return {
    schemaVersion: 1, status: 'passed', passed: true, complete: true,
    version: input.plan.releaseVersion, sourceSha: input.plan.sourceSha,
    sourceTree: input.plan.sourceTree, releaseCommit: input.plan.releaseCommit,
    packages, distTagsVerified: true,
  };
}

function sourceProvenance(input) {
  const { plan, records } = input;
  keys(plan.counts, ['archives', 'installations', 'lifecycleReports', 'frameworkFiles'], 'counts');
  assert.equal(plan.counts.archives, 7);
  assert.equal(plan.counts.installations, 12);
  assert.equal(plan.counts.lifecycleReports, 18);
  assert.ok(Number.isSafeInteger(plan.counts.frameworkFiles) && plan.counts.frameworkFiles > 0 && plan.counts.frameworkFiles <= 8192);
  keys(plan.runs, ['ci', 'artifacts', 'performance'], 'runs');
  const runs = {};
  for (const [name, workflow] of [['ci', 'ci.yml'], ['artifacts', 'npm-artifacts.yml'], ['performance', 'performance-qualification.yml']]) {
    const run = plan.runs[name];
    object(run, 'qualified run');
    assert.ok(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.attempt) && run.attempt > 0);
    assert.equal(run.sha, plan.sourceSha);
    assert.equal(run.conclusion, 'success');
    if (run.workflow !== undefined) assert.equal(run.workflow, `.github/workflows/${workflow}`);
    runs[name] = { id: run.id, attempt: run.attempt, sha: run.sha, conclusion: run.conclusion, workflow: `.github/workflows/${workflow}` };
  }
  return {
    schemaVersion: 1, repository, version: plan.releaseVersion,
    sourceSha: plan.sourceSha, sourceTree: plan.sourceTree,
    releaseCommit: plan.releaseCommit, releaseTree: plan.releaseTree,
    runs, counts: { ...plan.counts },
    archives: records.map(record => ({ ...publicPackage(record), kind: record.kind, ...(record.platform ? { platform: record.platform, binarySha256: record.binarySha256 } : {}) })),
  };
}

function publicText(value) {
  assert.ok(typeof value === 'string' && value.length <= 1024 && !/[\r\n\0]/.test(value), 'Invalid public evidence text');
  assert.doesNotMatch(value, /(?:[A-Za-z]:[\\/]|\/(?:home|Users|private|tmp|opt|var)\/|localhost|127\.0\.0\.1|\.npmrc|bearer\s|(?:auth|token|password|secret|cookie|session|pid)\s*[:=])/i, 'Private data is not allowed in release receipts');
}

async function receiptAsset(directory, filename, input, platform, strategy, major) {
  const bytes = await readRegular(path.join(directory, filename), 128 * 1024);
  const receipt = JSON.parse(bytes.toString('utf8'));
  const native = input.records.find(record => record.platform === platform);
  const framework = input.records.find(record => record.kind === 'framework');
  assert.equal(receipt.platform, platform);
  if (major) {
    keys(receipt, ['platform', 'node', 'binarySha256', 'mainArchiveSha256', 'nativeArchiveSha256', 'tests', 'passed', 'code', 'signal'], 'lifecycle receipt');
    assert.match(receipt.node, new RegExp(`^v${major}\\.\\d+\\.\\d+$`));
    assert.equal(receipt.binarySha256, native.binarySha256);
    assert.equal(receipt.mainArchiveSha256, framework.sha256);
    assert.equal(receipt.nativeArchiveSha256, native.sha256);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.code, 0);
    assert.equal(receipt.signal, null);
    assert.ok(Array.isArray(receipt.tests) && receipt.tests.length > 0 && receipt.tests.length <= 100);
    for (const name of receipt.tests) assert.match(name, /^[a-z0-9-]{1,80}$/);
  } else {
    keys(receipt, ['package', 'version', 'platform', 'strategy', 'node', 'generatedAt', 'checks', 'cli', 'archives', 'sha256'], 'installation receipt');
    assert.equal(receipt.package, '@thomas.f/prnext');
    assert.equal(receipt.version, input.plan.releaseVersion);
    assert.equal(receipt.strategy, strategy);
    assert.match(receipt.node, /^v(?:22|24|26)\.\d+\.\d+$/);
    assert.ok(typeof receipt.generatedAt === 'string' && new Date(receipt.generatedAt).toISOString() === receipt.generatedAt);
    assert.ok(Array.isArray(receipt.checks) && receipt.checks.length === 13);
    for (const check of receipt.checks) publicText(check);
    keys(receipt.cli, ['command', 'shortcut', 'shortcutAvailable', 'osRelease', 'reason'], 'CLI receipt');
    assert.equal(receipt.cli.command, 'prnext');
    assert.equal(receipt.cli.shortcut, 'prn');
    if (receipt.cli.shortcutAvailable === false) {
      assert.ok(platform.startsWith('win32-'), 'Only the Windows reserved-device exception is supported');
      assert.equal(receipt.cli.reason, 'Windows reserves PRN as a device name; use prnext.');
    } else {
      assert.equal(receipt.cli.shortcutAvailable, true);
      assert.equal(receipt.cli.reason, undefined);
    }
    assert.match(receipt.cli.osRelease, /^[0-9A-Za-z.+_()-]{1,100}$/);
    assert.ok(Array.isArray(receipt.archives) && receipt.archives.length === 2);
    const expected = [framework, native];
    for (const record of expected) {
      assert.deepEqual(receipt.archives.find(item => item.filename === record.filename), { filename: record.filename, size: record.size, integrity: record.integrity });
    }
    assert.deepEqual(receipt.sha256, Object.fromEntries(expected.map(record => [record.filename, record.sha256])));
  }
  return { name: filename, bytes, contentType: 'application/json' };
}

export async function releaseAssets(input, receiptDirectory, registryProof) {
  assert.ok((await lstat(receiptDirectory)).isDirectory(), 'Receipts must be in their regular qualified directory');
  const provenance = sourceProvenance(input);
  const assets = input.records.map(record => ({ name: record.filename, bytes: record.archive, contentType: 'application/gzip' }));
  for (const target of releasePackages.filter(item => item.platform)) {
    for (const strategy of ['hoisted', 'nested']) {
      const suffix = strategy === 'nested' ? '-nested' : '';
      assets.push(await receiptAsset(receiptDirectory, `verified-${target.platform}${suffix}.json`, input, target.platform, strategy));
    }
    for (const major of [22, 24, 26]) assets.push(await receiptAsset(receiptDirectory, `lifecycle-${target.platform}-node${major}.json`, input, target.platform, undefined, major));
  }
  assets.push({ name: 'source-provenance.json', bytes: jsonBytes(provenance), contentType: 'application/json' });
  assets.push({ name: 'registry-verification.json', bytes: jsonBytes(registryProof), contentType: 'application/json' });
  assets.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sums = assets.map(asset => `${sha256(asset.bytes)}  ${asset.name}`).join('\n') + '\n';
  assets.push({ name: 'SHA256SUMS.txt', bytes: Buffer.from(sums), contentType: 'text/plain; charset=utf-8' });
  assert.equal(assets.length, 40);
  assert.equal(new Set(assets.map(asset => asset.name)).size, 40);
  return assets.map(asset => ({ ...asset, sha256: sha256(asset.bytes) }));
}

export function releaseNotes(plan, changelog) {
  assert.ok(typeof changelog === 'string' && Buffer.byteLength(changelog) <= 1024 ** 2, 'Changelog exceeds its bound');
  const escaped = plan.releaseVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sections = [...changelog.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].filter(match => new RegExp(`(?:^|\\s)${escaped}(?:\\s|$|\\])`).test(match[1]));
  assert.equal(sections.length, 1, 'Expected one matching changelog section');
  const bullet = sections[0][2].search(/^[-*] /m);
  assert.ok(bullet >= 0, 'The release changelog has no changes');
  const changes = sections[0][2].slice(bullet).trim();
  assert.ok(Buffer.byteLength(changes) <= 64 * 1024, 'Release notes exceed their bound');
  return [
    `PRNext ${plan.releaseVersion} is available on npm as an alpha prerelease. Next.js compatibility remains partial; check your application's routes, forms, dependencies and production build before upgrading.`,
    '', '```sh', `npm install @thomas.f/prnext@${plan.releaseVersion}`, '```', '',
    'Keep the React protocol packages aligned with the package peer dependencies, then rebuild and restart your application.', '',
    'The attached archives passed the required CI, six-platform artifact qualification, twelve independent installations, eighteen Node.js lifecycle checks and the controlled performance gate. This does not establish a general speed gain, maximum capacity or absence of memory leaks.', '',
    `Qualified source: [${plan.sourceSha}](https://github.com/${repository}/commit/${plan.sourceSha}).`,
    `Release commit: [${plan.releaseCommit}](https://github.com/${repository}/commit/${plan.releaseCommit}).`,
    `Read the [compatibility guide](https://github.com/${repository}/blob/${plan.releaseCommit}/packages/prnext/docs/ai/compatibility.md).`, '',
    '## Changes', '', changes, '',
  ].join('\n');
}

export function githubClient({ token, fetchImpl = fetch }) {
  assert.ok(typeof token === 'string' && token, 'GitHub token is required');
  async function request(method, resource, body, { upload = false } = {}) {
    assert.ok(['GET', 'POST', 'PATCH'].includes(method), 'Unsupported GitHub operation');
    assert.ok(typeof resource === 'string' && resource.startsWith(`/repos/${repository}/`) && !resource.includes('..') && !resource.includes('#'), 'GitHub repository boundary rejected');
    const url = new URL(resource, upload ? 'https://uploads.github.com' : 'https://api.github.com');
    assert.equal(url.origin, upload ? 'https://uploads.github.com' : 'https://api.github.com');
    if (upload) assert.match(url.pathname, /^\/repos\/Lorkydey\/PRNext\/releases\/[1-9]\d*\/assets$/);
    const response = await fetchImpl(url.href, {
      method, redirect: 'error', signal: AbortSignal.timeout(upload ? 120_000 : 30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': upload ? body.contentType : 'application/json' } : {}) },
      ...(body ? { body: upload ? body.bytes : JSON.stringify(body) } : {}),
    });
    const bytes = await responseBytes(response, 8 * 1024 ** 2);
    const value = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
    assert.ok(response.ok || (method === 'GET' && response.status === 404), `GitHub request failed (HTTP ${response.status})`);
    return { status: response.status, value };
  }
  return {
    get: resource => request('GET', resource),
    post: (resource, value) => request('POST', resource, value),
    patch: (resource, value) => request('PATCH', resource, value),
    upload: (id, asset) => request('POST', `/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`, asset, { upload: true }),
  };
}

async function tagTarget(api, tag) {
  const response = await api.get(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (response.status === 404) return null;
  let object = response.value.object;
  const seen = new Set();
  for (let depth = 0; depth < 5; depth++) {
    assert.ok(object && gitPattern.test(object.sha) && !seen.has(object.sha), 'Invalid tag target');
    seen.add(object.sha);
    if (object.type === 'commit') return object.sha;
    assert.equal(object.type, 'tag', 'Tag does not identify a commit');
    const nested = await api.get(`/repos/${repository}/git/tags/${object.sha}`);
    assert.equal(nested.status, 200);
    object = nested.value.object;
  }
  throw new Error('Annotated tag chain exceeds its bound');
}

async function findRelease(api, tag) {
  for (let page = 1; page <= 10; page++) {
    const response = await api.get(`/repos/${repository}/releases?per_page=100&page=${page}`);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.value) && response.value.length <= 100, 'Invalid release inventory');
    const matches = response.value.filter(release => release.tag_name === tag);
    assert.ok(matches.length <= 1, 'Ambiguous existing release');
    if (matches.length) return matches[0];
    if (response.value.length < 100) return null;
  }
  throw new Error('Release inventory exceeds its bound');
}

async function releaseAssetInventory(api, id, assets, requireComplete = false) {
  assert.ok(Number.isSafeInteger(id) && id > 0, 'Invalid release ID');
  const response = await api.get(`/repos/${repository}/releases/${id}/assets?per_page=100&page=1`);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.value) && response.value.length <= 40, 'Unexpected release assets');
  const expected = new Map(assets.map(asset => [asset.name, asset]));
  const existing = new Set();
  for (const asset of response.value) {
    const wanted = expected.get(asset.name);
    assert.ok(wanted && !existing.has(asset.name), 'Unknown or duplicate existing release asset');
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, wanted.bytes.length, 'Existing release asset size conflict');
    assert.equal(asset.digest, 'sha256:' + wanted.sha256, 'Existing release asset digest conflict');
    existing.add(asset.name);
  }
  if (requireComplete) assert.equal(existing.size, 40, 'Published release assets are incomplete');
  return existing;
}

export async function finalizeRelease(options, adapters = {}) {
  const env = adapters.env || process.env;
  checkFinalizationEnvironment(env);
  const directory = await realpath(options.directory);
  assert.equal(await realpath(options.plan), path.join(directory, 'plan.json'), 'Plan is outside the qualified directory');
  const input = await loadPublishInputs({ ...options, directory: path.join(directory, 'archives') });
  const verification = JSON.parse((await readRegular(options.verification, 2 * 1024 ** 2)).toString('utf8'));
  checkPublicationVerification(verification, input);
  const registryProof = await verifyPublicRegistry(input, adapters.fetch || fetch);
  const assets = await releaseAssets(input, path.join(directory, 'receipts'), registryProof);
  const changelog = adapters.changelog ?? (await readRegular(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 1024 ** 2)).toString('utf8');
  const notes = releaseNotes(input.plan, changelog);
  const api = adapters.github || githubClient({ token: env.GITHUB_TOKEN, fetchImpl: adapters.githubFetch || fetch });
  for (const [commit, tree] of new Map([[input.plan.sourceSha, input.plan.sourceTree], [input.plan.releaseCommit, input.plan.releaseTree]])) {
    const response = await api.get(`/repos/${repository}/commits/${commit}`);
    assert.equal(response.status, 200);
    assert.equal(response.value.sha, commit, 'GitHub commit identity differs');
    assert.equal(response.value.commit?.tree?.sha, tree, 'GitHub source tree differs');
  }
  const tag = 'v' + input.plan.releaseVersion;
  const target = await tagTarget(api, tag);
  assert.ok(target === null || target === input.plan.releaseCommit, 'Existing release tag points to another commit');
  let release = await findRelease(api, tag);
  let existing = new Set();
  if (release) {
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, input.plan.releaseCommit, 'Existing release commit differs');
    assert.equal(release.prerelease, true, 'Existing release is not a prerelease');
    assert.equal(typeof release.draft, 'boolean');
    existing = await releaseAssetInventory(api, release.id, assets, !release.draft);
    if (!release.draft) {
      assert.equal(target, input.plan.releaseCommit, 'Published release has no matching tag');
      return { complete: true, status: 'already-published', tag, commit: input.plan.releaseCommit, assets: assets.length, url: `https://github.com/${repository}/releases/tag/${tag}` };
    }
  }
  // Every registry, source, receipt and conflict check above is read-only. No
  // mutation is retried automatically, and existing assets are never replaced.
  if (target === null) {
    const created = await api.post(`/repos/${repository}/git/refs`, { ref: 'refs/tags/' + tag, sha: input.plan.releaseCommit });
    assert.equal(created.status, 201);
    assert.equal(created.value.ref, 'refs/tags/' + tag);
    assert.equal(created.value.object?.sha, input.plan.releaseCommit);
  }
  if (!release) {
    const created = await api.post(`/repos/${repository}/releases`, { tag_name: tag, target_commitish: input.plan.releaseCommit, name: `PRNext ${input.plan.releaseVersion}`, body: notes, draft: true, prerelease: true, make_latest: 'false' });
    assert.equal(created.status, 201);
    release = created.value;
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, input.plan.releaseCommit);
    assert.equal(release.draft, true);
    assert.equal(release.prerelease, true);
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  }
  for (const asset of assets) {
    if (existing.has(asset.name)) continue;
    const uploaded = await api.upload(release.id, asset);
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.value.name, asset.name);
    assert.equal(uploaded.value.state, 'uploaded');
    assert.equal(uploaded.value.size, asset.bytes.length);
    assert.equal(uploaded.value.digest, 'sha256:' + asset.sha256, 'Uploaded asset digest differs');
  }
  await releaseAssetInventory(api, release.id, assets, true);
  assert.equal(await tagTarget(api, tag), input.plan.releaseCommit, 'Tag changed during finalization');
  const published = await api.patch(`/repos/${repository}/releases/${release.id}`, { draft: false, prerelease: true, make_latest: 'false', name: `PRNext ${input.plan.releaseVersion}`, body: notes });
  assert.equal(published.status, 200);
  assert.equal(published.value.draft, false);
  assert.equal(published.value.prerelease, true);
  assert.equal(published.value.tag_name, tag);
  assert.equal(published.value.target_commitish, input.plan.releaseCommit);
  return { complete: true, status: 'published', tag, commit: input.plan.releaseCommit, assets: assets.length, url: `https://github.com/${repository}/releases/tag/${tag}` };
}

export function parseFinalizationArguments(args) {
  const allowed = new Map([['--plan', 'plan'], ['--directory', 'directory'], ['--plan-sha256', 'planSha256'], ['--verification', 'verification']]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = allowed.get(args[index]);
    assert.ok(key && !Object.hasOwn(options, key) && args[index + 1] && !args[index + 1].startsWith('--'), 'Invalid finalization arguments');
    options[key] = args[index + 1];
  }
  assert.equal(Object.keys(options).length, allowed.size, 'Missing finalization arguments');
  assert.match(options.planSha256, shaPattern);
  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await finalizeRelease(parseFinalizationArguments(process.argv.slice(2)))));
  } catch (error) {
    console.error('Release finalization failed: ' + error.message);
    process.exitCode = 1;
  }
}
