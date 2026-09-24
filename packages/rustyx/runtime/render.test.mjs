import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { renderPage, runApi, prerenderRoute, getStaticPaths, MAX_RESPONSE_BYTES } from './render.mjs';
import { STREAM_CHUNK_BYTES } from './stream-utils.mjs';
import { createProtocolOutput } from './transport.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const compat = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../compat');
const react = JSON.stringify(require.resolve('react'));
let sequence = 0;

test('a plain Pages API needs no Web Request, Response or Headers implementation', async t => {
  const modulePath=await fixture(t, `exports.default=(req,res)=>res.json({value:req.body.value,preview:req.preview,draft:req.draftMode});`);
  const source=`
    import assert from 'node:assert/strict';
    for(const name of ['Request','Response','Headers'])Object.defineProperty(globalThis,name,{configurable:true,get(){throw new Error('Unnecessary Web HTTP initialization: '+name)}});
    const {runApi}=await import(${JSON.stringify(new URL('./api.mjs',import.meta.url).href)});
    const result=await runApi({modulePath:${JSON.stringify(modulePath)},url:'http://localhost/api',method:'POST',headers:{'content-type':'application/json'},body:Buffer.from('{"value":"small"}'),manifest:{previewModeId:'valid'},stream:true});
    const chunks=[];for await(const chunk of result.body)chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{value:'small',preview:false,draft:false});
    await result.finalizeCache();
  `;
  execFileSync(process.execPath,['--input-type=module','-e',source],{stdio:'pipe',timeout:10000});
});

test('lazy Pages request headers preserve snapshots, readonly methods, cookies and async context isolation', async () => {
  const {runRequestContext,headers,cookies,currentRequest}=await import('../compat/headers.cjs');
  await Promise.all(['Ada','Lin'].map(visitor=>{
    const input={phase:'pages',headers:{Cookie:'visitor='+visitor,'x-value':visitor}};
    return runRequestContext(input,async()=>{
      input.headers.Cookie='visitor=changed';input.headers['x-value']='changed';
      await new Promise(resolve=>setImmediate(resolve));
      const h=await headers();assert.equal(h.get('x-value'),visitor);assert.throws(()=>h.set('x-value','bad'),/read-only/);
      assert.equal((await cookies()).get('visitor').value,visitor);
      assert.equal(currentRequest().headers,h);assert.equal(await cookies(),currentRequest().cookies);
    });
  }));
});

test('Pages body parsing releases raw upload bytes while opt-out preserves the stream', async t => {
  const body=JSON.stringify({padding:'x'.repeat(32768)});
  for(const parsed of [true,false]) {
    const modulePath=await fixture(t, `exports.config={api:{bodyParser:${parsed}}};exports.default=(req,res)=>res.json({queued:req.readableLength,parsed:req.body?.padding.length,raw:req.read()?.toString()});`);
    const response=await runApi({modulePath,url:'http://localhost/api',method:'POST',headers:{'content-type':'application/json'},body:Buffer.from(body),stream:true});
    const chunks=[];for await(const chunk of response.body)chunks.push(chunk);
    const value=JSON.parse(Buffer.concat(chunks));
    if(parsed)assert.deepEqual(value,{queued:0,parsed:32768});
    else assert.deepEqual(value,{queued:Buffer.byteLength(body),raw:body});
  }
});

test('negotiated complete replies send bounded raw bytes and preserve cookies; streamed and ISR replies retain frames', async () => {
  for (const [body, negotiated, isr, expected] of [
    [Buffer.from('é🚀'), true, undefined, 'complete'],
    [Buffer.alloc(16384), true, undefined, 'complete'],
    [Buffer.alloc(16385), true, undefined, 'head'],
    [Buffer.from('old'), false, undefined, 'head'],
    [Buffer.from('isr'), true, {htmlLength:3,dataLength:0}, 'head'],
    [(async function*(){yield Buffer.from('progressive')})(), true, undefined, 'head'],
  ]) {
    const chunks=[];
    await createProtocolOutput((part, done)=>{chunks.push(Buffer.from(part));done()}, {cork(){},uncork(){}})(42,
      {status:201,headers:{'set-cookie':['a=1','b=2']},body,isr}, {stream:true,compactResponse:negotiated});
    const head=JSON.parse(chunks[0]); assert.equal(head.type,expected); assert.deepEqual(head.headers['set-cookie'],['a=1','b=2']);
    if(expected==='complete'){assert.equal(head.length,body.length);assert.deepEqual(chunks[1],body);assert.equal(chunks.length,2)}
    else assert.equal(JSON.parse(chunks.at(-1)).type,'end');
  }
});

