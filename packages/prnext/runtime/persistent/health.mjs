import {request} from 'node:http';

export const nativeHealthPath = '/_prnext/health';
const nativeLimit = 4096, applicationLimit = 65536;

// Connect directly to the private generation. A redirect, partial response or
// open-ended body cannot certify that a process is ready to receive traffic.
function probe(generation, config, healthPath, timeout, native) {
  return new Promise((resolve, reject) => {
    let finished = false, response;
    const finish = error => {
      if (finished) return;
      finished = true;
      if (error) { response?.destroy(); req.destroy(); reject(error); }
      else resolve();
    };
    const req = request({host:'127.0.0.1', port:generation.port, path:healthPath,
      method:'GET', headers:{host:`${config.hostname.includes(':')?'['+config.hostname+']':config.hostname}:${config.port}`, accept:'application/json', 'accept-encoding':'identity', connection:'close'},
      signal:AbortSignal.timeout(Math.max(1, timeout))}, res => {
      response = res;
      if (res.statusCode !== 200) return finish(new Error(`Health check ${healthPath} returned HTTP ${res.statusCode}`));
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') return finish(new Error(`Health check ${healthPath} returned an encoded body`));
      const limit = native ? nativeLimit : applicationLimit;
      const declared = res.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) return finish(new Error(`Health check ${healthPath} body exceeds ${limit} bytes`));
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > limit) return finish(new Error(`Health check ${healthPath} body exceeds ${limit} bytes`));
        if (native) chunks.push(chunk);
      });
      res.once('error', finish);
      res.once('aborted', () => finish(new Error(`Health check ${healthPath} response was incomplete`)));
      res.once('end', () => {
        if (!res.complete) return finish(new Error(`Health check ${healthPath} response was incomplete`));
        if (native) {
          if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] || '')) return finish(new Error(`Health check ${healthPath} must return application/json`));
          let body;
          try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { return finish(new Error(`Health check ${healthPath} returned invalid JSON`)); }
          if (!body || Array.isArray(body) || body.schemaVersion !== 1 || body.status !== 'ready') return finish(new Error(`Health check ${healthPath} did not report ready`));
          if (body.buildId !== undefined && generation.buildId && body.buildId !== generation.buildId) return finish(new Error(`Health check ${healthPath} returned a different build`));
        }
        finish();
      });
    });
    req.once('error', finish); req.end();
  });
}

export async function health(generation, config, timeout) {
  const deadline = Date.now() + timeout;
  await probe(generation, config, nativeHealthPath, timeout, true);
  if (config.healthPath !== nativeHealthPath) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Application health check exceeded its deadline');
    await probe(generation, config, config.healthPath, remaining, false);
  }
}
