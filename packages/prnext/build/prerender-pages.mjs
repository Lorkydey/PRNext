import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {localizedStaticPaths} from './i18n.mjs';
const isDynamic=pattern=>pattern.includes('[');

export async function prerenderPages(stage, manifest, dev) {
  // Development renders on demand. Do not load a fresh renderer or execute
  // getStaticProps/getStaticPaths for every route on every edit.
  const renderer = dev ? null : await import(pathToFileURL(path.join(stage, 'runtime/render.mjs')).href);
  const paths = new Set();
  const seedsByRoute = new Map();
  const validatedDocuments = new Set();
  const staticListings = new Map();
  // Error page data is available when another static page returns notFound.
  const ordered = [...manifest.routes].sort((left, right) => Number(!!right.errorStatus) - Number(!!left.errorStatus));
  for (const route of ordered) {
    if (route.kind !== 'page' || route.router === 'app') continue;
    const modulePath = path.join(stage, route.module);
    const page = await import(pathToFileURL(modulePath).href);
    if (page.__prnextDocument && !validatedDocuments.has(page.__prnextDocument)) {
      for (const name of ['getStaticProps', 'getStaticPaths', 'getServerSideProps']) {
        if (Object.hasOwn(page.__prnextDocument, name) || typeof page.Document?.[name] === 'function') throw new Error(`pages/_document does not support ${name}. Use Document.getInitialProps for server document rendering.`);
      }
      validatedDocuments.add(page.__prnextDocument);
    }
    if (route.errorStatus && (page.getServerSideProps || page.default?.getInitialProps)) throw new Error(`pages${route.pattern} must be static and cannot use getServerSideProps or getInitialProps. Use getStaticProps instead.`);
    route.gip = typeof page.default?.getInitialProps === 'function';
    route.appGip = !!page.App && page.App.getInitialProps !== page.App.origGetInitialProps;
    if (route.internal && route.errorStatus && route.appGip) {
      // A custom App hook makes the built-in Error request-dependent. Select
      // its actual _error module so the default status props and visible URL
      // reach App.getInitialProps instead of a synthetic static wrapper.
      const kind = route.errorStatus === 404 ? 'notFound' : 'serverError';
      if (manifest.pagesErrors?.[kind] === route.id) delete manifest.pagesErrors[kind];
    }
    if (route.gip && (page.getStaticProps || page.getServerSideProps)) throw new Error(`Page ${route.pattern} cannot combine getInitialProps with getStaticProps or getServerSideProps.`);
    if (route.internal && !route.errorStatus) {
      if (page.getStaticProps || page.getServerSideProps || page.getStaticPaths) throw new Error('pages/_error does not support getStaticProps, getServerSideProps or getStaticPaths. Use ErrorComponent.getInitialProps instead.');
      continue;
    }
    if (page.getServerSideProps && page.getStaticProps) throw new Error(`Page ${route.pattern} exports both getServerSideProps and getStaticProps. Choose one.`);
    if (page.getStaticPaths && !page.getStaticProps) throw new Error(`Page ${route.pattern} exports getStaticPaths without getStaticProps.`);
    if (page.getServerSideProps) { route.ssp = true; continue; }
    if (page.getStaticProps) route.ssg = true;
    else if (route.gip || route.appGip) continue;
    if (isDynamic(route.pattern) && page.getStaticProps && !page.getStaticPaths) throw new Error(`Dynamic page ${route.pattern} with getStaticProps must export getStaticPaths.`);
    if (!isDynamic(route.pattern) && page.getStaticPaths) throw new Error(`getStaticPaths is only valid on dynamic pages (${route.pattern}).`);
    // Preserve data/export validation and SSG metadata. The dev PageCache calls
    // getStaticPaths per request, including fallback:false and locale checks.
    if (dev) continue;
    let entries = [{ path: route.pattern, params: {} }];
    if (isDynamic(route.pattern)) {
      if (!page.getStaticProps) continue;
      if (!staticListings.has(modulePath)) staticListings.set(modulePath, Promise.resolve().then(() => page.getStaticPaths(manifest.config.i18n ? {locales: manifest.config.i18n.locales, defaultLocale: manifest.config.i18n.defaultLocale} : {})));
      const result = localizedStaticPaths(route, await staticListings.get(modulePath), manifest.config.i18n);
      route.fallback = result.fallback;
      entries = result.paths;
    }
    for (const entry of entries) {
      if (paths.has(entry.path)) throw new Error(`Multiple pages prerender the same path: ${entry.path}.`);
      paths.add(entry.path);
      const rendered = await renderer.prerenderRoute({ ...manifest.config, manifest, distDir: stage, route, modulePath, path: entry.path, params: entry.params, client: route.client, css: route.css, pattern: route.pattern, errorStatus: route.errorStatus, buildId: manifest.buildId, production: !dev });
      const file = `static/${createHash('sha256').update(entry.path).digest('hex').slice(0, 20)}.html`;
      await writeFile(path.join(stage, file), rendered.body);
      const seed = { routeId: route.id, path: entry.path, file, status: route.errorStatus || rendered.status || 200, headers: rendered.headers || {} };
      if (route.ssg) {
        seed.dataFile = file.replace(/\.html$/, '.json');
        seed.revalidate = rendered.revalidate ?? false;
        seed.generatedAt = rendered.generatedAt;
        await writeFile(path.join(stage, seed.dataFile), rendered.dataJSON);
      }
      manifest.prerendered.push(seed);
      if (!seedsByRoute.has(route.id)) seedsByRoute.set(route.id, []);
      seedsByRoute.get(route.id).push(seed);
    }
    if (route.fallback === true) {
      const rendered = await renderer.renderFallback({ ...manifest.config, modulePath, path: route.pattern, params: {}, client: route.client, css: route.css, pattern: route.pattern, buildId: manifest.buildId, production: !dev });
      route.fallbackFile = `static/fallback-${route.id}.html`;
      await writeFile(path.join(stage, route.fallbackFile), rendered.body);
    }
  }
  // Rendering errors first must not change the published route/seed ordering.
  manifest.prerendered = manifest.routes.flatMap(route => seedsByRoute.get(route.id) || []);
}
