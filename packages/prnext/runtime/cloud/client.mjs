import { spawn } from 'node:child_process';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { rm, realpath, mkdtemp, readFile } from 'node:fs/promises';
import { uploadSource } from './upload.mjs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { archiveProject } from './archive.mjs';
import { detectEnvFiles, readDeploymentEnv, confirmEnvImport } from './environment.mjs';
import {
  cloudOrigin,
  credentialPath,
  linkPath,
  readState,
  writeState,
  saveLink,
  withStateLock
} from './state.mjs';

export const help = `PRNext Cloud

  prn login [--server URL] [--no-browser]    Connect through your browser
  prn logout [--server URL]                 Revoke this terminal's access
  prn whoami [--server URL]                 Show the connected account
  prn deploy [directory] [--name NAME]      Upload and deploy; link this folder
  prn deploy [directory] --project ID       Link an existing upload project
  prn update [directory]                    Deploy new sources to the linked project

Deploy options: --dry-run (list files, no upload), --no-wait, --timeout SECONDS
Environment: prompts before importing production .env files; --with-env or --without-env for automation
Local development: --server http://127.0.0.1:3003
Default server: https://app.prnext.dev (or PRNEXT_CLOUD_URL)
Credentials stay in your user profile, outside project sources.
Source excludes secrets/build output and respects root .gitignore/.prnextignore.
`;
const clean = (value) =>
  String(value || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

async function resolveCredentialDirectory(directory) {
  let existing = directory;
  const missing = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...missing);
    } catch (error) {
      const parent = path.dirname(existing);
      if (error.code !== 'ENOENT' || parent === existing) throw error;
      // Resolve existing ancestors even when the credential directory has not
      // been created yet (macOS /var aliases, Windows short paths, symlinks).
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function parseCloudArgs(command, argv) {
  const options = { directory: '.', timeout: 600 };
  const flags = new Map([
    ['--server', 'server'],
    ['--name', 'name'],
    ['--project', 'project'],
    ['--timeout', 'timeout']
  ]);
  let directory = false;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(arg);
      if (['--no-browser', '--dry-run', '--no-wait', '--with-env', '--without-env'].includes(arg))
        options[arg.slice(2)] = true;
      else if (flags.has(arg)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--'))
          throw new Error(`Missing value for ${arg}`);
        options[flags.get(arg)] = argv[++i];
      } else throw new Error(`Unknown Cloud option: ${arg}`);
    } else {
      if (directory || !['deploy', 'update'].includes(command))
        throw new Error(
          'Unexpected directory or argument. Use prn ' + command + ' --help.'
        );
      directory = true;
      options.directory = arg;
    }
  }
  const allowed =
    command === 'login'
      ? ['server', 'name', 'no-browser']
      : ['logout', 'whoami'].includes(command)
        ? ['server']
        : command === 'update'
          ? ['server', 'timeout', 'dry-run', 'no-wait', 'with-env', 'without-env']
          : ['server', 'name', 'project', 'timeout', 'dry-run', 'no-wait', 'with-env', 'without-env'];
  for (const arg of seen)
    if (!allowed.includes(flags.get(arg) || arg.slice(2)))
      throw new Error(`${arg} is not supported by prn ${command}.`);
  options.timeout = Number(options.timeout);
  if (options['with-env'] && options['without-env']) throw new Error('Choose either --with-env or --without-env.');
  if (
    !Number.isInteger(options.timeout) ||
    options.timeout < 10 ||
    options.timeout > 1800
  )
    throw new Error('--timeout must be between 10 and 1800 seconds.');
  if (
    options.name &&
    (options.name.length > 80 || /[\x00-\x1f\x7f]/.test(options.name))
  )
    throw new Error(
      'Use a name of at most 80 characters without control characters.'
    );
  if (options.project && !/^[a-f0-9-]{36}$/.test(options.project))
    throw new Error('--project must be a project ID from the dashboard.');
  return options;
}
export function createCloudClient(
  origin,
  { token, signal, fetcher = fetch } = {}
) {
  origin = cloudOrigin(origin);
  return async (endpoint, { method = 'GET', body } = {}) => {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//'))
      throw new Error('Invalid API path.');
    let response;
    try {
      response = await fetcher(`${origin}/api${endpoint}`, {
        method,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'x-prnext-cli': '1',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined
            ? {
                'content-type': Buffer.isBuffer(body)
                  ? 'application/zip'
                  : 'application/json'
              }
            : {})
        },
        body:
          body === undefined
            ? undefined
            : Buffer.isBuffer(body)
              ? body
              : JSON.stringify(body),
        signal: AbortSignal.any([
          AbortSignal.timeout(endpoint.endsWith('/complete') ? 300000 : Buffer.isBuffer(body) ? 180000 : 30000),
          ...(signal ? [signal] : [])
        ])
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        `Cannot reach ${origin}. ${method === 'GET' ? 'Check the server and your connection.' : 'The request may have reached the server; check the dashboard before repeating it.'}`
      );
    }
    const reader = response.body?.getReader(),
      chunks = [];
    let size = 0;
    try {
      while (reader) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 8 * 1048576) {
          await reader.cancel();
          throw new Error('Cloud response exceeds the safe size limit.');
        }
        chunks.push(item.value);
      }
    } finally {
      reader?.releaseLock();
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error(
        `Cloud returned an invalid response (HTTP ${response.status}).`
      );
    }
    if (!response.ok) {
      const error = new Error(
        clean(
          data.error?.message ||
            `Cloud request failed (HTTP ${response.status}).`
        ).slice(0, 1000)
      );
      error.status = response.status;
      error.code = data.error?.code;
      error.interval = data.interval;
      throw error;
    }
    return data;
  };
}
export async function openBrowser(url) {
  const parsed = new URL(url);
  cloudOrigin(parsed.origin);
  const args =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(
              `Start-Process -FilePath '${parsed.href.replaceAll("'", "''")}'`,
              'utf16le'
            ).toString('base64')
          ]
        ]
      : process.platform === 'darwin'
        ? ['open', [parsed.href]]
        : ['xdg-open', [parsed.href]];
  return new Promise((resolve) => {
    const child = spawn(args[0], args[1], {
      stdio: 'ignore',
      windowsHide: true
    });
    const timer = setTimeout(() => {
      child.unref();
      resolve(false);
    }, 5000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
async function login(origin, options, context) {
  const { env, signal, log, browser } = context;
  const api = createCloudClient(origin, { signal });
  const verifier = randomBytes(32).toString('base64url');
  const grant = await api('/cli/device', {
    method: 'POST',
    body: {
      name: options.name || hostname().slice(0, 80),
      codeChallenge: createHash('sha256').update(verifier).digest('base64url')
    }
  });
  const url = new URL(grant.verificationUrl);
  if (
    url.origin !== origin ||
    url.pathname !== '/' ||
    !/^#cli\?code=[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/.test(url.hash) ||
    !/^[A-Za-z0-9_-]{43}$/.test(grant.deviceCode) ||
    !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/.test(grant.userCode)
  )
    throw new Error('Cloud returned an invalid login request.');
  log(`Connect your terminal: ${url.href}\nCode: ${grant.userCode}`);
  let completed = false;
  try {
    if (!options['no-browser'] && !(await browser(url.href)))
      log('Open the link above in your browser to continue.');
    const deadline =
      Date.now() + Math.min(600, Number(grant.expiresIn) || 600) * 1000;
    let seconds = Math.max(5, Math.min(30, Number(grant.interval) || 5));
    while (Date.now() < deadline) {
      await delay(seconds * 1000, undefined, { signal });
      let result;
      try {
        result = await api('/cli/token', {
          method: 'POST',
          body: { deviceCode: grant.deviceCode, codeVerifier: verifier }
        });
      } catch (error) {
        if (error.code !== 'slow_down') throw error;
        seconds = Math.min(30, seconds + 5);
        continue;
      }
      if (result.status === 'authorization_pending') continue;
      if (
        !/^prn_[A-Za-z0-9_-]{43}$/.test(result.accessToken || '') ||
        !Number.isSafeInteger(result.expiresAt) ||
        result.expiresAt <= Date.now()
      )
        throw new Error('Cloud returned invalid terminal credentials.');
      const authorized = createCloudClient(origin, {
        token: result.accessToken,
        signal
      });
      let identity, previous;
      try {
        identity = await authorized('/session');
        if (!identity.user?.id || !identity.workspace?.id)
          throw new Error('Could not verify the connected account.');
        const filename = credentialPath(origin, env);
        previous = await readState(filename);
        await writeState(filename, {
          version: 1,
          origin,
          accessToken: result.accessToken,
          expiresAt: result.expiresAt,
          userId: identity.user.id,
          email: identity.user.email,
          workspaceId: identity.workspace.id
        });
      } catch (error) {
        try {
          await createCloudClient(origin, {
            token: result.accessToken,
            signal: AbortSignal.timeout(2000)
          })('/cli/logout', { method: 'POST', body: {} });
        } catch {
          log(
            'Login could not be saved. Revoke this terminal in workspace settings if its connection is still listed.'
          );
        }
        throw error;
      }
      completed = true;
      if (
        previous?.origin === origin &&
        previous.accessToken &&
        previous.accessToken !== result.accessToken
      ) {
        try {
          await createCloudClient(origin, {
            token: previous.accessToken,
            signal
          })('/cli/logout', { method: 'POST', body: {} });
        } catch (error) {
          if (error.status !== 401)
            log(
              'Your previous terminal connection could not be revoked; remove it in workspace settings.'
            );
        }
      }
      log(
        `Connected as ${clean(identity.user.email)} (${clean(identity.workspace.name)}).`
      );
      return;
    }
    throw new Error('Login timed out. Run prn login again.');
  } finally {
    if (!completed) {
      try {
        await createCloudClient(origin, { signal: AbortSignal.timeout(2000) })(
          '/cli/cancel',
          {
            method: 'POST',
            body: { deviceCode: grant.deviceCode, codeVerifier: verifier }
          }
        );
      } catch {}
    }
  }
}
const terminalStates = new Set([
  'ready',
  'succeeded',
  'failed',
  'cancelled',
  'canceled',
  'interrupted'
]);
async function deploy(
  command,
  options,
  origin,
  directory,
  link,
  api,
  identity,
  context
) {
  const { signal, log } = context;
  if (
    link &&
    (link.origin !== origin || link.workspaceId !== identity.workspace.id)
  )
    throw new Error(
      'This folder is linked to another Cloud server or workspace. Use its account or a separate project directory.'
    );
  if (command === 'update' && !link?.projectId)
    throw new Error('This folder is not linked yet. Run prn deploy first.');
  if (options.project && link && options.project !== link.projectId)
    throw new Error(
      'This folder is already linked to another project. Use a separate directory to avoid replacing the wrong site.'
    );
  let project =
      link || (options.project ? { projectId: options.project } : null),
    detail;
  if (project) {
    detail = await api(`/projects/${encodeURIComponent(project.projectId)}`);
    if (detail.project.sourceType !== 'upload')
      throw new Error(
        'This project deploys from GitHub. Choose an upload project for CLI deployments.'
      );
  }
  if (!link?.pending && !identity.capabilities?.runtime?.canDeploy)
    throw new Error(
      identity.capabilities?.runtime?.reason ||
        'The isolated deployment worker is unavailable.'
    );
  if (!link?.pending) {
    let variables;
    const envFiles = options['without-env'] ? [] : await detectEnvFiles(directory);
    if (envFiles.length) {
      const target = detail?.project?.name || options.name || path.basename(directory);
      const consent = options['with-env'] || await context.confirmEnv(`Detected ${envFiles.join(', ')}. Import these variables to ${clean(target)} on ${origin}? Matching server values will be replaced. NEXT_PUBLIC_ variables can be public.`, { signal });
      if (consent) variables = await readDeploymentEnv(directory, envFiles);
      else log('Environment files not imported. Existing server variables are unchanged.');
    }
    if (variables && !identity.capabilities.environmentImport) throw new Error('This Host server must be updated before importing environment files. No source was uploaded.');
    const transfer = identity.capabilities.uploads;
    const temporary = await mkdtemp(path.join(tmpdir(),'prnext-source-'));
    try {
    const archive = await archiveProject(directory, {
      signal,
      outputFile: path.join(temporary,'source.zip'),
      ...(transfer?.resumable ? {maxSourceBytes:Math.min(500*1048576,transfer.sourceBytes),maxFileBytes:Math.min(64*1048576,transfer.fileBytes),maxFiles:15000} : {}),
      maxArchiveBytes: Math.min(
        transfer?.resumable ? 100 * 1048576 : 7 * 1048576,
        identity.capabilities.uploadMaxBytes || 7 * 1048576
      )
    });
    log(
      `Source: ${archive.files.length} files, ${(archive.size / 1048576).toFixed(2)} MiB (${archive.excluded} excluded).`
    );
    if (!project) {
      const suggested =
        options.name ||
        String(archive.packageJson.name || path.basename(directory))
          .replace(/^@[^/]+\//, '')
          .replace(/[^a-zA-Z0-9._ -]/g, '-')
          .slice(0, 80);
      const created = await api('/projects', {
        method: 'POST',
        body: { name: suggested, sourceType: 'upload' }
      });
      project = { projectId: created.project.id };
    }
    link = {
      ...link,
      version: 1,
      origin,
      workspaceId: identity.workspace.id,
      projectId: project.projectId
    };
    await saveLink(directory, link);
    const upload = transfer?.resumable ? await uploadSource(api,link,archive,{signal,log,save: link => saveLink(directory,link)}) : await api(
      `/projects/${encodeURIComponent(link.projectId)}/upload`,
      { method: 'POST', body: await readFile(archive.path) }
    );
    link.pending = { uploadId: upload.uploadId, requestId: randomUUID() };
    if (variables) {
      await api(`/projects/${encodeURIComponent(link.projectId)}/env/import`, { method: 'PUT', body: { variables } });
      log(`${Object.keys(variables).length} environment variables imported separately from sources.`);
    }
    await saveLink(directory, link);
    delete link.upload;
    await saveLink(directory,link);
    } finally { await rm(temporary,{recursive:true,force:true}); }
  } else
    log(
      'Resuming the recorded deployment request; no duplicate source upload.'
    );
  const dashboard = `${origin}/#project/${encodeURIComponent(link.projectId)}/deployments`;
  if (!link.pending.deploymentId) {
    try {
      let queued;
      for (let attempt=0;;attempt++) {
        try {
          queued = await api(`/projects/${encodeURIComponent(link.projectId)}/deploy`,{method:'POST',body:link.pending});
          break;
        } catch(error) {
          if (error.code !== 'job_active' || attempt >= 15) throw error;
          if (!attempt) log('Waiting for the previous project operation to finish…');
          await delay(2000,undefined,{signal});
        }
      }
      link.pending.deploymentId = queued.deployment.id;
      await saveLink(directory, link);
    } catch (error) {
      log(
        `Deployment request retained. Run prn update to resume it.\n${dashboard}`
      );
      throw error;
    }
  }
  log(`Deployment ${clean(link.pending.deploymentId)}\n${dashboard}`);
  if (options['no-wait']) {
    log(
      'Queued. Run prn update to resume waiting, or follow progress in the dashboard.'
    );
    return;
  }
  const deadline = Date.now() + options.timeout * 1000;
  let lastStatus;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const current = await api(
      `/projects/${encodeURIComponent(link.projectId)}`
    );
    const deployment = current.deployments?.find(
      (item) => item.id === link.pending.deploymentId
    );
    if (!deployment)
      throw new Error(
        `Deployment is no longer in recent history. Check ${dashboard}`
      );
    if (deployment.status !== lastStatus) {
      lastStatus = deployment.status;
      log(`Status: ${clean(lastStatus)}`);
    }
    if (terminalStates.has(deployment.status)) {
      link.lastDeploymentId = deployment.id;
      delete link.pending;
      await saveLink(directory, link);
      if (!['ready', 'succeeded'].includes(deployment.status)) {
        if (deployment.logs) log(clean(deployment.logs).slice(-4000));
        throw new Error(
          clean(
            deployment.error ||
              `Deployment ${deployment.status}. The previous live deployment is preserved.`
          )
        );
      }
      log(
        `Deployed successfully.${current.project.domain ? ` https://${clean(current.project.domain)}` : ' Add a domain in the dashboard to visit your site.'}`
      );
      return;
    }
    await delay(2000, undefined, { signal });
  }
  throw new Error(
    `Still deploying. Run prn update to resume waiting without deploying twice.\n${dashboard}`
  );
}
export async function cloudCommand(
  command,
  argv,
  {
    env = process.env,
    log = console.log,
    browser = openBrowser,
    confirmEnv = confirmEnvImport,
    signal: suppliedSignal
  } = {}
) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(help);
    return;
  }
  const options = parseCloudArgs(command, argv),
    directory = ['deploy', 'update'].includes(command)
      ? await realpath(path.resolve(options.directory))
      : process.cwd();
  const linked = ['deploy', 'update'].includes(command)
    ? await readState(linkPath(directory))
    : null;
  if (
    linked &&
    (linked.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(linked.projectId || '') ||
      !linked.workspaceId)
  )
    throw new Error(
      'Invalid .prnext-cloud/project.json. Restore its project link before deploying.'
    );
  const origin = cloudOrigin(
    options.server || env.PRNEXT_CLOUD_URL || linked?.origin
  );
  const controller = new AbortController();
  const signal = suppliedSignal
    ? AbortSignal.any([suppliedSignal, controller.signal])
    : controller.signal;
  const interrupt = () =>
    controller.abort(new Error('Cloud command cancelled.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const context = { env, log, browser, confirmEnv, signal };
  try {
    if (['deploy', 'update'].includes(command)) {
      const requestedHome = path.dirname(credentialPath(origin, env));
      const actualHome = await resolveCredentialDirectory(requestedHome);
      const credentialsRelative = path.relative(directory, actualHome);
      if (
        !credentialsRelative ||
        (!credentialsRelative.startsWith(`..${path.sep}`) &&
          credentialsRelative !== '..' &&
          !path.isAbsolute(credentialsRelative))
      )
        throw new Error(
          'PRNEXT_CLOUD_HOME must be outside the project being deployed.'
        );
    }
    if (options['dry-run']) {
      const temporary = await mkdtemp(path.join(tmpdir(),'prnext-source-'));
      try {
      const archive = await archiveProject(directory, { signal,outputFile:path.join(temporary,'source.zip'),maxArchiveBytes:100*1048576,maxSourceBytes:500*1048576,maxFileBytes:64*1048576,maxFiles:15000 });
      log(archive.files.join('\n'));
      log(
        `${archive.files.length} files, ${(archive.size / 1048576).toFixed(2)} MiB compressed; ${archive.excluded} excluded. No upload performed.`
      );
      return;
      } finally {await rm(temporary,{recursive:true,force:true});}
    }
    if (command === 'login') return await login(origin, options, context);
    const filename = credentialPath(origin, env),
      credential = await readState(filename);
    if (
      !credential ||
      credential.origin !== origin ||
      !/^prn_[A-Za-z0-9_-]{43}$/.test(credential.accessToken || '')
    )
      throw new Error(
        `Not connected to ${origin}. Run prn login${options.server ? ` --server ${origin}` : ''}.`
      );
    const api = createCloudClient(origin, {
      token: credential.accessToken,
      signal
    });
    if (command === 'logout') {
      try {
        await api('/cli/logout', { method: 'POST', body: {} });
      } catch (error) {
        if (error.status !== 401) throw error;
      }
      await rm(filename);
      log(`Terminal disconnected from ${origin}.`);
      return;
    }
    if (credential.expiresAt <= Date.now())
      throw new Error('Terminal access expired. Run prn login again.');
    const identity = await api('/session');
    if (command === 'whoami') {
      log(
        `${clean(identity.user.email)} · ${clean(identity.workspace.name)}\n${origin}`
      );
      return;
    }
    return await withStateLock(linkPath(directory) + '.lock', async () =>
      deploy(
        command,
        options,
        origin,
        directory,
        await readState(linkPath(directory)),
        api,
        identity,
        context
      )
    );
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
