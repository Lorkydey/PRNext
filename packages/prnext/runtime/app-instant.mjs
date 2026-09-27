import React from 'react';
import { renderFlight, decodeFlight } from './app-render.mjs';
import { requestOptions } from './app-static.mjs';
import { prerenderPartialHtml } from './app-partial.mjs';

export async function validateInstantRoute(options) {
  const request = requestOptions(options);
  if (!request.cacheComponents || options.route.internal) return [];
  const warnings = [];
  for (const [index, sample] of (options.route.instantSamples || [undefined]).entries()) {
  const sampled = sample ? sampleRequest(request, sample) : request;
  const result = await renderFlight({ ...sampled, instantValidation: true, staticGeneration: { mode: 'auto', partial: true } });
  const model = await decodeFlight(result.body, request.clientModules, request.distDir, { production: request.production });
  for (const segment of model.instantTrees || []) {
    const shell = await prerenderPartialHtml({ router: model.router, tree: React.createElement('html', null,
      React.createElement('head'), React.createElement('body', null, segment.tree)) }, {}, { navigation: true });
    if (!shell) warnings.push(`Route ${request.routePattern}${sample ? ` (sample ${index + 1})` : ''}: instant navigation below shared layout ${segment.path} would block on uncached data. Add a loading.js or a Suspense boundary below that layout, or cache the data with "use cache".`);
  }
  }
  if (warnings.length && request.production) throw Object.assign(new Error(warnings.join('\n')), { code: 'PRNEXT_INSTANT_BLOCKING' });
  return warnings;
}

function sampleRequest(request, sample) {
  const url = new URL(request.url);
  for (const [name, value] of Object.entries(sample.searchParams || {})) if (value !== null) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, item);
  const headers = Object.fromEntries((sample.headers || []).filter(([,value]) => value !== null));
  if (sample.cookies) headers.cookie = sample.cookies.filter(item=>item.value !== null).map(item=>`${item.name}=${encodeURIComponent(item.value)}`).join('; ');
  return {...request, url:url.href, headers, params:{...request.params,...sample.params}, instantSample:sample};
}
