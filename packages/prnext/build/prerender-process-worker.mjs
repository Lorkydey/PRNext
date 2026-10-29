import path from 'node:path';
import { pathToFileURL } from 'node:url';

let stage, manifest, busy = false;
let closeRuntime;
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const memory = () => ({ rss: process.memoryUsage().rss, pid: process.pid });
const pulse = setInterval(() => { if (process.connected) process.send({ type: 'memory', ...memory() }); }, 100);
pulse.unref();

process.on('message', async message => {
  try {
    if (message.type === 'init') {
      if (stage) throw new Error('Prerender worker was initialized twice');
      ({ stage, manifest } = message);
      await send({ type: 'ready', ...memory() });
      return;
    }
    if (message.type === 'update') {
      manifest = message.manifest;
      await send({ type: 'updated', revision: message.revision });
      return;
    }
    if (message.type === 'close') {
      if (busy) throw new Error('Cannot close an active prerender worker');
      if (closeRuntime) await closeRuntime();
      clearInterval(pulse);
      process.disconnect();
      return;
    }
    if (message.type !== 'job' || !stage || busy) throw new Error('Invalid prerender worker operation');
    busy = true;
    const options = { ...message.options, manifest };
    let rendered;
    if (message.kind === 'pages' || message.kind === 'fallback') {
      const runtime = await import(pathToFileURL(path.join(stage, 'runtime/render.mjs')).href);
      rendered = await runtime[message.kind === 'pages' ? 'prerenderRoute' : 'renderFallback'](options);
    } else if (message.kind === 'app' || message.kind === 'handler') {
      const runtime = await import(pathToFileURL(path.join(stage, `runtime/${message.kind === 'app' ? 'app-static' : 'route-static'}.mjs`)).href);
      if (message.kind === 'app') closeRuntime ||= (await import(pathToFileURL(path.join(stage, 'runtime/app-render.mjs')).href)).closeAppRuntime;
      rendered = await runtime[message.kind === 'app' ? 'prerenderAppRoute' : 'prerenderAppRouteHandler'](options);
    } else throw new Error('Unknown prerender job kind');
    busy = false;
    // Runtime prerender entrypoints already flush their request/cache work.
    // Do not transfer retained finalizers, contexts or incidental worker data.
    const result = {};
    for (const field of ['body','dataJSON','status','headers','revalidate','generatedAt','tags','paths','partial','metadata','dynamic','reason','flight']) {
      if (rendered[field] !== undefined) result[field] = rendered[field];
    }
    await send({ type: 'result', id: message.id, rendered: result, ...memory() });
  } catch (error) {
    busy = false;
    await send({ type: 'failure', id: message.id, error: error.stack || error.message, code: error.code, ...memory() }).catch(() => {});
  }
});

// A dead coordinator must not leave application work or an RSC thread behind.
process.once('disconnect', () => process.exit(0));
