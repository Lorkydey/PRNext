'use strict';
const { NextRequest, NextResponse, NextURL } = require('./server-primitives.cjs');

async function connection() {
  const context = require('./headers.cjs').currentRequest();
  const { forceStaticRender, dynamicUsage } = require('./static-generation.cjs');
  if (forceStaticRender(context)) return;
  if (require('./data-cache.cjs').inCacheScope()) throw new Error('connection() cannot be used inside unstable_cache');
  if (context.operation === 'static-params') throw new Error('connection() cannot be used inside generateStaticParams');
  dynamicUsage('connection()', context);
}

module.exports = { NextRequest, NextResponse, NextURL, connection };
