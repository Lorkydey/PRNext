import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
  symlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sourceCommand, fetchSourceManifest, sourceRetry } from './cloud/source-sync.mjs';
import {
  readSourceState,
  writeSourceState,
  planPull,
  applyPull,
  recoverPull,
  scanLocalSource
} from './cloud/source-local.mjs';
import { readState, writeState, linkPath } from './cloud/state.mjs';
import { parseCloudArgs } from './cloud/client.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  origin = 'https://app.example.test',
  caps = {
    protocol: 1,
    chunkBytes: 1048576,
    readBytes: 262144,
    fileBytes: 64 * 1048576,
    sourceBytes: 500 * 1048576,
    maxFiles: 15000,
    maxChanges: 15000
  },
  encode = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value));
test('source retries respect rate limits, remain bounded and stop after cancellation', async () => {
  const waits = [];
  let calls = 0;
  const answer = await sourceRetry(
    async () => {
      if (++calls < 3)
        throw Object.assign(Error('Busy'), { status: 429, retryAfter: 90 });
      return 'saved';
    },
    { wait: async (ms) => waits.push(ms) }
  );
  assert.equal(answer, 'saved');
  assert.deepEqual(waits, [30000, 30000]);
  calls = 0;
  await assert.rejects(
    sourceRetry(
      async () => {
        calls++;
        throw Object.assign(Error('Down'), { status: 503 });
      },
      { wait: async () => {} }
    ),
    /Down/
  );
  assert.equal(calls, 6);
  const abort = new AbortController();
  calls = 0;
  await assert.rejects(
    sourceRetry(
      async () => {
        calls++;
        throw Object.assign(Error('Busy'), { status: 429 });
      },
      { signal: abort.signal, wait: async () => abort.abort() }
    ),
    { name: 'AbortError' }
  );
  assert.equal(calls, 1);
});
async function fixture(t, { provider = 'prnext' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'prnext-source-cli-')),
    root = path.join(dir, 'project');
  await mkdir(root);
  t.after(async () => {
    const target = path.resolve(dir);
    assert.ok(
      target.startsWith(path.resolve(tmpdir()) + path.sep) &&
        path.basename(target).startsWith('prnext-source-cli-')
    );
    await rm(target, { recursive: true, force: true });
  });
  const id = randomUUID(),
    identity = {
      user: { email: 'fixture@example.invalid' },
      workspace: { id: 'w' },
      capabilities: { sourceSync: { protocol: 1 } }
    },
    versions = new Map(),
    changesets = new Map(),
    deployments = new Map(),
    calls = [],
    log = [];
  let head,
    loseCommit = false,
    loseChunk = false,
    badDownload = false,
    pageSize = 1000,
    deploymentDenied = false,
    pr = 0;
  function save(files) {
    head = randomUUID();
    versions.set(
      head,
      new Map(Object.entries(files).map(([name, value]) => [name, encode(value)]))
    );
    return head;
  }
  save({ 'index.html': '<h1>Initial</h1>', 'keep.txt': 'Keep', 'remove.txt': 'Delete' });
  function manifest(revision = head, offset = 0) {
    const map = versions.get(revision);
    if (!map) throw Error('Missing mock revision');
    const files = [...map]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }));
    return {
      provider,
      revision,
      sourceHash: hash(
        JSON.stringify(files.map(({ path, size, sha256 }) => [path, size, sha256]))
      ),
      files: files.slice(offset, offset + pageSize),
      totalFiles: files.length,
      nextOffset: offset + pageSize < files.length ? offset + pageSize : null,
      limits: caps,
      git:
        provider === 'github'
          ? {
              repository: 'owner/repo',
              commitSha: revision.replaceAll('-', '').padEnd(40, '0')
            }
          : null
    };
  }
  async function api(endpoint, { method = 'GET', body } = {}) {
    calls.push({ endpoint, method, body });
    const url = new URL(endpoint, origin),
      rootPath = '/projects/' + id,
      source = rootPath + '/source';
    if (url.pathname === rootPath)
      return {
        project: {
          id,
          sourceType: provider === 'github' ? 'github' : 'upload',
          workspaceId: 'w'
        },
        deployments: [...deployments.values()]
      };
    if (url.pathname === rootPath + '/deploy') {
      if (deploymentDenied)
        throw Object.assign(Error('Review billing before deploying.'), { status: 402 });
      let deployment = deployments.get(body.requestId);
      if (!deployment) {
        if (body.expectedSourceRevision !== head)
          throw Object.assign(Error('source_conflict'), { status: 409 });
        deployment = { id: randomUUID(), status: 'ready' };
        deployments.set(body.requestId, deployment);
      }
      return { deployment };
    }
    if (url.pathname === source)
      return manifest(
        url.searchParams.get('revision') || head,
        Number(url.searchParams.get('offset') || 0)
      );
    if (url.pathname === source + '/pull') return manifest();
    if (url.pathname === source + '/file') {
      const revision = url.searchParams.get('revision'),
        name = url.searchParams.get('path'),
        offset = Number(url.searchParams.get('offset')),
        length = Number(url.searchParams.get('length')),
        bytes = versions.get(revision).get(name);
      return {
        revision,
        path: name,
        offset,
        size: bytes.length,
        sha256: hash(bytes),
        encoding: 'base64',
        content: (badDownload
          ? Buffer.from('corrupt')
          : bytes.subarray(offset, offset + length)
        ).toString('base64')
      };
    }
    if (url.pathname === source + '/changesets') {
      const prior = changesets.get(body.requestId);
      if (prior)
        return { parts: prior.parts, ...(prior.result ? { result: prior.result } : {}) };
      if (body.baseRevision !== head)
        throw Object.assign(Error('Source conflict'), { status: 409 });
      changesets.set(body.requestId, { body, parts: [], chunks: new Map() });
      return { parts: [] };
    }
    const match = url.pathname.slice((source + '/changesets/').length).split('/'),
      change = changesets.get(match[0]);
    if (!change) throw Error('Unexpected API call ' + method + ' ' + endpoint);
    if (method === 'DELETE') {
      if (!change.result) changesets.delete(match[0]);
      return { ok: true };
    }
    if (match[1] === 'files') {
      const index = Number(match[2]),
        part = Number(match[4]),
        digest = hash(body);
      change.chunks.set(index + ':' + part, Buffer.from(body));
      change.parts.push({ fileIndex: index, part, digest });
      if (loseChunk) {
        loseChunk = false;
        throw Error('Lost chunk response');
      }
      return { digest };
    }
    if (match[1] === 'commit') {
      if (!change.result) {
        if (change.body.baseRevision !== head)
          throw Object.assign(Error('Source conflict'), { status: 409 });
        const files = new Map(versions.get(head));
        for (const [index, file] of change.body.changes.entries()) {
          if (file.remove) files.delete(file.path);
          else {
            const bytes = Buffer.concat(
              [...change.chunks]
                .filter(([key]) => key.startsWith(index + ':'))
                .sort(([a], [b]) => Number(a.split(':')[1]) - Number(b.split(':')[1]))
                .map(([, b]) => b)
            );
            assert.equal(hash(bytes), file.sha256);
            files.set(file.path, bytes);
          }
        }
        if (provider === 'github') {
          pr++;
          change.result = {
            provider,
            pending: true,
            pullRequest: { number: pr, url: 'https://github.com/owner/repo/pull/' + pr }
          };
          change.proposed = files;
        } else {
          const revision = save(Object.fromEntries(files));
          change.result = { provider, revision, uploadId: revision };
        }
      }
      if (loseCommit) {
        loseCommit = false;
        throw Error('Lost commit response');
      }
      return change.result;
    }
    return { result: change.result, parts: change.parts };
  }
  async function run(command, options = {}) {
    return sourceCommand(
      command,
      { timeout: 10, ...options },
      origin,
      root,
      await readState(linkPath(root)),
      api,
      identity,
      { log: (value) => log.push(value), signal: new AbortController().signal }
    );
  }
  return {
    dir,
    root,
    id,
    identity,
    versions,
    changesets,
    deployments,
    calls,
    log,
    api,
    run,
    save,
    get head() {
      return head;
    },
    get files() {
      return versions.get(head);
    },
    set loseCommit(value) {
      loseCommit = value;
    },
    set loseChunk(value) {
      loseChunk = value;
    },
    set badDownload(value) {
      badDownload = value;
    },
    set pageSize(value) {
      pageSize = value;
    },
    set deploymentDenied(value) {
      deploymentDenied = value;
    },
    set provider(value) {
      provider = value;
    }
  };
}
test('pull establishes a verified baseline and push transfers only additions, edits and explicit deletions', async (t) => {
  const f = await fixture(t);
  f.pageSize = 1;
  await f.run('pull', { project: f.id });
  assert.equal(
    await readFile(path.join(f.root, 'index.html'), 'utf8'),
    '<h1>Initial</h1>'
  );
  assert.equal((await readSourceState(f.root)).revision, f.head);
  await writeFile(path.join(f.root, 'index.html'), '<h1>Edited</h1>');
  await writeFile(path.join(f.root, 'added.txt'), 'New');
  await rm(path.join(f.root, 'remove.txt'));
  await writeFile(path.join(f.root, '.env'), 'SECRET=never-send');
  await mkdir(path.join(f.root, 'node_modules'));
  await writeFile(path.join(f.root, 'node_modules', 'private.js'), 'never-send');
  await f.run('push', { message: 'Team update' });
  assert.deepEqual([...f.files.keys()].sort(), ['added.txt', 'index.html', 'keep.txt']);
  const request = f.calls.find((c) => c.endpoint.endsWith('/changesets'));
  assert.deepEqual(request.body.changes.map((c) => c.path).sort(), [
    'added.txt',
    'index.html',
    'remove.txt'
  ]);
  assert.equal((await readSourceState(f.root)).revision, f.head);
  assert.equal(f.deployments.size, 0);
});
test('local edits are preserved on an unrelated pull and conflicting edits stop before any source replacement', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  await writeFile(path.join(f.root, 'keep.txt'), 'Local edit');
  f.save({ 'index.html': 'Remote edit', 'keep.txt': 'Keep', 'remove.txt': 'Delete' });
  await f.run('pull');
  assert.equal(await readFile(path.join(f.root, 'keep.txt'), 'utf8'), 'Local edit');
  assert.equal(await readFile(path.join(f.root, 'index.html'), 'utf8'), 'Remote edit');
  f.save({
    'index.html': 'New remote',
    'keep.txt': 'Conflicting remote',
    'remove.txt': 'Delete'
  });
  await assert.rejects(f.run('pull'), /overwrite local changes/);
  assert.equal(await readFile(path.join(f.root, 'index.html'), 'utf8'), 'Remote edit');
  assert.equal(await readFile(path.join(f.root, 'keep.txt'), 'utf8'), 'Local edit');
});
test('initial pull refuses an occupied directory and corrupt transfers never replace the current files', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'private.txt'), 'Keep me');
  await assert.rejects(f.run('pull', { project: f.id }), /empty directory/);
  await rm(path.join(f.root, 'private.txt'));
  f.badDownload = true;
  await assert.rejects(f.run('pull', { project: f.id }), /checksum|invalid source chunk/);
  assert.equal(
    await lstat(path.join(f.root, 'index.html')).then(
      () => true,
      () => false
    ),
    false
  );
  assert.equal(await readSourceState(f.root), null);
});
test('a stale push cannot overwrite another team member and dry run does not send source writes', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  await writeFile(path.join(f.root, 'index.html'), 'Local');
  f.save({ 'index.html': 'Other member', 'keep.txt': 'Keep', 'remove.txt': 'Delete' });
  const before = f.calls.length;
  await f.run('push', { 'dry-run': true });
  assert.ok(f.calls.slice(before).every((c) => c.method === 'GET'));
  await assert.rejects(f.run('push'), /source changed/);
  assert.equal(f.files.get('index.html').toString(), 'Other member');
});
test('lost chunk and commit responses resume the same push without duplicate source versions', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  await writeFile(path.join(f.root, 'new.bin'), Buffer.alloc(1048576 + 100, 93));
  f.loseChunk = true;
  await assert.rejects(f.run('push'), /Lost chunk/);
  assert.ok((await readSourceState(f.root)).pendingPush);
  f.loseCommit = true;
  await assert.rejects(f.run('push'), /Lost commit/);
  const revision = f.head;
  await f.run('push');
  assert.equal(f.head, revision);
  assert.equal(f.versions.size, 2);
  assert.equal(f.changesets.size, 1);
  assert.equal((await readSourceState(f.root)).pendingPush, undefined);
});
test('changing a pending push requires explicit cancellation and preserves committed source', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  await writeFile(path.join(f.root, 'index.html'), 'First edit');
  f.loseChunk = true;
  await assert.rejects(f.run('push'), /Lost chunk/);
  await writeFile(path.join(f.root, 'index.html'), 'Second edit');
  await assert.rejects(f.run('push'), /Local files changed/);
  await f.run('push', { cancel: true });
  await f.run('push');
  assert.equal(f.files.get('index.html').toString(), 'Second edit');
});
test('push --deploy pins its source version, keeps billing gates and retries a saved deployment request', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  await writeFile(path.join(f.root, 'index.html'), 'Deploy me');
  f.deploymentDenied = true;
  await assert.rejects(f.run('push', { deploy: true }), /billing/);
  const revision = f.head;
  assert.ok((await readSourceState(f.root)).pendingDeployment);
  assert.equal(f.versions.size, 2);
  f.deploymentDenied = false;
  await f.run('push', { deploy: true });
  assert.equal(f.head, revision);
  assert.equal(f.deployments.size, 1);
  const request = f.calls.find((c) => c.endpoint.endsWith('/deploy'));
  assert.equal(request.body.uploadId, revision);
  assert.equal(request.body.expectedSourceRevision, revision);
});
test('GitHub pushes create one reviewable PR, do not deploy and resume normal flow after merging and pulling', async (t) => {
  const f = await fixture(t, { provider: 'github' });
  await f.run('pull', { project: f.id });
  await writeFile(path.join(f.root, 'index.html'), 'PR change');
  await f.run('push');
  assert.equal(f.changesets.size, 1);
  assert.equal(f.deployments.size, 0);
  const state = await readSourceState(f.root);
  assert.match(state.submission.url, /github.com\/owner\/repo\/pull\/1/);
  await f.run('push');
  assert.equal(f.changesets.size, 1);
  await f.run('pull');
  assert.ok((await readSourceState(f.root)).submission);
  await assert.rejects(f.run('push', { deploy: true }), /Merge the pull request/);
  const proposed = [...f.changesets.values()][0].proposed;
  f.save(Object.fromEntries(proposed));
  await f.run('pull');
  assert.equal((await readSourceState(f.root)).submission, undefined);
  await f.run('push', { deploy: true });
  assert.equal(f.deployments.size, 1);
});
test('source replacements roll back if local installation fails and preserve the previous sync baseline', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  const previous = await readSourceState(f.root);
  f.save({ 'index.html': 'Next', 'keep.txt': 'New keep', 'remove.txt': 'Delete' });
  const next = await fetchSourceManifest(f.api, f.id),
    operations = await planPull(f.root, previous, next);
  await assert.rejects(
    applyPull(f.root, previous, next, operations, {
      download: async (file, destination) =>
        writeFile(destination, f.files.get(file.path)),
      saveLink: async () => {},
      onOperation: (index) => {
        if (index === 0) throw Error('Simulated filesystem interruption');
      }
    }),
    /Simulated/
  );
  assert.equal(
    await readFile(path.join(f.root, 'index.html'), 'utf8'),
    '<h1>Initial</h1>'
  );
  assert.equal(await readFile(path.join(f.root, 'keep.txt'), 'utf8'), 'Keep');
  assert.equal((await readSourceState(f.root)).revision, previous.revision);
  await recoverPull(f.root);
});
test('portable paths, source links and tampered manifests cannot escape the selected project', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  const outside = path.join(f.dir, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'Never touch');
  const link = path.join(f.root, 'linked');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Symlink creation is unavailable on this runner.');
      return;
    }
    throw error;
  }
  await assert.rejects(scanLocalSource(f.root, caps), /links/);
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'Never touch');
  await assert.rejects(
    planPull(f.root, await readSourceState(f.root), {
      files: [{ path: '../outside/secret.txt', size: 1, sha256: hash('x') }]
    }),
    /Unsafe/
  );
});
test('a process interruption during file installation is recoverable on the next command', async (t) => {
  const f = await fixture(t);
  await f.run('pull', { project: f.id });
  const before = await readSourceState(f.root);
  f.save({ 'index.html': 'Next', 'keep.txt': 'New keep', 'remove.txt': 'Delete' });
  const next = await fetchSourceManifest(f.api, f.id),
    operations = await planPull(f.root, before, next),
    module = new URL('./cloud/source-local.mjs', import.meta.url).href;
  const script = `import {applyPull} from ${JSON.stringify(module)};import {writeFile} from 'node:fs/promises';const [root,before,next,operations,contents]=process.argv.slice(1).map((v,i)=>i?JSON.parse(v):v);await applyPull(root,before,next,operations,{download:(file,destination)=>writeFile(destination,contents[file.path]),saveLink:async()=>{},onOperation:()=>process.exit(17)});`;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      f.root,
      JSON.stringify(before),
      JSON.stringify(next),
      JSON.stringify(operations),
      JSON.stringify(
        Object.fromEntries([...f.files].map(([name, bytes]) => [name, bytes.toString()]))
      )
    ],
    {
      env: { SystemRoot: process.env.SystemRoot },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10000
    }
  );
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 17, errors);
  assert.equal(await readFile(path.join(f.root, 'index.html'), 'utf8'), 'Next');
  await recoverPull(f.root);
  assert.equal(
    await readFile(path.join(f.root, 'index.html'), 'utf8'),
    '<h1>Initial</h1>'
  );
  assert.equal((await readSourceState(f.root)).revision, before.revision);
});
test('source options are explicit and credentials remain outside source folders', () => {
  assert.equal(
    parseCloudArgs('pull', ['new-site', '--project', randomUUID()]).directory,
    'new-site'
  );
  assert.equal(
    parseCloudArgs('push', ['--deploy', '--message', 'Team update']).deploy,
    true
  );
  assert.throws(() => parseCloudArgs('push', ['--force']), /Unknown/);
  assert.throws(() => parseCloudArgs('push', ['--cancel', '--deploy']), /on its own/);
  assert.throws(() => parseCloudArgs('pull', ['--revision', 'bad']), /version ID/);
});
