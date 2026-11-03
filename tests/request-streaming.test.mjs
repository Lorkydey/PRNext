import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {request} from 'node:http';
import {promisify} from 'node:util';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {appFixture, startServer, repositoryRoot} from './support.mjs';

// Use the HTTP duplex API: fetch intentionally waits for upload EOF before
// exposing a response, so it cannot prove that both directions are live.
function upload(url, headers = {}) {
  let resolveHead, rejectHead;
  const head = new Promise((resolve, reject) => { resolveHead = resolve; rejectHead = reject; });
  const outgoing = request(url, {method: 'POST', headers: {'accept-encoding': 'identity', ...headers}}, incoming => {
    incoming.on('error', rejectHead);
    resolveHead(incoming);
  });
  outgoing.on('error', rejectHead);
  outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Upload did not make progress')));
  return {outgoing, head};
}

test('opt-in request ingress is duplex before upload EOF, bounded and never replays an early mutation', {timeout: 180000}, async () => {
  const fixture = await appFixture();
  let server;
  const clients = [];
  try {
    for (const name of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, name), {recursive: true, force: true});
    const files = {
      'public/robots.txt': 'User-agent: *\nDisallow:',
      'prnext.config.mjs': 'export default {experimental:{streamingRequestBodies:true}}',
      'app/layout.jsx': 'export default({children})=><html><head/><body>{children}</body></html>',
      'app/page.jsx': 'export default()=> <h1>Request streaming fixture</h1>',
      'app/api/upload/route.js': `
        let mutations=0;
        export function GET(){return Response.json({pid:process.pid,mutations})}
        export async function POST(request){
          const mode=new URL(request.url).searchParams.get('mode');
          if(mode==='ignore')return Response.json({pid:process.pid,ignored:true});
          const reader=request.body.getReader();const first=await reader.read();mutations++;
          if(mode==='early'){await reader.cancel();return Response.json({pid:process.pid,mutations});}
          return new Response(new ReadableStream({
            start(c){if(first.value)c.enqueue(first.value);},
            async pull(c){try{const next=await reader.read();if(next.done)c.close();else c.enqueue(next.value);}catch(error){c.error(error);}},
            cancel(reason){return reader.cancel(reason);}
          }),{headers:{'content-type':'application/octet-stream','x-worker-pid':String(process.pid)}});
        }`,
    };
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture.root, name)), {recursive: true});
      await writeFile(path.join(fixture.root, name), source);
    }
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], {maxBuffer: 8 * 1024 * 1024});
    server = await startServer(fixture.root, ['--workers', '1']);
    const endpoint = server.url + '/api/upload';
    const initial = await (await fetch(endpoint)).json();
    const first = Buffer.alloc(64 * 1024, 23), last = Buffer.alloc(64 * 1024, 71);
    const duplex = upload(endpoint, {'content-length': String(first.length + last.length)});clients.push(duplex.outgoing);
    duplex.outgoing.write(first);
    const response = await duplex.head;
    assert.equal(response.statusCode, 200);
    assert.equal(Number(response.headers['x-worker-pid']), initial.pid);
    const iterator = response[Symbol.asyncIterator](), parts = [];
    let received = 0;
    while (received < first.length) {
      const part = await iterator.next();assert.equal(part.done, false);parts.push(part.value);received += part.value.length;
    }
    assert.equal(duplex.outgoing.writableEnded, false, 'first response bytes arrive while upload EOF is withheld');
    assert.deepEqual(Buffer.concat(parts), first);
    duplex.outgoing.end(last);
    for (;;) { const part = await iterator.next();if (part.done) break;parts.push(part.value); }
    assert.deepEqual(Buffer.concat(parts), Buffer.concat([first, last]));

    const early = upload(endpoint + '?mode=early');clients.push(early.outgoing);
    early.outgoing.write(Buffer.from('one mutation'));
    const earlyResponse = await early.head;
    assert.equal(earlyResponse.statusCode, 200);
    const earlyParts = [];for await (const part of earlyResponse) earlyParts.push(part);
    assert.deepEqual(JSON.parse(Buffer.concat(earlyParts)), {pid: initial.pid, mutations: 2});
    early.outgoing.destroy();

    const ignored = upload(endpoint + '?mode=ignore');clients.push(ignored.outgoing);
    ignored.outgoing.flushHeaders();
    const ignoredResponse = await ignored.head;
    const ignoredParts = [];for await (const part of ignoredResponse) ignoredParts.push(part);
    assert.equal(ignoredResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(Buffer.concat(ignoredParts)), {pid: initial.pid, ignored: true});
    ignored.outgoing.destroy();

    const rejected = upload(endpoint, {'content-length': String(32 * 1024 * 1024 + 1)});clients.push(rejected.outgoing);
    rejected.outgoing.flushHeaders();
    const rejectedResponse = await rejected.head;
    assert.equal(rejectedResponse.statusCode, 413);
    for await (const _ of rejectedResponse) {}rejected.outgoing.destroy();
    const final = await (await fetch(endpoint)).json();
    assert.deepEqual(final, {pid: initial.pid, mutations: 2}, 'early response, ignored upload and rejection retain the host and cannot replay mutation code');
  } finally {
    for (const client of clients) client.destroy();
    await server?.close();
    await fixture.remove();
  }
});
