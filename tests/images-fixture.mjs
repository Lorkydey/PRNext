import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export function imagePNG(width = 800, height = 400) {
  function chunk(name, data) {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = y * (width * 4 + 1) + 1 + x * 4; pixels[i] = x % 256; pixels[i + 1] = y % 256; pixels[i + 2] = 120; pixels[i + 3] = x < width / 2 ? 180 : 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
export async function imagesFixture(options = {}) {
  const fixture = await appFixture();
  const photo = imagePNG(), counts = new Map(), seen = [], gates = new Map();
  const origin = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://origin'); counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1); seen.push({ path: url.pathname, headers: request.headers });
    await gates.get(url.pathname)?.promise;
    if (url.pathname.startsWith('/cdn/_prnext/assets/')) {
      try {
        const name = decodeURIComponent(url.pathname.slice('/cdn/_prnext/assets/'.length));
        if (name !== path.basename(name)) throw new Error('invalid asset');
        const bytes = await readFile(path.join(fixture.root, '.prnext/assets', name));
        response.writeHead(200, { 'content-type': /\.m?js$/.test(name) ? 'text/javascript' : /\.css$/.test(name) ? 'text/css' : 'image/png', 'access-control-allow-origin': '*' }); return response.end(bytes);
      } catch { response.statusCode = 404; return response.end(); }
    }
    if (url.pathname === '/allowed/redirect') { response.writeHead(302, { location: '/allowed/photo.png' }); return response.end(); }
    if (url.pathname === '/allowed/loop') { response.writeHead(302, { location: '/allowed/loop' }); return response.end(); }
    if (url.pathname === '/allowed/large') { response.writeHead(200, { 'content-length': 2000000 }); return response.end(Buffer.alloc(2000000)); }
    if (url.pathname === '/allowed/invalid') return response.end('not an image');
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public,max-age=120', 'access-control-allow-origin': '*' }); response.end(photo);
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originURL = `http://127.0.0.1:${origin.address().port}`;
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true, force: true });
    const config = { basePath: '/docs', ...(options.cdn ? {assetPrefix: originURL + '/cdn'} : {}), images: { deviceSizes: [320, 640, 960], imageSizes: [16, 32, 64, 128, 256], qualities: [50, 75], formats: ['image/avif', 'image/webp'], maximumResponseBody: 1_000_000, dangerouslyAllowLocalIP: true, remotePatterns: [{ protocol: 'http', hostname: '127.0.0.1', port: String(origin.address().port), pathname: '/allowed/**' }], ...options.images } };
    const files = {
      'next.config.mjs': `export default ${JSON.stringify(config)};`,
      'public/photo.png': photo,
      'public/vector.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>',
      'photo.png': photo,
      'components/images.jsx': `'use client';import Image from 'next/image';import {useState} from 'react';import photo from '../photo.png';export default function Gallery(){const [events,setEvents]=useState([]);return <main><h1>Image gallery</h1><Image data-testid="static-image" src={photo} width={160} alt="Imported landscape" placeholder="blur" preload onLoad={event=>setEvents(values=>[...values,event.type+':'+event.currentTarget.tagName])}/><Image data-testid="remote-image" src=${JSON.stringify(originURL + '/allowed/photo.png')} width={128} height={64} alt="Remote landscape" quality={50}/><div style={{position:'relative',width:320,height:160}}><Image data-testid="fill-image" src="/docs/photo.png" fill sizes="320px" alt="Cover landscape"/></div><Image src="/docs/vector.svg" width={80} height={40} alt="Vector"/><output data-testid="image-events">{events.join(',')}</output></main>}`,
      'pages/gallery.jsx': `export {default} from '../components/images';`,
      'components/broken-image.jsx': `'use client';import Image from 'next/image';import {useEffect,useState} from 'react';import photo from '../photo.png';export default function Broken(){const [events,setEvents]=useState([]);useEffect(()=>{window.__brokenImageHydrated=true},[]);const record=value=>setEvents(values=>[...values,value]);return <main><Image data-testid="broken-image" src="/docs/missing-before-hydration.png" unoptimized width={80} height={40} alt="Unavailable landscape" loading="eager" placeholder="blur" blurDataURL={photo.blurDataURL} onLoad={()=>record('load')} onLoadingComplete={()=>record('complete')} onError={event=>record('error:'+event.type)}/><output data-testid="broken-events">{events.join(',')}</output></main>}`,
      'pages/broken-image.jsx': `export {default} from '../components/broken-image';`,
      'app/broken-image-app/page.jsx': `export {default} from '../../components/broken-image';`,
      'app/layout.jsx': `export default function Layout({children}){return <html><head/><body>{children}</body></html>}`,
      'app/gallery-app/page.jsx': `import Gallery from '../../components/images';import {getImageProps} from 'next/image';export default function Page(){const {props}=getImageProps({src:'/docs/photo.png',width:128,height:64,alt:'Server image props'});return <><Gallery/><img data-testid="server-props" {...props}/></>}`,
      'app/api/photo/route.js': `import {readFile} from 'node:fs/promises';import path from 'node:path';export async function GET(){return new Response(await readFile(path.join(process.cwd(),'public/photo.png')),{headers:{'content-type':'image/png'}})}`,
    };
    for (const [name, contents] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents); }
    const build = async () => { await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 }); return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8')); };
    return { ...fixture, originURL, photo, counts, seen, build,
      hold(name) { let resolve; const promise = new Promise(done => { resolve = done; }); gates.set(name, { promise, resolve }); return () => { gates.delete(name); resolve(); }; },
      async remove() { for (const gate of gates.values()) gate.resolve(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); },
    };
  } catch (error) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); throw error; }
}
