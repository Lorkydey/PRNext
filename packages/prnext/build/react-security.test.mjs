import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateReactVersions } from './app.mjs';
import { packageManifest } from '../native/resolve.mjs';

const names = ['react', 'react-dom', 'react-server-dom-webpack'];

async function installed(versions, check) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-react-security-'));
  try {
    for (const name of names) {
      if (versions[name]) await writeFile(path.join(directory, `${name}.json`), JSON.stringify({ name, version: versions[name] }));
    }
    await check({ resolve: specifier => path.join(directory, `${specifier.split('/')[0]}.json`) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('App Router rejects the vulnerable React 19.3.0 family even when all peers agree', async () => {
  await installed(Object.fromEntries(names.map(name => [name, '19.3.0'])), async resolver => {
    await assert.rejects(validateReactVersions(resolver), error => {
      assert.match(error.message, /react-server-dom-webpack@19\.3\.0/);
      assert.match(error.message, /npm install --save-exact/);
      assert.ok(error.message.includes(`react-server-dom-webpack@${packageManifest.peerDependencies['react-server-dom-webpack']}`));
      return true;
    });
  });
});

test('updating react and react-dom alone cannot leave an old RSC decoder installed', async () => {
  await installed({ ...packageManifest.peerDependencies, 'react-server-dom-webpack': '19.3.0' }, resolver =>
    assert.rejects(validateReactVersions(resolver), /exactly matching React protocol versions/));
});

test('the patched aligned React family passes the application preflight', async () => {
  await installed(packageManifest.peerDependencies, resolver => validateReactVersions(resolver));
});