test('small terminal Pages responses batch protocol frames and own reusable bytes', async t => {
  const modulePath = await fixture(t, `exports.default=(req,res)=>{
    res.setHeader('set-cookie',['a=1','b=2']);
    const bytes=Buffer.from('small é🚀');
    res.end(bytes,()=>bytes.fill(120));
  };`);
  const result = await runApi({ modulePath, url: 'http://localhost/api', stream: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.bufferedBody.toString(), 'small é🚀');
  assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
  const chunks = []; let batches = 0;
  await createProtocolOutput((chunk, callback) => { chunks.push(Buffer.from(chunk)); callback(); },
    { cork: () => batches++, uncork: () => {} })(7, result, { stream: true });
  assert.equal(batches, 1);
  assert.equal(JSON.parse(chunks[0]).type, 'head');
  assert.equal(JSON.parse(chunks[1]).length, Buffer.byteLength('small é🚀'));
  assert.equal(chunks[2].toString(), 'small é🚀');
  assert.equal(JSON.parse(chunks[3]).type, 'end');
});

test('Pages compact responses respect the byte threshold and explicit streaming', async t => {
  for (const [setup, size, compact] of [['', 16384, true], ['', 16385, false], ['res.flushHeaders();', 3, false], ['res.writeHead(201);', 3, false], ["res.write('prefix');", 3, false]]) {
    const modulePath = await fixture(t, `exports.default=(_req,res)=>{${setup}res.end(Buffer.alloc(${size},65));};`);
    const result = await runApi({ modulePath, url: 'http://localhost/api', stream: true });
    assert.equal(Buffer.isBuffer(result.bufferedBody), compact);
    const chunks=[]; for await (const chunk of result.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, size + (setup.includes('prefix') ? 6 : 0));
    await result.cancel();
  }
});

test('delayed Pages JSON keeps completion callbacks and independent request values', async t => {
  const modulePath = await fixture(t, `exports.finishes=0;exports.default=async(req,res)=>{
    await new Promise(resolve=>setImmediate(resolve));
    res.on('finish',()=>exports.finishes++);res.json({nonce:req.query.nonce});
  };`);
  for (const nonce of ['first','second']) {
    const result=await runApi({modulePath,url:'http://localhost/api?nonce='+nonce,stream:true});
    let text='';for await(const chunk of result.body)text+=chunk;
    assert.deepEqual(JSON.parse(text),{nonce});
  }
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(require(modulePath).finishes,2);
});

test('destroying flushed Pages headers before the first write rejects the lazy body', async t => {
  const modulePath=await fixture(t, `exports.default=(_req,res)=>{
    res.flushHeaders();res.destroy(new Error('failed before first byte'));
  };`);
  const result=await deadline(runApi({modulePath,url:'http://localhost/api',stream:true}));
  t.after(()=>result.cancel());
  await assert.rejects(deadline(result.body.next()),/failed before first byte/);
});

async function fixture(t, code, extension = 'cjs') {
  const folder = await mkdtemp(path.join(tmpdir(), 'rustyx-runtime-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, `fixture-${sequence++}.${extension}`);
  await writeFile(file, code);
  return file;
}

function dataFromHtml(html) {
  const script = html.match(/<script>(window\.__RUSTYX_DATA__=[\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const context = vm.createContext({ window: {} });
  vm.runInContext(script, context);
  return JSON.parse(JSON.stringify(context.window.__RUSTYX_DATA__));
}

test('route handler cookie mutations survive redirect control flow', async t => {
  const modulePath = await fixture(t, `
    const {cookies}=require(${JSON.stringify(path.join(compat, 'headers.cjs'))});
    const {redirect}=require(${JSON.stringify(path.join(compat, 'navigation-server.cjs'))});
    exports.GET=async()=>{(await cookies()).set('session','redirected',{httpOnly:true});redirect('/destination');};
  `);
  const response = await runApi({ modulePath, url: 'http://localhost/redirect' });
  assert.equal(response.status, 307);
  assert.equal(response.headers.location, '/destination');
  assert.deepEqual(response.headers['set-cookie'], ['session=redirected; Path=/; HttpOnly']);
});

test('SSR shares router and Head context, escapes payload, and preserves query arrays and __proto__', async t => {
  const modulePath = await fixture(t, `
    const React = require(${react});
    const Head = require(${JSON.stringify(path.join(compat, 'head.cjs'))});
    const { useRouter } = require(${JSON.stringify(path.join(compat, 'router.cjs'))});
    exports.default = props => { const router=useRouter(); return React.createElement(React.Fragment,null,
      React.createElement(Head,null,React.createElement('title',null,'Profile '+router.query.id)),
      React.createElement('p',null,props.payload)); };
    exports.getServerSideProps = ({req,res,params,query,resolvedUrl}) => {
      res.setHeader('set-cookie',['one=1; HttpOnly','two=2']);
      return {props:{payload:'</script><script>alert(1)</script>\\u2028&', params,query,resolvedUrl,cookie:req.cookies.session}};
    };
  `);
  const result = await renderPage({ modulePath, url: 'http://localhost/user/42?tag=a&tag=b&__proto__=safe', params: { id: '42' }, headers: { cookie: 'session=hello%20world' }, route: { pattern: '/user/[id]', client: '/_rustyx/assets/page.js' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.headers['set-cookie'], ['one=1; HttpOnly', 'two=2']);
  const html = result.body.toString();
  assert.match(html, /<title[^>]*>Profile 42<\/title>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;\/script&gt;/);
  const data = dataFromHtml(html);
  assert.deepEqual(data.router.query.tag, ['a', 'b']);
  assert.equal(data.router.query.id, '42');
  assert.equal(data.router.pathname, '/user/[id]');
  assert.ok(Object.hasOwn(data.router.query, '__proto__'));
  assert.equal(data.router.query.__proto__, 'safe');
  assert.equal(data.props.cookie, 'hello world');
  assert.equal(data.props.payload, '</script><script>alert(1)</script>\u2028&');
});

test('Head state and metadata do not leak between renders', async t => {
  const modulePath = await fixture(t, `
    const React=require(${react}); const Head=require(${JSON.stringify(path.join(compat, 'head.cjs'))});
    exports.default=({label})=>React.createElement(Head,null,React.createElement('title',null,label));
    exports.getServerSideProps=({query})=>({props:{label:query.label}});
  `);
  const [one, two] = await Promise.all(['first', 'second'].map(label => renderPage({ modulePath, url: `http://localhost/?label=${label}` })));
  assert.match(one.body.toString(), />first<\/title>/);
  assert.doesNotMatch(one.body.toString(), />second<\/title>/);
  assert.match(two.body.toString(), />second<\/title>/);
  assert.doesNotMatch(two.body.toString(), />first<\/title>/);
});

test('rewrites keep original request URLs and expose destination queries to Pages data functions', async t => {
  const modulePath = await fixture(t, `
    const React=require(${react});
    exports.default=()=>React.createElement('p',null,'rewritten');
    exports.getServerSideProps=({req,resolvedUrl,query})=>({props:{url:req.url,resolvedUrl,query}});
  `);
  const result = await renderPage({ modulePath, originalUrl: 'http://localhost/alias/book?collision=visible&from=browser',
    url: 'http://localhost/target/book?collision=destination&from=browser&injected=yes', params: { slug: 'book' },
    route: { pattern: '/target/[slug]' } });
  const data = dataFromHtml(result.body.toString());
  assert.equal(data.props.url, '/alias/book?collision=visible&from=browser');
  assert.equal(data.props.resolvedUrl, '/target/book?collision=visible&from=browser');
  assert.deepEqual(data.props.query, { collision: 'destination', from: 'browser', injected: 'yes', slug: 'book' });
  assert.equal(data.router.asPath, data.props.url);
  assert.equal(data.router.pathname, '/target/[slug]');
  assert.deepEqual(data.router.query, data.props.query);
});

test('rewritten Pages API and Web handlers receive the original request URL', async t => {
  const originalUrl = 'http://localhost/api-alias?from=browser';
  const url = 'http://localhost/api/target?from=browser&injected=yes';
  const pages = await fixture(t, `exports.default=(req,res)=>res.json({url:req.url,query:req.query});`);
  const pagesResult = await runApi({ modulePath: pages, originalUrl, url });
  assert.deepEqual(JSON.parse(pagesResult.body), { url: '/api-alias?from=browser', query: { from: 'browser', injected: 'yes' } });
  const web = await fixture(t, `exports.GET=req=>Response.json({url:req.url,nextUrl:req.nextUrl.href});`);
  const webResult = await runApi({ modulePath: web, route: { router: 'app' }, originalUrl, url });
  assert.deepEqual(JSON.parse(webResult.body), { url: originalUrl, nextUrl: originalUrl });
});

test('Head includes inert structured data with its owner in the rendered document', async t => {
  const modulePath = await fixture(t, `
    const React=require(${react}); const Head=require(${JSON.stringify(path.join(compat, 'head.cjs'))});
    exports.default=()=>React.createElement(Head,null,React.createElement('script',{type:'application/ld+json',dangerouslySetInnerHTML:{__html:JSON.stringify({'@type':'WebSite',name:'Rustyx'})}}));
  `);
  const { body } = await renderPage({ modulePath });
  const script = body.toString().match(/<script(?=[^>]*type="application\/ld\+json")(?=[^>]*data-rustyx-head-owner=)[^>]*>([^<]+)<\/script>/);
  assert.ok(script);
  assert.deepEqual(JSON.parse(script[1]), { '@type': 'WebSite', name: 'Rustyx' });
});

test('SSR handles custom App, redirects, notFound and custom response completion', async t => {
  const modulePath = await fixture(t, `
    const React=require(${react});
    exports.default=({value})=>React.createElement('p',null,value);
    exports.App=({Component,pageProps,router})=>React.createElement('main',null,React.createElement(Component,pageProps),router.pathname);
    exports.getServerSideProps=({query,res})=>{
      if(query.mode==='redirect')return{redirect:{destination:'/login',permanent:false}};
      if(query.mode==='missing')return{notFound:true};
      if(query.mode==='finished'){res.statusCode=201;res.end('custom');return;}
      res.statusCode=202; return{props:{value:'ok'}};
    };
  `);
  const redirect = await renderPage({ modulePath, url: 'http://localhost/?mode=redirect' });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.location, '/login');
  assert.equal((await renderPage({ modulePath, url: 'http://localhost/?mode=missing' })).status, 404);
  assert.equal((await renderPage({ modulePath, url: 'http://localhost/?mode=finished' })).body.toString(), 'custom');
  const page = await renderPage({ modulePath, url: 'http://localhost/' });
  assert.equal(page.status, 202);
  assert.match(page.body.toString(), /<main><p>ok<\/p>\/<\/main>/);
});

test('data functions reject missing results, non-serializable props and invalid ISR durations', async t => {
  for (const expression of ['undefined', '{props:{date:new Date()}}', '{props:{missing:undefined}}', '{props:{},revalidate:-1}', '{props:{},revalidate:1.5}', '{props:{},revalidate:true}']) {
    const modulePath = await fixture(t, `exports.default=()=>null; exports.getStaticProps=()=>(${expression});`);
    await assert.rejects(prerenderRoute({ modulePath }));
  }
});

test('native ESM preserves default exports and top-level await during rendering and static loading', async t => {
  const modulePath = await fixture(t, `
    import React from ${react};
    const label = await Promise.resolve('esm-ready');
    export default function Page({value}) { return React.createElement('p',null,label+':'+value); }
    export async function getStaticProps() { return {props:{value:label}}; }
    export async function getStaticPaths() { return {paths:['/esm'],fallback:false}; }
  `, 'mjs');
  const result = await prerenderRoute({ modulePath, path: '/esm' });
  assert.match(result.body, /<p>esm-ready:esm-ready<\/p>/);
  assert.deepEqual(await getStaticPaths({ modulePath }), { paths: ['/esm'], fallback: false });
  const page = await renderPage({ modulePath, url: 'http://localhost/esm' });
  assert.match(page.body.toString(), /<p>esm-ready:esm-ready<\/p>/);
  const apiPath = await fixture(t, `
    const value=await Promise.resolve('esm-api');
    export default function handler(_req,res){res.json({value});}
  `, 'mjs');
  assert.deepEqual(JSON.parse((await runApi({ modulePath: apiPath, url: 'http://localhost/api' })).body), { value: 'esm-api' });
});

test('Pages API supports query, JSON bodies, cookies and repeated response headers', async t => {
  const modulePath = await fixture(t, `exports.default=(req,res)=>res.status(201).setHeader('set-cookie',['a=1','b=2']).json({query:req.query,body:req.body,cookies:req.cookies,method:req.method});`);
  const result = await runApi({ modulePath, method: 'POST', url: 'http://localhost/api?tag=a&tag=b', params: { id: '7' }, headers: { 'content-type': 'application/json', cookie: 'one=a%20b; malformed=%xx' }, body: Buffer.from('{"ok":true}').toString('base64') });
  assert.equal(result.status, 201);
  assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
  assert.deepEqual(JSON.parse(result.body), { query: { tag: ['a', 'b'], id: '7' }, body: { ok: true }, cookies: { one: 'a b', malformed: '%xx' }, method: 'POST' });
  await assert.rejects(runApi({ modulePath, method: 'POST', url: 'http://localhost/api', headers: { 'content-type': 'application/json' }, body: Buffer.from('{bad').toString('base64') }), { statusCode: 400 });
});

test('Pages API raw request streams, callback completion and binary bodies remain intact', async t => {
  const modulePath = await fixture(t, `exports.config={api:{bodyParser:false}}; exports.default=(req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>setTimeout(()=>res.send(Buffer.concat(chunks)),5));};`);
  const bytes = Buffer.from([0, 128, 255, 42]);
  const result = await runApi({ modulePath, method: 'POST', url: 'http://localhost/api', body: bytes.toString('base64') });
  assert.deepEqual(result.body, bytes);
  assert.equal(result.headers['content-type'], 'application/octet-stream');
});

test('API response buffers enforce the 16 MiB boundary', async t => {
  const modulePath = await fixture(t, `exports.default=(_req,res)=>res.send(Buffer.alloc(${MAX_RESPONSE_BYTES + 1}));`);
  await assert.rejects(runApi({ modulePath, url: 'http://localhost/api' }), /16 MiB/);
});

test('Web route handlers preserve binary responses and advertise allowed methods', async t => {
  const modulePath = await fixture(t, `exports.GET=async(_req,{params})=>new Response(new Uint8Array([0,128,255]),{headers:{'x-id':(await params).id}});`);
  const result = await runApi({ modulePath, url: 'http://localhost/api', params: { id: '9' } });
  assert.deepEqual(result.body, Buffer.from([0, 128, 255]));
  assert.equal(result.headers['x-id'], '9');
  const disallowed = await runApi({ modulePath, url: 'http://localhost/api', method: 'POST' });
  assert.equal(disallowed.status, 405);
  assert.match(disallowed.headers.allow, /GET.*HEAD.*OPTIONS/);
});

async function deadline(promise, milliseconds = 1000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Streaming test deadline exceeded')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test('Pages streaming returns flushed headers and first bytes before its async handler completes', async t => {
  const modulePath = await fixture(t, `
    const gate=new Promise(resolve=>exports.release=resolve);
    exports.default=async(_req,res)=>{
      res.status(201).setHeader('set-cookie',['first=1','second=2']);res.flushHeaders();
      res.write(Buffer.from([0,128,255]));await gate;res.end('tail');
    };
  `);
  const result = await deadline(runApi({ modulePath, url: 'http://localhost/api', stream: true }));
  t.after(() => result.cancel());
  assert.equal(result.status, 201);
  assert.deepEqual(result.headers['set-cookie'], ['first=1', 'second=2']);
  const iterator = result.body[Symbol.asyncIterator]();
  assert.deepEqual((await deadline(iterator.next())).value, Buffer.from([0, 128, 255]));
  require(modulePath).release();
  assert.equal(Buffer.from((await deadline(iterator.next())).value).toString(), 'tail');
  assert.equal((await deadline(iterator.next())).done, true);
});

test('Web streaming preserves response headers and cookie mutations while forwarding bytes progressively', async t => {
  const modulePath = await fixture(t, `
    const {cookies}=require(${JSON.stringify(path.join(compat, 'headers.cjs'))});
    exports.GET=async(req)=>{
      exports.signal=req.signal;(await cookies()).set('session','streamed',{httpOnly:true});
      return new Response(new ReadableStream({start(controller){
        controller.enqueue(new Uint8Array([1,2,3]));
        exports.release=()=>{controller.enqueue(new Uint8Array([4,5]));controller.close();};
      }}),{headers:{'content-type':'application/octet-stream','x-stream':'yes','set-cookie':'response=1'}});
    };
  `);
  const result = await deadline(runApi({ modulePath, url: 'http://localhost/api', stream: true }));
  t.after(() => result.cancel());
  assert.deepEqual(result.headers['set-cookie'], ['response=1', 'session=streamed; Path=/; HttpOnly']);
  assert.equal(result.headers['x-stream'], 'yes');
  assert.deepEqual((await result.body.next()).value, new Uint8Array([1, 2, 3]));
  require(modulePath).release();
  assert.deepEqual((await result.body.next()).value, new Uint8Array([4, 5]));
  assert.equal((await result.body.next()).done, true);
  assert.equal(require(modulePath).signal.aborted, false);
});

test('lazy Web stream pulls retain request context while cookies become read-only after headers', async t => {
  const modulePath = await fixture(t, `
    const {cookies,headers}=require(${JSON.stringify(path.join(compat, 'headers.cjs'))});
    exports.GET=()=>new Response(new ReadableStream({async pull(controller){
      const store=await cookies();let rejected=false;
      try{store.set('late','not sent');}catch{rejected=true;}
      controller.enqueue(new TextEncoder().encode((await headers()).get('x-stream')+':'+store.get('theme').value+':'+rejected));controller.close();
    }},{highWaterMark:0}));
  `);
  const result = await runApi({ modulePath, url: 'http://localhost/api', headers: { 'x-stream': 'context', cookie: 'theme=dark' }, stream: true });
  assert.equal(Buffer.from((await result.body.next()).value).toString(), 'context:dark:true');
  assert.equal((await result.body.next()).done, true);
  assert.equal(result.headers['set-cookie'], undefined);
});

test('Pages streaming applies write backpressure and streams beyond the buffered 16 MiB limit', async t => {
  const count = Math.floor(MAX_RESPONSE_BYTES / STREAM_CHUNK_BYTES) + 2;
  const modulePath = await fixture(t, `
    const {once}=require('node:events');exports.sent=0;exports.maxQueued=0;
    exports.default=async(_req,res)=>{
      for(let index=0;index<${count};index++){
        const writable=res.write(Buffer.alloc(${STREAM_CHUNK_BYTES},index%256));
        exports.maxQueued=Math.max(exports.maxQueued,res.writableLength);
        if(!writable)await once(res,'drain');exports.sent++;
      }res.end();
    };
  `);
  const result = await deadline(runApi({ modulePath, url: 'http://localhost/api', stream: true }));
  t.after(() => result.cancel());
  await delay(10);
  assert.equal(require(modulePath).sent, 0, 'producer waits until the consumer reads its first chunk');
  let bytes = 0;
  for await (const chunk of result.body) {
    assert.ok(chunk.byteLength <= STREAM_CHUNK_BYTES);
    bytes += chunk.byteLength;
  }
  assert.equal(bytes, count * STREAM_CHUNK_BYTES);
  assert.equal(require(modulePath).sent, count);
  assert.ok(require(modulePath).maxQueued <= STREAM_CHUNK_BYTES);
});

test('Pages write callbacks allow buffer reuse without corrupting unread response bytes', async t => {
  const modulePath = await fixture(t, `
    exports.reused=false;
    exports.default=(_req,res)=>{
      const buffer=Buffer.from('first');
      res.write(buffer,()=>{buffer.fill(120);exports.reused=true;res.end('tail');});
    };
  `);
  const result = await runApi({ modulePath, url: 'http://localhost/api', stream: true });
  t.after(() => result.cancel());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(require(modulePath).reused, true, 'the producer has reused its buffer before consumption');
  let output = '';
  for await (const chunk of result.body) output += Buffer.from(chunk).toString();
  assert.equal(output, 'firsttail');
});

test('Web streaming is pull based, splits large chunks, and has no buffered total-size cap', async t => {
  const total = MAX_RESPONSE_BYTES + STREAM_CHUNK_BYTES + 17;
  const modulePath = await fixture(t, `
    exports.pulls=0;
    exports.GET=()=>new Response(new ReadableStream({pull(controller){
      exports.pulls++;controller.enqueue(new Uint8Array(${total}));controller.close();
    }},{highWaterMark:0}));
  `);
  const result = await runApi({ modulePath, url: 'http://localhost/api', stream: true });
  t.after(() => result.cancel());
  assert.equal(require(modulePath).pulls, 0);
  let bytes = 0;
  for await (const chunk of result.body) { assert.ok(chunk.byteLength <= STREAM_CHUNK_BYTES); bytes += chunk.byteLength; }
  assert.equal(bytes, total);
  assert.equal(require(modulePath).pulls, 1);
});

test('canceling an unread Pages body aborts IncomingMessage and closes its response producer', async t => {
  const modulePath = await fixture(t, `
    exports.aborted=0;exports.closed=0;
    exports.default=(req,res)=>{
      exports.request=req;exports.response=res;
      const timer=setInterval(()=>res.write('event'),100);
      req.on('aborted',()=>{exports.aborted++;clearInterval(timer);});
      res.on('close',()=>{exports.closed++;clearInterval(timer);});
      res.flushHeaders();
    };
  `);
  const result = await deadline(runApi({ modulePath, url: 'http://localhost/api', stream: true }));
  t.after(() => result.cancel());
  await deadline(result.body.return());
  await delay(0);
  const mod = require(modulePath);
  assert.equal(mod.aborted, 1);
  assert.equal(mod.closed, 1);
  assert.equal(mod.request.aborted, true);
  assert.equal(mod.request.destroyed, true);
  assert.equal(mod.response.destroyed, true);
});

test('Web cancellation aborts Request.signal and does not wait for an uncooperative cancel callback', async t => {
  const modulePath = await fixture(t, `
    exports.canceled=0;
    exports.GET=req=>{
      exports.signal=req.signal;
      return new Response(new ReadableStream({cancel(){exports.canceled++;return new Promise(()=>{});}}));
    };
  `);
  const result = await runApi({ modulePath, url: 'http://localhost/api', stream: true });
  await deadline(result.cancel());
  assert.equal(require(modulePath).signal.aborted, true);
  assert.equal(require(modulePath).canceled, 1);
});

test('consumer AbortSignal interrupts pending body reads for Web and Pages APIs', async t => {
  for (const code of [
    `exports.default=(req,res)=>{exports.request=req;res.flushHeaders();};`,
    `exports.GET=req=>{exports.signal=req.signal;return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));};`,
  ]) {
    const modulePath = await fixture(t, code);
    const controller = new AbortController();
    const result = await runApi({ modulePath, url: 'http://localhost/api', stream: true, signal: controller.signal });
    const pending = result.body.next();
    controller.abort(new Error('Disconnected consumer'));
    await assert.rejects(deadline(pending), /Disconnected consumer/);
    const mod = require(modulePath);
    assert.equal(mod.signal?.aborted ?? mod.request.aborted, true);
  }
});

test('streaming preserves early errors and fails an already-started body on late errors without rerunning', async t => {
  const early = await fixture(t, `exports.default=()=>{throw new Error('early failure');};`);
  await assert.rejects(runApi({ modulePath: early, url: 'http://localhost/api', stream: true }), /early failure/);
  const late = await fixture(t, `
    exports.calls=0;const gate=new Promise(resolve=>exports.release=resolve);
    exports.default=async(_req,res)=>{exports.calls++;res.write('started');await gate;throw new Error('late failure');};
  `);
  const result = await runApi({ modulePath: late, url: 'http://localhost/api', stream: true });
  assert.equal(Buffer.from((await result.body.next()).value).toString(), 'started');
  require(late).release();
  await assert.rejects(deadline(result.body.next()), /late failure/);
  assert.equal(require(late).calls, 1);
});

test('streaming timeouts measure initial headers and inactivity rather than total progressing duration', async t => {
  const silent = await fixture(t, `exports.default=()=>{};`);
  await assert.rejects(deadline(runApi({ modulePath: silent, url: 'http://localhost/api', stream: true, timeoutMs: 30 })), error => error.statusCode === 504 && /headers/.test(error.message));
  const idle = await fixture(t, `exports.GET=()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));`);
  const stalled = await runApi({ modulePath: idle, url: 'http://localhost/api', stream: true, timeoutMs: 30 });
  await assert.rejects(deadline(stalled.body.next()), error => error.statusCode === 504 && /idle/.test(error.message));
  const progressing = await fixture(t, `exports.default=async(_req,res)=>{for(let index=0;index<5;index++){res.write('x');await new Promise(resolve=>setTimeout(resolve,20));}res.end();};`);
  const result = await runApi({ modulePath: progressing, url: 'http://localhost/api', stream: true, timeoutMs: 60 });
  let text = '';
  for await (const chunk of result.body) text += Buffer.from(chunk).toString();
  assert.equal(text, 'xxxxx');
});

test('HEAD and no-body statuses suppress and cancel streaming bodies without draining producers', async t => {
  const web = await fixture(t, `exports.GET=req=>{exports.signal=req.signal;exports.canceled=false;return new Response(new ReadableStream({cancel(){exports.canceled=true;}}),{headers:{'x-head':'yes'}});};`);
  const head = await runApi({ modulePath: web, url: 'http://localhost/api', method: 'HEAD', stream: true });
  assert.equal(head.body.byteLength, 0);
  assert.equal(head.headers['x-head'], 'yes');
  assert.equal(require(web).canceled, true);
  assert.equal(require(web).signal.aborted, true);
  for (const status of [204, 205, 304]) {
    const pages = await fixture(t, `exports.default=(_req,res)=>res.status(${status}).end('not sent');`);
    const result = await runApi({ modulePath: pages, url: 'http://localhost/api', stream: true });
    assert.equal(result.status, status);
    assert.equal(result.body.byteLength, 0);
  }
});

test('worker loads the runtime from the built project and preserves stdout framing during imports', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, '.rustyx');
  await mkdir(path.join(dist, 'runtime'), { recursive: true });
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify({ routes: [
    { id: 'page', kind: 'page', module: 'server/page.cjs' },
    { id: 'app', kind: 'page', router: 'app', pattern: '/app/[id]', module: 'server/app.mjs', fallback: false,
      allowedPaths: ['/app/built'], dynamicPaths: ['/app/built'] },
  ] }));
  await writeFile(path.join(dist, 'runtime/render.mjs'), `
    console.log('runtime import log'); process.stdout.write('direct import output\\n');
    export const renderPage=async()=>({status:200,headers:{'x-runtime':'project'},body:'project-owned runtime'});
    export const renderPageRequest=renderPage;
    export const runApi=renderPage;
    export const errorResponse=()=>({status:500,body:'failed'});
  `);
  await writeFile(path.join(dist, 'runtime/http.mjs'), `export const errorResponse=()=>({status:500,body:'failed'});`);
  await writeFile(path.join(dist, 'runtime/app-render.mjs'), `export const renderAppPage=async options=>({status:200,body:'dynamic App path: '+options.url});`);
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), root], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (worker.exitCode === null) worker.kill(); });
  let stdout = '', stderr = '';
  worker.stdout.on('data', chunk => { stdout += chunk; });
  worker.stderr.on('data', chunk => { stderr += chunk; });
  worker.stdin.end([
    { id: 7, routeId: 'page', url: 'http://localhost/' },
    { id: 8, routeId: 'app', url: 'http://localhost/app/built' },
  ].map(request => JSON.stringify(request) + '\n').join(''));
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  const [result, app] = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(result.id, 7);
  assert.equal(result.headers['x-runtime'], 'project');
  assert.equal(Buffer.from(result.body, 'base64').toString(), 'project-owned runtime');
  assert.match(stderr, /runtime import log/);
  assert.match(stderr, /direct import output/);
  assert.equal(app.status, 200, 'allowed dynamic App paths need no Pages prerender seed');
  assert.equal(Buffer.from(app.body, 'base64').toString(), 'dynamic App path: http://localhost/app/built');
});
