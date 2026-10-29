import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

export async function fairnessFixture() {
  const fixture = await appFixture();
  const pending = [], events = [];
  let released = false, server;
  const coordinator = createServer((request, response) => {
    const [operation, kind, id] = request.url.split('/').slice(1);
    events.push({ operation, kind, id });
    if (operation === 'hold' && !released) pending.push({ kind, id, response });
    else response.end('ok');
  });
  try {
    coordinator.listen(0, '127.0.0.1');
    await once(coordinator, 'listening');
    const endpoint = `http://127.0.0.1:${coordinator.address().port}`;
    for (const name of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': 'export default {};',
      'pages/slow/[id].jsx': `export default()=> <h1>slow render complete</h1>;export async function getServerSideProps({params}){await fetch(${JSON.stringify(endpoint)}+'/hold/render/'+params.id);return {props:{}};}`,
      'pages/fast.jsx': `export default()=> <h1>fast render complete</h1>;export async function getServerSideProps(){await fetch(${JSON.stringify(endpoint + '/fast/render')});return {props:{}};}`,
      'pages/api/slow/[id].js': `export default async function handler(req,res){await fetch(${JSON.stringify(endpoint)}+'/hold/api/'+req.query.id);res.json({complete:true});}`,
      'pages/api/fast.js': `export default async function handler(req,res){await fetch(${JSON.stringify(endpoint + '/fast/api')});res.json({fast:true});}`,
    };
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture.root, name)), { recursive: true });
      await writeFile(path.join(fixture.root, name), source);
    }
    await build(fixture.root);
    server = await startServer(fixture.root, ['--workers', '1', '--profile', 'memory'], { PRNEXT_QUEUE_WAIT_MS: '15000' });
    return {
      ...fixture, ...server, events,
      held: kind => pending.filter(item => item.kind === kind && !item.response.writableEnded).length,
      releaseOne(kind) {
        const item = pending.find(item => item.kind === kind && !item.response.writableEnded);
        if (!item) throw new Error(`No held ${kind} request`);
        item.response.end('ok');
      },
      releaseAll() { released = true; for (const item of pending) if (!item.response.writableEnded) item.response.end('ok'); },
      holdAgain() { released = false; },
      async close() {
        released = true; for (const item of pending) if (!item.response.writableEnded) item.response.end('ok');
        await server.close();
        coordinator.closeAllConnections(); await new Promise(resolve => coordinator.close(resolve));
        await fixture.remove();
      },
    };
  } catch (error) {
    for (const item of pending) item.response.end('ok');
    await server?.close(); coordinator.closeAllConnections(); coordinator.close(); await fixture.remove(); throw error;
  }
}
