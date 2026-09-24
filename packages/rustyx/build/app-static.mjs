import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { staticPath } from '../runtime/pages-paths.mjs';

const MAX_STATIC_PATHS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const parameter = /^\[(\[)?(\.\.\.)?([^\]]+)\]\]?$/;

export function appStaticEntries(pattern, generated) {
  if (!Array.isArray(generated) || generated.length > MAX_STATIC_PATHS) throw new Error(`generateStaticParams for ${pattern} must return at most ${MAX_STATIC_PATHS} parameter objects.`);
  const dynamic = pattern.split('/').map(segment => parameter.exec(segment)).filter(Boolean);
  const entries = new Map();
  for (const params of generated) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(`generateStaticParams for ${pattern} must return parameter objects.`);
    let complete = true;
    const validated = {};
    const actual = {};
    for (const match of dynamic) {
      const name = match[3];
      const value = Object.hasOwn(params, name) ? params[name] : undefined;
      if (value === undefined && !match[1]) {
        complete = false;
        Object.defineProperty(validated, name, { value: match[2] ? ['__rustyx_unbound__'] : '__rustyx_unbound__', enumerable: true });
      } else {
        Object.defineProperty(validated, name, { value, enumerable: true });
        if (value !== undefined) Object.defineProperty(actual, name, { value, enumerable: true });
      }
    }
    // Validate supplied values even when another segment is still unbound.
    try { staticPath(pattern, { params: validated }); }
    catch (error) { throw new Error(error.message.replaceAll('getStaticPaths', 'generateStaticParams')); }
    if (!complete) continue;
    const entry = staticPath(pattern, { params: actual });
    if (!entries.has(entry.path)) entries.set(entry.path, entry);
  }
  return [...entries.values()];
}

