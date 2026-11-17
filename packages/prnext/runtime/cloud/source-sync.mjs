import { readFile, open, mkdir, lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readState, writeState, linkPath, cloudOrigin } from './state.mjs';
import {
  SOURCE_PROTOCOL,
  SOURCE_CHUNK_BYTES,
  SOURCE_READ_BYTES
} from './source-policy.mjs';
import {
  readSourceState,
  writeSourceState,
  validateManifest,
  scanLocalSource,
  localFile,
  localHash,
  planPull,
  applyPull,
  recoverPull,
  safeCache
} from './source-local.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const clean = (value) => String(value || '').replace(/[\x00-\x1f\x7f]/g, '');
const prefix = (id) => '/projects/' + encodeURIComponent(id) + '/source';
export async function sourceRetry(operation, { signal, wait = delay } = {}) {
  for (let attempt = 0; ; attempt++)
    try {
      signal?.throwIfAborted();
      return await operation();
    } catch (error) {
      if (attempt >= 5 || ![408, 429, 503].includes(error.status)) throw error;
      await wait(
        error.retryAfter
          ? Math.min(30000, error.retryAfter * 1000)
          : Math.min(3000, 250 * 2 ** attempt),
        undefined,
        { signal }
      );
    }
}
function limits(value) {
  if (value?.protocol !== SOURCE_PROTOCOL || value.chunkBytes !== SOURCE_CHUNK_BYTES)
    throw Error('This Host server uses an unsupported source sync protocol.');
  const result = { ...value };
  for (const [key, max] of Object.entries({
    fileBytes: 64 * 1048576,
    sourceBytes: 500 * 1048576,
    maxFiles: 15000,
    readBytes: SOURCE_READ_BYTES,
    maxChanges: 15000
  })) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1)
      throw Error('The server returned invalid source limits.');
    result[key] = Math.min(value[key], max);
  }
  return result;
}
export async function fetchSourceManifest(
  api,
  projectId,
  { revision, refresh = false } = {}
) {
  let data = refresh
    ? await api(prefix(projectId) + '/pull', { method: 'POST', body: {} })
    : await api(prefix(projectId) + (revision ? '?revision=' + revision : ''));
  if (data.blocked)
    throw Error(
      'The workspace owner must authorize source access in this project’s Source settings.'
    );
  if (data.revision !== null && !uuid(data.revision))
    throw Error('The server returned an invalid source revision.');
  if (!['prnext', 'github'].includes(data.provider))
    throw Error('The server returned an invalid source provider.');
  const caps = limits(data.limits),
    first = data,
    files = [...(data.files || [])];
  let offset = files.length;
  while (data.nextOffset !== null) {
    if (!first.revision || data.nextOffset !== offset || files.length > caps.maxFiles)
      throw Error('The server returned invalid source pagination.');
    data = await api(
      prefix(projectId) +
        '?' +
        new URLSearchParams({
          revision: first.revision,
          offset: String(offset),
          limit: '1000'
        })
    );
    if (
      data.revision !== first.revision ||
      !Array.isArray(data.files) ||
      !data.files.length
    )
      throw Error('The source changed during download. Pull again.');
    files.push(...data.files);
    offset = files.length;
  }
  validateManifest(files, caps);
  if (files.length !== first.totalFiles)
    throw Error('The source manifest is incomplete.');
  if (
    first.revision &&
    hash(JSON.stringify(files.map(({ path, size, sha256 }) => [path, size, sha256]))) !==
      first.sourceHash
  )
    throw Error('The source manifest checksum is invalid.');
  return {
    version: 1,
    revision: first.revision,
    provider: first.provider,
    sourceHash: first.sourceHash || null,
    files,
    limits: caps,
    git: first.git || null,
    deployedRevision: first.deployedRevision || null
  };
}
async function downloadFile(api, projectId, revision, file, destination, signal) {
  const output = await open(destination, 'wx', 0o600),
    digest = createHash('sha256');
  let offset = 0;
  try {
    while (offset < file.size) {
      signal?.throwIfAborted();
      const result = await api(
        prefix(projectId) +
          '/file?' +
          new URLSearchParams({
            revision,
            path: file.path,
            offset: String(offset),
            length: String(Math.min(SOURCE_READ_BYTES, file.size - offset))
          })
      );
      if (
        result.revision !== revision ||
        result.path !== file.path ||
        result.offset !== offset ||
        result.size !== file.size ||
        result.sha256 !== file.sha256 ||
        result.encoding !== 'base64' ||
        typeof result.content !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          result.content
        )
      )
        throw Error('The server returned an invalid source chunk.');
      const bytes = Buffer.from(result.content, 'base64');
      if (
        !bytes.length ||
        bytes.length > SOURCE_READ_BYTES ||
        offset + bytes.length > file.size
      )
        throw Error('The server returned an invalid source chunk.');
      digest.update(bytes);
      await output.writeFile(bytes);
      offset += bytes.length;
    }
    if (digest.digest('hex') !== file.sha256)
      throw Error('Downloaded source checksum failed: ' + file.path);
  } finally {
    await output.close();
  }
}
function fileChanges(baseline, local) {
  const old = new Map(baseline.map((f) => [f.path, f])),
    current = new Map(local.map((f) => [f.path, f])),
    changes = [];
  for (const file of local) {
    const before = old.get(file.path);
    if (!before || before.sha256 !== file.sha256 || before.size !== file.size)
      changes.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }
  for (const file of baseline)
    if (!current.has(file.path)) changes.push({ path: file.path, remove: true });
  return changes;
}
async function uploadChange(
  api,
  root,
  projectId,
  requestId,
  index,
  change,
  parts,
  signal
) {
  if (change.remove) return;
  const source = await localFile(root, change.path, { missing: false });
  let offset = 0;
  const digest = createHash('sha256');
  try {
    if (source.stat.size !== change.size)
      throw Error('Local source changed after push preparation: ' + change.path);
    for (
      let part = 0;
      part < Math.max(1, Math.ceil(change.size / SOURCE_CHUNK_BYTES));
      part++
    ) {
      signal?.throwIfAborted();
      const bytes = Buffer.alloc(
        Math.max(0, Math.min(SOURCE_CHUNK_BYTES, change.size - offset))
      );
      let done = 0;
      while (done < bytes.length) {
        const result = await source.handle.read(
          bytes,
          done,
          bytes.length - done,
          offset + done
        );
        if (!result.bytesRead)
          throw Error('Local source changed during push: ' + change.path);
        done += result.bytesRead;
      }
      digest.update(bytes);
      offset += bytes.length;
      const checksum = hash(bytes),
        existing = parts.find((p) => p.fileIndex === index && p.part === part);
      if (existing && existing.digest !== checksum)
        throw Error(
          'The pending push contains different source bytes. Cancel it before pushing new changes.'
        );
      if (!existing) {
        const result = await api(
          prefix(projectId) +
            '/changesets/' +
            requestId +
            '/files/' +
            index +
            '/chunks/' +
            part,
          { method: 'PUT', body: bytes }
        );
        if (result.digest !== checksum) throw Error('Uploaded source checksum failed.');
      }
    }
    const after = await source.handle.stat();
    if (
      digest.digest('hex') !== change.sha256 ||
      after.size !== source.stat.size ||
      after.mtimeMs !== source.stat.mtimeMs
    )
      throw Error('Local source changed during push: ' + change.path);
  } finally {
    await source.handle.close();
  }
}
async function deploySource(api, projectId, state, root, options, context) {
  const { log, signal } = context;
  if (!state.revision) throw Error('There is no source revision to deploy.');
  const pending = state.pendingDeployment || {
    requestId: randomUUID(),
    revision: state.revision
  };
  if (pending.revision !== state.revision)
    throw Error(
      'Resolve the earlier deployment before deploying a different source version.'
    );
  state.pendingDeployment = pending;
  await writeSourceState(root, state);
  let deployment;
  if (pending.deploymentId) {
    const detail = await api('/projects/' + projectId);
    deployment = detail.deployments.find((d) => d.id === pending.deploymentId);
    if (!deployment)
      throw Error(
        'The previous deployment is no longer available. Review the dashboard.'
      );
  } else {
    const result = await api('/projects/' + projectId + '/deploy', {
      method: 'POST',
      body: {
        uploadId: state.revision,
        expectedSourceRevision: state.revision,
        requestId: pending.requestId
      }
    });
    deployment = result.deployment;
    pending.deploymentId = deployment.id;
    await writeSourceState(root, state);
  }
  log('Deployment queued: ' + clean(deployment.id) + '.');
  if (options['no-wait']) return;
  const deadline = Date.now() + options.timeout * 1000;
  while (!['ready', 'failed', 'cancelled'].includes(deployment.status)) {
    if (Date.now() > deadline)
      throw Error(
        'Deployment is still running. Check the dashboard or retry prnext push --deploy to resume.'
      );
    await delay(1500, undefined, { signal });
    const detail = await api('/projects/' + projectId);
    deployment = detail.deployments.find((d) => d.id === pending.deploymentId);
    if (!deployment)
      throw Error('The deployment is no longer available. Review the dashboard.');
  }
  delete state.pendingDeployment;
  await writeSourceState(root, state);
  if (deployment.status !== 'ready')
    throw Error(
      'Deployment ' + clean(deployment.status) + '. Review the deployment logs.'
    );
  log('Deployment ready: ' + clean(deployment.id) + '.');
}
export async function sourceCommand(
  command,
  options,
  origin,
  root,
  link,
  api,
  identity,
  context
) {
  const { signal, log } = context;
  const request = api;
  api = (...args) => sourceRetry(() => request(...args), { signal });
  if (identity.capabilities?.sourceSync?.protocol !== SOURCE_PROTOCOL)
    throw Error(
      'This Host server must be updated before using pull/push. No local source was changed.'
    );
  if (
    link &&
    (cloudOrigin(link.origin) !== origin || link.workspaceId !== identity.workspace.id)
  )
    throw Error('This directory is linked to another Host server or workspace.');
  if (options.project && link?.projectId && options.project !== link.projectId)
    throw Error(
      'This directory is already linked to another project. Use a separate directory.'
    );
  const projectId = options.project || link?.projectId;
  if (!uuid(projectId))
    throw Error(
      'Use --project PROJECT_ID for the first pull, then reuse this linked directory.'
    );
  const metadata = await api('/projects/' + projectId);
  if (metadata.project.managed)
    throw Error(
      'Source sync is available only for projects stored directly on PRNext Host.'
    );
  await safeCache(root);
  if (
    options['dry-run'] &&
    (await lstat(path.join(root, '.prnext-cloud', 'pull-journal.json')).then(
      () => true,
      () => false
    ))
  )
    throw Error('An interrupted pull needs recovery. Run prnext pull before a dry run.');
  if (!options['dry-run']) await recoverPull(root);
  let state = await readSourceState(root);
  const saveLink = (revision) =>
    writeState(linkPath(root), {
      version: 1,
      origin,
      workspaceId: identity.workspace.id,
      projectId,
      sourceRevision: revision
    });
  if (command === 'pull') {
    if (state?.pendingPush || state?.pendingDeployment)
      throw Error(
        'A push or deployment is unfinished. Retry it or use prnext push --cancel before pulling.'
      );
    if (!state && !link) {
      const names = await readdir(root);
      if (names.some((n) => n !== '.prnext-cloud'))
        throw Error(
          'Use an empty directory for the first pull. Existing files were not changed.'
        );
    }
    const next = await fetchSourceManifest(api, projectId, {
      revision: options.revision,
      refresh: !options.revision
    });
    if (state?.submission) {
      const remote = new Map(next.files.map((f) => [f.path, f])),
        submitted = state.submission.changes;
      if (
        !Array.isArray(submitted) ||
        !submitted.every((change) =>
          change.remove
            ? !remote.has(change.path)
            : remote.get(change.path)?.sha256 === change.sha256
        )
      )
        next.submission = state.submission;
    }
    const operations = await planPull(root, state, next);
    if (options['dry-run']) {
      log(
        operations
          .map((o) => (o.newHash ? (o.oldHash ? 'M ' : 'A ') : 'D ') + clean(o.path))
          .join('\n') || 'No source changes.'
      );
      return;
    }
    await applyPull(root, state, next, operations, {
      signal,
      download: (file, destination) =>
        downloadFile(api, projectId, next.revision, file, destination, signal),
      saveLink: () => saveLink(next.revision)
    });
    log(
      next.revision
        ? `Pulled ${next.files.length} files at ${next.revision}.`
        : 'Project linked. Add index.html or package.json, then run prnext push.'
    );
    return;
  }
  if (!state) throw Error('Pull the project first to establish a source version.');
  if (options.cancel) {
    if (state.pendingPush) {
      try {
        await api(prefix(projectId) + '/changesets/' + state.pendingPush.requestId, {
          method: 'DELETE'
        });
      } catch (error) {
        if (![404, 410].includes(error.status)) throw error;
      }
    }
    delete state.pendingPush;
    delete state.submission;
    if (state.pendingDeployment) {
      log(
        'A queued deployment is not cancelled by this command. Review it in the dashboard.'
      );
      delete state.pendingDeployment;
    }
    await writeSourceState(root, state);
    log(
      'Pending source transfer cleared. Saved versions and GitHub pull requests are preserved.'
    );
    return;
  }
  let remote = await fetchSourceManifest(api, projectId);
  const local = await scanLocalSource(root, remote.limits, signal),
    changes = fileChanges(state.files, local),
    changesHash = hash(JSON.stringify(changes));
  if (options['dry-run']) {
    log(
      changes
        .map(
          (c) =>
            (c.remove ? 'D ' : state.files.some((f) => f.path === c.path) ? 'M ' : 'A ') +
            clean(c.path)
        )
        .join('\n') || 'No source changes.'
    );
    return;
  }
  if (!state.pendingPush && remote.revision !== state.revision)
    throw Error(
      'The project source changed. Run prnext pull and reconcile local edits before pushing.'
    );
  if (state.submission) {
    if (state.submission.changesHash === changesHash) {
      log('GitHub pull request: ' + state.submission.url);
      if (options.deploy)
        throw Error(
          'Merge the pull request through GitHub, pull the merged source, then deploy.'
        );
      return;
    }
    throw Error(
      'A GitHub pull request is already submitted from this directory. Merge it and pull, or use prnext push --cancel to prepare a separate pull request.'
    );
  }
  if (!changes.length && !state.pendingPush) {
    log('No source changes.');
    if (options.deploy) await deploySource(api, projectId, state, root, options, context);
    return;
  }
  const message = options.message || 'Update project sources';
  if (state.pendingPush && state.pendingPush.changesHash !== changesHash)
    throw Error(
      'Local files changed after this push started. Restore them to resume, or run prnext push --cancel before starting a new push.'
    );
  const pending = state.pendingPush || {
    requestId: randomUUID(),
    baseRevision: state.revision,
    message,
    changesHash
  };
  state.pendingPush = pending;
  await writeSourceState(root, state);
  const start = await api(prefix(projectId) + '/changesets', {
    method: 'POST',
    body: {
      requestId: pending.requestId,
      baseRevision: pending.baseRevision,
      message: pending.message,
      changes
    }
  });
  let result = start.result;
  if (!result) {
    for (let index = 0; index < changes.length; index++)
      await uploadChange(
        api,
        root,
        projectId,
        pending.requestId,
        index,
        changes[index],
        start.parts || [],
        signal
      );
    result = await api(
      prefix(projectId) + '/changesets/' + pending.requestId + '/commit',
      { method: 'POST', body: {} }
    );
  }
  if (result.provider === 'github') {
    let url;
    try {
      url = new URL(result.pullRequest.url);
    } catch {
      throw Error('The server returned an invalid pull request.');
    }
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)
    )
      throw Error('The server returned an invalid pull request.');
    delete state.pendingPush;
    state.submission = {
      requestId: pending.requestId,
      changesHash,
      changes,
      url: url.href
    };
    await writeSourceState(root, state);
    log('GitHub pull request: ' + url.href);
    if (options.deploy)
      throw Error(
        'Merge the pull request through GitHub, pull the merged source, then deploy.'
      );
    return;
  }
  if (!uuid(result.revision) || result.revision !== result.uploadId)
    throw Error('The server returned an invalid saved revision.');
  const next = await fetchSourceManifest(api, projectId, { revision: result.revision });
  await writeSourceState(root, next);
  await saveLink(next.revision);
  state = next;
  log('Source saved: ' + result.revision + '.');
  if (options.deploy) await deploySource(api, projectId, state, root, options, context);
}
