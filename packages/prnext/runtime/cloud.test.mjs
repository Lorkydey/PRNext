import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { archiveProject } from './cloud/archive.mjs';
import {detectEnvFiles,readDeploymentEnv,confirmEnvImport} from './cloud/environment.mjs';
import {
  cloudOrigin,
  credentialPath,
  linkPath,
  readState,
  writeState,
  withStateLock
} from './cloud/state.mjs';
import {
  cloudCommand,
  parseCloudArgs,
  createCloudClient
} from './cloud/client.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-cloud-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await mkdir(project);
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'cli-fixture', scripts: { build: 'prnext build' } })
  );
  return {
    directory,
    project,
    env: { PRNEXT_CLOUD_HOME: path.join(directory, 'credentials') }
  };
}
function unzip(bytes) {
  const result = new Map();
  for (let i = 0; bytes.readUInt32LE(i) === 0x04034b50;) {
    const method = bytes.readUInt16LE(i + 8),
      size = bytes.readUInt32LE(i + 18),
      n = bytes.readUInt16LE(i + 26),
      extra = bytes.readUInt16LE(i + 28);
    const name = bytes.subarray(i + 30, i + 30 + n).toString('utf8'),
      start = i + 30 + n + extra;
    const data = bytes.subarray(start, start + size);
    result.set(name, method === 8 ? inflateRawSync(data) : data);
    i = start + size;
  }
  return result;
}
test('source packaging excludes secrets/builds, respects ignores and preserves exact source bytes', async (t) => {
  const f = await fixture(t);
  for (const directory of [
    'app',
    'node_modules',
    '.prnext',
    '.prnext-cloud',
    '.git',
    'assets'
  ])
    await mkdir(path.join(f.project, directory));
  const source =
    'export default function Page() { return <h1>Bonjour</h1>; }\n'.repeat(20);
  for (const [name, content] of Object.entries({
    'app/page.jsx': source,
    '.env': 'SECRET',
    '.env.example': 'SECRET',
    '.npmrc': 'SECRET',
    'private.pem': 'SECRET',
    '.prnext-cloud/project.json': 'PRIVATE LINK',
    'node_modules/index.js': 'generated',
    '.prnext/cache': 'build',
    '.git/config': 'git',
    'assets/keep.txt': 'keep',
    'assets/drop.txt': 'drop',
    '.gitignore': 'assets/\n',
    '.prnextignore': '!assets/keep.txt\n'
  }))
    await writeFile(path.join(f.project, name), content);
  const archive = await archiveProject(f.project),
    entries = unzip(archive.buffer);
  assert.equal(entries.get('app/page.jsx').toString(), source);
  assert.equal(entries.get('assets/keep.txt').toString(), 'keep');
  for (const name of [
    '.env',
    '.env.example',
    '.npmrc',
    'private.pem',
    'node_modules/index.js',
    '.prnext/cache',
    '.prnext-cloud/project.json',
    'assets/drop.txt'
  ])
    assert.ok(!entries.has(name), name);
  assert.deepEqual((await archiveProject(f.project)).buffer, archive.buffer);
});
test('archives enforce bounds and avoid extreme compression ratios rejected by the server', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, 'repetitive.txt'), 'a'.repeat(100000));
  const archive = await archiveProject(f.project);
  assert.equal(unzip(archive.buffer).get('repetitive.txt').length, 100000);
  assert.ok(archive.buffer.length > 100000);
  await assert.rejects(
    archiveProject(f.project, { maxArchiveBytes: 1000 }),
    /archive exceeds/
  );
  await assert.rejects(
    archiveProject(f.project, { maxFiles: 1 }),
    /exceeds 1 files/
  );
  await assert.rejects(
    archiveProject(f.project, { maxFileBytes: 1000 }),
    /Source file is not regular or exceeds/
  );
  await assert.rejects(
    archiveProject(f.project, { maxSourceBytes: 1000 }),
    /Expanded sources exceed/
  );
});
test('source directories refuse links to outside files and missing production scripts', async (t) => {
  const f = await fixture(t),
    outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'not included');
  await symlink(
    outside,
    path.join(f.project, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(archiveProject(f.project), /Symbolic links/);
  await writeFile(path.join(f.project, '.prnextignore'), 'linked/\n');
  assert.ok(
    !(await archiveProject(f.project)).files.some((name) =>
      name.includes('secret')
    )
  );
  await writeFile(path.join(f.project, 'package.json'), '{}');
  await assert.rejects(archiveProject(f.project), /build script/);
});
test('origin, flags and credentials never cross servers or allow an unsafe HTTP origin', async (t) => {
  const f = await fixture(t);
  for (const url of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/api',
    'https://example.com/?x=1',
    'file:///tmp'
  ])
    assert.throws(() => cloudOrigin(url));
  assert.equal(cloudOrigin('http://127.0.0.1:3003'), 'http://127.0.0.1:3003');
  assert.notEqual(
    credentialPath('https://one.example', f.env),
    credentialPath('https://two.example', f.env)
  );
  assert.throws(
    () => parseCloudArgs('update', ['--name', 'site']),
    /not supported/
  );
  assert.throws(() => parseCloudArgs('deploy', ['--server']), /Missing value/);
  assert.throws(
    () =>
      parseCloudArgs('login', [
        '--server',
        'https://x.example',
        '--server',
        'https://x.example'
      ]),
    /Duplicate/
  );
  assert.throws(
    () => parseCloudArgs('deploy', ['--timeout', 'NaN']),
    /timeout/
  );
  assert.equal(
    parseCloudArgs('deploy', ['--dry-run', './app']).directory,
    './app'
  );
});
test('atomic credentials and project locks remain private and release after failure', async (t) => {
  const f = await fixture(t),
    file = credentialPath('https://app.example', f.env);
  await writeState(file, { value: 'fixture' });
  assert.deepEqual(await readState(file), { value: 'fixture' });
  if (process.platform !== 'win32')
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  const lock = linkPath(f.project) + '.lock';
  await withStateLock(lock, async () => {
    await assert.rejects(
      withStateLock(lock, () => {}),
      /Another PRNext/
    );
  });
  await assert.rejects(
    withStateLock(lock, () => {
      throw Error('fixture failure');
    }),
    /fixture failure/
  );
  assert.equal(await readState(lock), null);
});
test('HTTP client never forwards bearer credentials across a redirect', async (t) => {
  let leaked = false;
  const remote = createServer((request, response) => {
    leaked = true;
    response.end('{}');
  });
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const server = createServer((request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${remote.address().port}/steal`
    });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    remote.closeAllConnections();
    remote.close();
  });
  await assert.rejects(
    createCloudClient(`http://127.0.0.1:${server.address().port}`, {
      token: 'fixture-token'
    })('/session'),
    /Cannot reach/
  );
  assert.equal(leaked, false);
});
test('dry run needs no account and refuses to package an in-project credential home', async (t) => {
  const f = await fixture(t),
    output = [];
  await cloudCommand('deploy', [f.project, '--dry-run'], {
    env: f.env,
    log: (line) => output.push(line)
  });
  assert.match(output.join('\n'), /No upload performed/);
  assert.equal(await readState(linkPath(f.project)), null);
  await assert.rejects(
    cloudCommand('deploy', [f.project, '--dry-run'], {
      env: { PRNEXT_CLOUD_HOME: path.join(f.project, 'credentials') }
    }),
    /outside the project/
  );
});

