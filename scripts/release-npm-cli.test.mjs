import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installReleaseNpm, toolingEnvironment } from './release-npm-cli.mjs';

test('the npm tooling installer receives no publication or ambient credentials and does not change its parent environment', () => {
  const parent={PATH:'trusted-node',NPM_TOKEN:'secret',NODE_AUTH_TOKEN:'secret',npm_config_userconfig:'credential-file',NPM_CONFIG_REGISTRY:'https://elsewhere.invalid',NODE_OPTIONS:'--require=elsewhere',NODE_PATH:'elsewhere',GITHUB_TOKEN:'secret',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'secret',ACTIONS_ID_TOKEN_REQUEST_URL:'https://issuer.invalid',OTHER_SECRET:'secret',OTHER_PASSWORD:'secret',AWS_ACCESS_KEY_ID:'secret'};
  const original={...parent};
  const env=toolingEnvironment(parent,'isolated-directory');
  assert.deepEqual(parent,original);
  assert.equal(env.PATH,'trusted-node');
  for(const key of Object.keys(parent).filter(key=>key!=='PATH' && key!=='npm_config_userconfig'))assert.equal(env[key],undefined,key);
  assert.equal(env.npm_config_userconfig,path.join('isolated-directory','empty-user.npmrc'));
  assert.equal(env.npm_config_registry,'https://registry.npmjs.org/');
});

async function isolatedRunner(t) {
  const parent=await realpath(tmpdir());
  const directory=await mkdtemp(path.join(parent,'prnext-release-npm-test-'));
  const previous=process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP=directory;
  t.after(async()=>{
    if(previous===undefined)delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP=previous;
    const relative=path.relative(parent,await realpath(directory));
    assert.ok(relative.startsWith('prnext-release-npm-test-') && !relative.includes(path.sep));
    await rm(directory,{recursive:true});
  });
}

test('a substituted npm distribution is rejected before any client can execute', async t => {
  await isolatedRunner(t);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://registry.npmjs.org/npm/-/npm-11.21.0.tgz');
    assert.equal(options.redirect,'error');
    return new Response('substituted package',{status:200});
  });
  await assert.rejects(installReleaseNpm(),/integrity mismatch/);
});

test('an unavailable distribution cannot reach the installer', async t => {
  await isolatedRunner(t);
  t.mock.method(globalThis,'fetch',async()=>new Response('unavailable',{status:503}));
  await assert.rejects(installReleaseNpm(),/503/);
});

test('a distribution exceeding the download budget fails before installation', async t => {
  await isolatedRunner(t);
  t.mock.method(globalThis,'fetch',async()=>new Response(new Uint8Array(16*1024**2+1),{status:200}));
  await assert.rejects(installReleaseNpm(),/Oversized npm distribution/);
});
