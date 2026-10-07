import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readBuildDirectory } from '../runtime/build-directory.mjs';

export function explainRoute(route, manifest) {
  const seeds = manifest.prerendered.filter(seed => seed.routeId === route.id || (!seed.routeId && seed.path === route.pattern));
  const config = route.cacheConfig || {};
  const reasons = [...(route.dynamicReasons || [])];
  if (route.ssp) reasons.push('getServerSideProps runs for each request');
  if (route.gip) reasons.push('page getInitialProps runs for each request');
  if (route.appGip && !route.ssg) reasons.push('custom App getInitialProps disables automatic static rendering');
  if (config.dynamic === 'force-dynamic') reasons.push('dynamic is force-dynamic');
  if (config.revalidate === 0) reasons.push('revalidate is 0');
  if (config.forceNoStore || config.fetchCache === 'force-no-store') reasons.push('route data cache is disabled');
  if (config.runtime === 'edge') reasons.push('Edge runtime');
  if (!reasons.length && !seeds.length && !route.ssg) reasons.push(route.kind === 'api' ? 'request handler' : route.router === 'app' ? 'request-time rendering or paths not generated at build time' : 'getServerSideProps, getInitialProps, or another request-time dependency');
  const partial = Boolean(route.ppr || route.pprGeneric || route.fallback === 'ppr');
  const mode = partial ? 'partial' : seeds.length || route.ssg ? 'static / ISR' : 'dynamic';
  return { pattern: route.pattern, router: route.router || 'pages', kind: route.kind, mode,
    reasons: [...new Set(reasons)], prerenderedPaths: seeds.length,
    revalidate: [...new Set(seeds.map(seed => seed.revalidate ?? false))],
    invalidation: { tags: [...new Set(seeds.flatMap(seed => seed.tags || []))], paths: [...new Set(seeds.flatMap(seed => seed.paths || []))] } };
}
export async function inspectProject(directory) {
  const root = path.resolve(directory), output = await readBuildDirectory(root);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, output, 'manifest.json'), 'utf8')); }
  catch (error) { throw new Error(`Cannot read a build in ${root}. Run prn build first.`, { cause: error }); }
  const folder = path.join(root, '.prnext-cache/inspect');
  let names = [];
  try { names = (await readdir(folder)).filter(name => /^(?:worker-\d+-\d+|native-\d+)\.jsonl(?:\.1)?$/.test(name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = await Promise.all(names.map(async name => ({ name, info: await stat(path.join(folder, name)).catch(() => null) })));
  const events = [];
  for (const { name, info } of files.filter(value => value.info?.isFile() && value.info.size <= 2 * 1024 ** 2).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 64)) {
    const source = await readFile(path.join(folder, name), 'utf8').catch(() => '');
    for (const line of source.split('\n')) { try { const value = JSON.parse(line); if (typeof value.time === 'number' && typeof value.type === 'string') events.push(value); } catch {} }
  }
  events.sort((a, b) => a.time - b.time);
  const recent = events.slice(-10000), groups = new Map(), entries = new Map();
  for (const event of recent) {
    if (event.type === 'cache' && typeof event.key === 'string') entries.set(event.key, { key: event.key, route: event.route, state: event.state, tags: event.tags || [], paths: event.paths || [], time: event.time });
    if (!['http', 'fetch', 'cache'].includes(event.type)) continue;
    const key = JSON.stringify([event.type, event.route, event.destination || null, event.state || null, event.reason || null]);
    if (!groups.has(key)) groups.set(key, { type: event.type, route: event.route, destination: event.destination, state: event.state, reason: event.reason, count: 0, durations: [], errors: 0 });
    const group = groups.get(key); group.count++; if (event.status >= 500 || event.error) group.errors++;
    if (Number.isFinite(event.durationMs)) group.durations.push(event.durationMs);
  }
  const measurements = [...groups.values()].map(({ durations, ...group }) => {
    durations.sort((a, b) => a - b);
    return { ...group, ...(durations.length ? { meanMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length * 100) / 100, p95Ms: durations[Math.ceil(durations.length * .95) - 1], maxMs: durations.at(-1) } : {}) };
  }).sort((a, b) => (b.p95Ms || 0) - (a.p95Ms || 0));
  return { version: 1, root, buildId: manifest.buildId, routes: manifest.routes.filter(route => !route.internal).map(route => explainRoute(route, manifest)),
    measurements, cacheEntries: [...entries.values()].slice(-100), invalidations: recent.filter(event => event.type === 'invalidation').slice(-50), dynamicUsage: recent.filter(event => event.type === 'dynamic').slice(-50),
    sample: { events: recent.length, from: recent[0]?.time, to: recent.at(-1)?.time },
    notes: ['Enable measurements with prn start --inspect (or prn dev --inspect), visit routes, then run prn inspect again.',
      'HTTP and fetch durations end when response headers are ready. Samples are bounded and can span server sessions; they are not full-response benchmarks.',
      'Fetch destinations omit queries and credentials. Runtime cache tags/paths are hashed; matching identifiers link reads to invalidations. No diagnostic HTTP endpoint is exposed.'] };
}
export function printInspection(report) {
  console.log(`PRNext inspector: ${report.root}`);
  for (const route of report.routes) console.log(`${route.mode.padEnd(13)} ${route.pattern}\n  ${route.reasons.join('; ') || `${route.prerenderedPaths} prerendered path(s); revalidate: ${route.revalidate.join(', ') || 'on demand'}`}`);
  for (const item of report.measurements) console.log(`${item.type.toUpperCase()} ${item.route}${item.destination ? ' -> ' + item.destination : ''}: ${item.count} sample(s)${item.state ? ', ' + item.state : ''}${item.reason ? ' (' + item.reason + ')' : ''}${item.p95Ms !== undefined ? ', p95 ' + item.p95Ms.toFixed(2) + ' ms' : ''}, ${item.errors} error(s)`);
  for (const event of report.invalidations) console.log(`INVALIDATION ${event.route}: ${event.mode}; tags ${(event.tags || []).join(', ') || 'none'}; paths ${(event.paths || []).join(', ') || 'none'}`);
  for (const event of report.cacheEntries) console.log(`CACHE ENTRY ${event.key} ${event.route}: ${event.state}; tags ${event.tags.join(', ') || 'none'}; paths ${event.paths.join(', ') || 'none'}`);
  for (const message of new Set(report.dynamicUsage.map(event => `DYNAMIC ${event.route}: ${event.reason}`))) console.log(message);
  for (const note of report.notes) console.log(note);
}
