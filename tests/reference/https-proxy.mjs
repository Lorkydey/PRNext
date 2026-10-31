import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';

// This publicly known key exists solely for loopback test traffic. The fixture
// never installs a system trust root and never disables TLS checks globally.
export async function startReferenceHttpsProxy(backend) {
  const target = new URL(backend);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/'
      || target.username || target.password || target.search || target.hash) {
    throw new Error('The reference TLS proxy requires an HTTP loopback backend.');
  }
  const [key, cert] = await Promise.all([
    readFile(new URL('./certificates/localhost-key.pem', import.meta.url)),
    readFile(new URL('./certificates/localhost-cert.pem', import.meta.url)),
  ]);
  let origin;
  const sockets = new Set();
  const metrics = [];
  const server = createServer({ key, cert }, (incoming, outgoing) => {
    const pathname = new URL(incoming.url, 'http://loopback').pathname;
    const started = performance.now();
    const metric = pathname.startsWith('/api/auth/') && metrics.length < 128
      ? { route: pathname, method: incoming.method, status: null, contentLength: null, transferEncoding: null, bytes: 0, upstreamEnded: false, upstreamAborted: false, downstreamFinished: false, durationMs: null } : null;
    if (metric) metrics.push(metric);
    // The origin is reachable only through this owned loopback proxy. Discard
    // every client-supplied forwarding header before adding our own values.
    const headers = { ...incoming.headers };
    for (const name of Object.keys(headers)) {
      if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
    }
    for (const name of String(headers.connection || '').split(',').map(value => value.trim().toLowerCase())) delete headers[name];
    for (const name of ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer', 'te']) delete headers[name];
    const publicUrl = new URL(origin);
    Object.assign(headers, {
      host: publicUrl.host,
      'x-forwarded-host': publicUrl.host,
      'x-forwarded-proto': 'https',
      'x-forwarded-port': publicUrl.port,
      'x-forwarded-for': '127.0.0.1',
    });
    const upstream = request(target, { method: incoming.method, path: incoming.url, headers }, response => {
      if (metric) {
        metric.status = response.statusCode;
        metric.contentLength = response.headers['content-length'] || null;
        metric.transferEncoding = response.headers['transfer-encoding'] || null;
        response.on('data', chunk => { metric.bytes += chunk.length; });
        response.on('end', () => { metric.upstreamEnded = true; });
      }
      const fail = () => {
        if (metric) metric.upstreamAborted = true;
        outgoing.destroy();
      };
      response.on('aborted', fail);
      response.on('error', fail);
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Reference proxy upstream timeout.')));
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => { if (!outgoing.writableFinished) upstream.destroy(); });
    outgoing.on('finish', () => { if (metric) { metric.downstreamFinished = true; metric.durationMs = Math.round(performance.now() - started); } });
    incoming.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'https://127.0.0.1:' + server.address().port;
  return {
    origin, metrics,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