test('deploy and update reuse the project, persist request IDs, resume after lost responses and report build failure', async (t) => {
  const f = await fixture(t),
    projectId = '11111111-1111-4111-8111-111111111111',
    workspaceId = 'workspace-fixture';
  let envImports = 0, prompts = 0;
  await writeFile(path.join(f.project,'.env'),'FIXTURE_SECRET=only-with-consent');
  let creates = 0,
    uploads = 0,
    loseResponse = true,
    failBuild = false;
  let finalizingPreviousJob = true;
  const deployments = new Map(),
    archiveBodies = [],
    token = 'prn_' + 'a'.repeat(43);
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers.origin, undefined);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    response.setHeader('Content-Type', 'application/json');
    const send = (data) => response.end(JSON.stringify(data));
    if (request.url === '/api/session')
      return send({
        user: { id: 'user', email: 'fixture@example.test' },
        workspace: { id: workspaceId, name: 'Fixture' },
        capabilities: { runtime: { canDeploy: true }, uploadMaxBytes: 7340032, environmentImport:true }
      });
    if (request.url === '/api/projects') {
      creates++;
      return send({ project: { id: projectId } });
    }
    if (request.url.endsWith('/upload')) {
      uploads++;
      archiveBodies.push(unzip(bytes));
      return send({ uploadId: 'upload-' + uploads });
    }
    if (request.url.endsWith('/env/import')) {
      envImports++;
      assert.deepEqual(JSON.parse(bytes),{variables:{FIXTURE_SECRET:'only-with-consent'}});
      return send({imported:1});
    }
    if (request.url.endsWith('/deploy')) {
      if (finalizingPreviousJob) {finalizingPreviousJob=false;response.statusCode=409;return send({error:{code:'job_active',message:'Previous operation still finalizing.'}});}
      const body = JSON.parse(bytes);
      assert.match(body.requestId, /^[\w-]{36}$/);
      if (!deployments.has(body.requestId))
        deployments.set(body.requestId, {
          id: body.requestId,
          status: failBuild ? 'failed' : 'ready',
          error: failBuild ? 'Fixture build failed' : null
        });
      if (loseResponse) {
        loseResponse = false;
        response.destroy();
        return;
      }
      return send({ deployment: deployments.get(body.requestId) });
    }
    if (request.url === `/api/projects/${projectId}`)
      return send({
        project: { id: projectId, sourceType: 'upload', domain: null },
        deployments: [...deployments.values()]
      });
    response.statusCode = 404;
    send({});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`,
    env = { ...f.env, PRNEXT_CLOUD_URL: origin },
    log = [];
  await writeState(credentialPath(origin, env), {
    origin,
    accessToken: token,
    expiresAt: Date.now() + 60000
  });
  await assert.rejects(
    cloudCommand('deploy', [f.project], {
      env,
      confirmEnv:async()=>{prompts++;return false;},
      log: (value) => log.push(value)
    }),
    /Cannot reach/
  );
  assert.equal(creates, 1);
  assert.equal(uploads, 1);
  assert.equal(envImports,0);assert.equal(prompts,1);
  const pending = (await readState(linkPath(f.project))).pending;
  assert.ok(pending.requestId && pending.uploadId);
  await cloudCommand('update', [f.project], {
    env,
    log: (value) => log.push(value)
  });
  assert.equal(creates, 1);
  assert.equal(uploads, 1);
  assert.equal(deployments.size, 1);
  assert.equal((await readState(linkPath(f.project))).pending, undefined);
  await writeFile(path.join(f.project, 'changed.txt'), 'second revision');
  await cloudCommand('update', [f.project], {
    env,
    confirmEnv:async()=>{prompts++;return true;},
    log: (value) => log.push(value)
  });
  assert.equal(creates, 1);
  assert.equal(uploads, 2);
  assert.equal(envImports,1);assert.equal(prompts,2);
  assert.ok(!archiveBodies[1].has('.env'));
  assert.ok(!log.join('\n').includes('only-with-consent'));
  assert.ok(!JSON.stringify(await readState(linkPath(f.project))).includes('only-with-consent'));
  assert.equal(deployments.size, 2);
  assert.equal(
    archiveBodies[1].get('changed.txt').toString(),
    'second revision'
  );
  assert.ok(!archiveBodies[1].has('.prnext-cloud/project.json'));
  failBuild = true;
  await assert.rejects(
    cloudCommand('update', [f.project,'--without-env'], {
      env,
      confirmEnv:async()=>{throw new Error('Unexpected prompt');},
      log: (value) => log.push(value)
    }),
    /Fixture build failed/
  );
  assert.equal((await readState(linkPath(f.project))).pending, undefined);
});

test('production env precedence, multiline/expansion and no ambient machine secrets; ZIP is always secret-free',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.project,'.env'),'VALUE=base\nTOKEN=synthetic\nREF=$TOKEN\nMULTI="line1\nline2"\nESCAPED=\\$VALUE\n');
  await writeFile(path.join(f.project,'.env.local'),'VALUE=local\n');
  await writeFile(path.join(f.project,'.env.production.local'),'VALUE=production-local\n');
  await writeFile(path.join(f.project,'.env.development'),'DEVELOPMENT_ONLY=not-production');
  const vars=await readDeploymentEnv(f.project,await detectEnvFiles(f.project));
  assert.equal(vars.VALUE,'production-local');assert.equal(vars.REF,'synthetic');assert.equal(vars.MULTI,'line1\nline2');assert.equal(vars.ESCAPED,'$VALUE');assert.equal(vars.DEVELOPMENT_ONLY,undefined);
  assert.ok(!(await archiveProject(f.project)).files.some(name=>name.startsWith('.env')));
  const before=process.env.TOKEN;process.env.TOKEN='ambient-secret';
  try {assert.equal((await readDeploymentEnv(f.project,await detectEnvFiles(f.project))).TOKEN,'synthetic');}
  finally {if(before===undefined)delete process.env.TOKEN;else process.env.TOKEN=before;}
  await writeFile(path.join(f.project,'.env'),'NODE_OPTIONS=--inspect');
  await assert.rejects(readDeploymentEnv(f.project,await detectEnvFiles(f.project)),/reserved/);
  if(!process.stdin.isTTY)assert.equal(await confirmEnvImport('never prompt in CI'),false);
  assert.throws(()=>parseCloudArgs('deploy',['--with-env','--without-env']),/either/);
});

test('disk archive equals the existing deterministic ZIP without retaining its full buffer',async t=>{
  const f=await fixture(t),filename=path.join(f.directory,'source.zip');
  const memory=await archiveProject(f.project),disk=await archiveProject(f.project,{outputFile:filename});
  assert.equal(disk.buffer,undefined);assert.equal(disk.digest,memory.digest);assert.equal(disk.size,memory.buffer.length);
  assert.deepEqual(await readFile(filename),memory.buffer);
});
