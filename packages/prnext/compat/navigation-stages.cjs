'use strict';
const { optionalRequestContext, inCacheScope } = require('./data-cache.cjs');

function postponeStage(name) {
  throw Object.assign(new Error(`Deferred until ${name}.`), { code: 'PRNEXT_PPR_DYNAMIC', digest: 'PRNEXT_PPR_DYNAMIC' });
}
function stage(name) {
  const context = optionalRequestContext();
  if (!context?.cacheComponents) throw new Error(`${name}() requires cacheComponents: true.`);
  if (inCacheScope()) throw new Error(`${name}() cannot run inside a cached function. Call it before invoking the cached function.`);
  // Static prerenders deliberately continue through both gates. Cacheable work
  // remains prerenderable and is not made request-dependent by either API.
  if (context.staticState) return;
  if (context.navigationStage === 'shell' && (name === 'navigation' || context.partialPrefetching)) postponeStage(name);
  if (context.navigationStage === 'prefetch' && name === 'navigation') postponeStage(name);
}
async function navigation() { stage('navigation'); }
async function prefetch() { stage('prefetch'); }
module.exports = { navigation, prefetch, postponeStage };
