import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { binary, freePort, repositoryRoot, standaloneFixture } from './support.mjs';

function documentSource(language, version) {
  return `import{Html,Head,Main,NextScript}from'next/document';
    import{label,color}from'../document-helper.mjs';
    export default function CustomDocument(){return <Html lang="${language}" data-document-version="${version}"><Head><style id="document-dev-style">{':root{--document-tone:'+color+'}'}</style></Head><body data-document-helper={label}><Main/><NextScript/></body></Html>}`;
}

test('CLI dev rebuilds Document and local imports, keeps the valid shell after syntax errors, and recovers', { timeout: 30_000 }, async t => {
  const deadline = Date.now() + 22_000;
  let fixture, child, launchError, output = '', lastResponse = '';
  try {
    fixture = await standaloneFixture();
    const documentFile = path.join(fixture.root, 'pages/_document.jsx');
    const helperFile = path.join(fixture.root, 'document-helper.mjs');
    await writeFile(path.join(fixture.root, 'pages/index.jsx'), 'export default()=> <h1>Document dev page</h1>');
    await writeFile(documentFile, documentSource('fr', 'initial'));
    await writeFile(helperFile, `export const label='first-helper',color='navy';`);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'dev', fixture.root,
      '--hostname', '127.0.0.1', '--port', String(port), '--workers', '1'], {
      env: { ...process.env, NODE_ENV: 'development', RUSTYX_BINARY: binary }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', error => { launchError = error; });
    const collect = data => { output = (output + data).slice(-1024 * 1024); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const manifest = async () => JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    async function request() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 750);
      const abort = () => controller.abort(t.signal.reason);
      t.signal.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch(url, { signal: controller.signal });
        const html = await response.text();
        lastResponse = `${response.status}: ${html.slice(0, 2048)}`;
        return { status: response.status, html };
      } finally {
        clearTimeout(timer);
        t.signal.removeEventListener('abort', abort);
      }
    }
    async function eventually(check, description) {
      while (Date.now() < deadline) {
        t.signal.throwIfAborted();
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode) throw new Error(`CLI dev exited before ${description}`);
        try { if (await check()) return; } catch { /* Requests may cross a server restart. */ }
        await delay(40, undefined, { signal: t.signal });
      }
      throw new Error(`Timed out waiting for ${description}. Last response: ${lastResponse}`);
    }
    function isShell({ status, html }, language, version, helper, color) {
      return status === 200 && html.includes(`lang="${language}"`) && html.includes(`data-document-version="${version}"`)
        && html.includes(`data-document-helper="${helper}"`) && html.includes(`<style id="document-dev-style">:root{--document-tone:${color}}</style>`)
        && html.includes('Document dev page');
    }
    await eventually(async () => isShell(await request(), 'fr', 'initial', 'first-helper', 'navy'), 'initial Document shell');
    const initial = await manifest();
    assert.equal(initial.dev, true);

    await writeFile(documentFile, documentSource('de', 'edited'));
    await eventually(async () => isShell(await request(), 'de', 'edited', 'first-helper', 'navy'), 'Document source edit');
    assert.notEqual((await manifest()).cacheId, initial.cacheId);

    await writeFile(helperFile, `export const label='second-helper',color='coral';`);
    await eventually(async () => isShell(await request(), 'de', 'edited', 'second-helper', 'coral'), 'Document dependency edit');
    const valid = await manifest();
    const failureStart = output.length;
    await writeFile(documentFile, 'export default function BrokenDocument( {');
    await eventually(() => output.slice(failureStart).includes('Build failed:'), 'syntax error diagnostic');
    assert.equal((await manifest()).cacheId, valid.cacheId, 'a rejected rebuild preserves the last published build');
    assert.ok(isShell(await request(), 'de', 'edited', 'second-helper', 'coral'), 'the existing server continues serving its complete valid Document');

    await writeFile(documentFile, documentSource('it', 'recovered'));
    await eventually(async () => isShell(await request(), 'it', 'recovered', 'second-helper', 'coral'), 'corrected Document recovery');
    assert.notEqual((await manifest()).cacheId, valid.cacheId);
  } catch (error) {
    error.message += `\nCLI output:\n${output}`;
    throw error;
  } finally {
    if (child && child.exitCode === null && !child.signalCode) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await fixture?.remove();
  }
});
