import { cacheLife, cacheTag, type CacheHandler } from 'next/cache';
import { ImageResponse, type ImageResponseOptions } from 'next/og';
import type { InstantConfig, NextConfig } from 'prnext';

const configuration: NextConfig = { cacheComponents: true, cacheHandlers: { remote: './cache-handler.ts', analytics: './analytics.mjs' }, experimental: { serverActions: { bodySizeLimit: '2mb', allowedOrigins: ['*.example.test'] } }, cacheLife: { product: { stale: 10, revalidate: 60, expire: 3600 } }, pageExtensions: ['page.tsx', 'ts'], reactStrictMode: true };
const incrementalConfiguration: NextConfig = { cacheHandler: './incremental.ts', cacheMaxMemorySize: 0, output: 'standalone', outputFileTracingRoot: '/workspace', outputFileTracingIncludes: { '/products/*': ['./data/**'] }, outputFileTracingExcludes: { '/*': ['./data/*.bak'] } };
const instant: InstantConfig = { level: 'warning', unstable_samples: [{cookies:[{name:'session',value:null}],headers:[['x-test','yes']],params:{slug:['a']},searchParams:{q:null}}] };
export const handler: CacheHandler = { async get() { return undefined; }, async set(key, entry) { await (await entry).value.cancel(); }, async refreshTags() {}, async getExpiration() { return 0; }, async updateTags() {} };
export async function CachedProducts({ id }: { id: string }) {
  'use cache';
  cacheLife('product');
  cacheLife({ revalidate: 20, expire: 40 });
  cacheTag('products', id);
  return <h1>{id}</h1>;
}
const options: ImageResponseOptions = { width: 1200, height: 630, status: 200, headers: { 'x-test': 'yes' } };
export const image = new ImageResponse(<div style={{ display: 'flex' }}>PRNext</div>, options);
void configuration;
void incrementalConfiguration;
void instant;