export async function prerenderApp(stage, manifest, dev) {
  const routes = manifest.routes.filter(route => route.router === 'app');
  if (!routes.length || dev) return;
  const { closeAppRuntime } = await import(pathToFileURL(path.join(stage, 'runtime/app-render.mjs')).href);
  const occupied = new Set(manifest.prerendered.map(page => page.path));
  try {
    const pages = routes.some(route => route.kind === 'page')
      ? await import(pathToFileURL(path.join(stage, 'runtime/app-static.mjs')).href) : null;
    const handlers = routes.some(route => route.kind === 'api')
      ? await import(pathToFileURL(path.join(stage, 'runtime/route-static.mjs')).href) : null;
    for (const route of routes) {
      const handler = route.kind === 'api';
      const options = { modulePath: path.join(stage, route.module), distDir: stage, manifest, route, production: true };
      // This fixed internal entry shares the root layout, but its parameter
      // generators belong to user routes and must never run for a global 404.
      const inspected = route.id === manifest.appNotFound ? { generated: false, params: [{}] }
        : handler ? await handlers.inspectAppRouteHandler(options) : await pages.inspectAppStatic(options);
      route.hasStaticParams = inspected.generated;
      if (handler) route.handlerMethods = inspected.methods;
      const dynamic = route.pattern.includes('[');
      const entries = appStaticEntries(route.pattern, dynamic ? inspected.params : [{}]);
      const config = route.cacheConfig;
      // Keep generated-path restrictions and method metadata for Edge routes,
      // while separating dynamic rendering from the persistent Data Cache.
      if (config.runtime === 'edge') {
        if (dynamic && config.dynamicParams === false) route.allowedPaths = entries.map(entry => entry.path);
        continue;
      }
      const partial = !handler && manifest.config?.cacheComponents === true && (!config.dynamic || config.dynamic === 'auto');
      if (partial && dynamic && !inspected.generated) entries.length = 0;
      if (partial && dynamic && inspected.generated && inspected.params.length === 0) {
        throw new Error(`generateStaticParams for ${route.pattern} must return at least one parameter object when cacheComponents is enabled.`);
      }
      if (partial && dynamic) for (const supplied of inspected.params) {
        if (inspected.generated && appStaticEntries(route.pattern, [supplied]).length) continue;
        const params = { ...supplied }, unknown = [];
        for (const segment of route.pattern.split('/')) {
          const match = parameter.exec(segment);
          if (!match || Object.hasOwn(supplied, match[3])) continue;
          unknown.push(match[3]);
          params[match[3]] = match[2] ? ['__rustyx_unbound__'] : '__rustyx_unbound__';
        }
        const fallback = staticPath(route.pattern, { params });
        // Validate unknown parameter access and save its reusable build shell.
        // Concrete Flight uses explicit framework key bindings; the opaque React
        // continuation itself is never patched.
        const rendered = await pages.prerenderAppRoute({ ...options, path: fallback.path, params, partialParams: unknown });
        if (rendered.partial) {
          const file = `static/generic-${createHash('sha256').update(route.id + JSON.stringify(supplied)).digest('hex').slice(0, 20)}.json`;
          await writeFile(path.join(stage, file), JSON.stringify({ ...rendered.partial, ...rendered.metadata }));
          (route.pprGeneric ||= []).push({ file, params: supplied, unknown });
        }
      }
      if (partial && route.instantBuild) {
        const { validateInstantRoute } = await import(pathToFileURL(path.join(stage, 'runtime/app-instant.mjs')).href);
        for (const entry of entries.length ? entries : [{ path: route.pattern.replace(/\[\[?(?:\.\.\.)?[^\]]+\]\]?/g, '__rustyx_instant__'), params: Object.fromEntries(route.pattern.split('/').map(segment => parameter.exec(segment)).filter(Boolean).map(match => [match[3], match[2] ? ['__rustyx_instant__'] : '__rustyx_instant__'])) }]) await validateInstantRoute({ ...options, path: entry.path, params: entry.params });
      }
      if (partial) route.pprFallback = config.dynamicParams !== false;
      if (dynamic && config.dynamicParams === false) route.allowedPaths = entries.map(entry => entry.path);
      if (handler) {
        if (!inspected.staticEligible) continue;
        if (dynamic && !inspected.generated && !['force-static', 'error'].includes(config.dynamic)) continue;
      } else {
        if (config.dynamic === 'force-dynamic' || (config.dynamic !== 'force-static' && (config.revalidate === 0 || config.forceNoStore))) continue;
        if (dynamic && !inspected.generated && !partial && !['force-static', 'error'].includes(config.dynamic)) continue;
      }
      route.ssg = true;
      route.fallback = config.dynamicParams === false ? false : 'blocking';
      for (const entry of entries) {
        if (occupied.has(entry.path)) throw new Error(`Multiple pages prerender the same path: ${entry.path}.`);
        const rendered = await (handler ? handlers.prerenderAppRouteHandler : pages.prerenderAppRoute)({ ...options, path: entry.path, params: entry.params });
        if (rendered.partial) {
          const file = `static/partial-${createHash('sha256').update(entry.path).digest('hex').slice(0, 20)}.json`;
          await writeFile(path.join(stage, file), JSON.stringify({ ...rendered.partial, ...rendered.metadata }));
          (route.ppr ||= {})[entry.path] = file;
          if (!dynamic) { delete route.ssg; delete route.fallback; }
          else (route.dynamicPaths ||= []).push(entry.path);
          occupied.add(entry.path);
          continue;
        }
        if (rendered.dynamic) {
          if (!handler && config.dynamic === 'error') throw new Error(`App route ${entry.path} with dynamic='error' used dynamic data: ${rendered.reason || 'dynamic rendering required'}.`);
          if (!dynamic) { delete route.ssg; delete route.fallback; delete route.pprFallback; }
          else {
            (route.dynamicPaths ||= []).push(entry.path);
            // A failed handler export removes Next's dynamic prerender entry;
            // successful seeds survive, while ungenerated paths stay dynamic.
            if (handler && config.dynamicParams !== false) route.fallback = 'dynamic';
          }
          continue;
        }
        const body = Buffer.isBuffer(rendered.body) ? rendered.body : Buffer.from(rendered.body);
        const flight = handler ? null : Buffer.isBuffer(rendered.flight) ? rendered.flight : Buffer.from(rendered.flight);
        if (body.byteLength > MAX_RESPONSE_BYTES || (flight && flight.byteLength > MAX_RESPONSE_BYTES)) throw new Error(`Static App route ${entry.path} exceeds the 16 MiB response limit.`);
        const stem = `static/${handler ? 'route' : 'app'}-${createHash('sha256').update(entry.path).digest('hex').slice(0, 20)}`;
        const file = `${stem}.${handler ? 'body' : 'html'}`;
        // Flight is opaque text, not JSON; the native cache supplies text/x-component.
        const dataFile = handler ? undefined : `${stem}.txt`;
        await writeFile(path.join(stage, file), body);
        if (dataFile) await writeFile(path.join(stage, dataFile), flight);
        occupied.add(entry.path);
        manifest.prerendered.push({ routeId: route.id, path: entry.path, file, ...(dataFile ? { dataFile } : {}), status: rendered.status ?? 200,
          headers: rendered.headers || {}, revalidate: rendered.revalidate ?? config.revalidate,
          generatedAt: rendered.generatedAt, tags: rendered.tags || [], paths: rendered.paths || [],
        });
      }
      // Unseen Cache Components paths are generated by the PPR runtime, which
      // handles either complete HTML/Flight or a resumable shell atomically.
      if (partial && dynamic) {
        if (manifest.prerendered.some(page => page.routeId === route.id)) {
          // Concrete complete seeds use the native invalidation-aware cache.
          // Other paths still reach the PPR runtime, including dynamic holes.
          route.ssg = true; route.fallback = 'ppr';
        } else { delete route.ssg; delete route.fallback; }
      }
    }
  } finally { await closeAppRuntime(); }
}
