import test from 'node:test';
import assert from 'node:assert/strict';
import { trailingSlashFixture } from './trailing-slash-fixture.mjs';
import { startServer } from './support.mjs';

for (const basePath of ['', '/docs']) for (const trailingSlash of [false, true]) test(`trailingSlash=${trailingSlash} mount=${basePath || '/'}: priority redirects, transport, files and rewrites`, async () => {
  const fixture=await trailingSlashFixture({basePath,trailingSlash}); let server;
  try {
    server=await startServer(fixture.root,['--workers','1']);
    const get=(path,options={})=>fetch(server.url+basePath+path,{redirect:'manual',...options});
    const canonical = path => trailingSlash ? path+'/' : path;
    for(const path of ['/legacy/one','/app/start','/cached','/plain-file','/old']) {
      const noncanonical=trailingSlash?path:path+'/';
      const response=await get(noncanonical+'?x=a%2Fb&x=two');
      assert.equal(response.status,308,path);
      assert.equal(response.headers.get('location'),basePath+canonical(path)+'?x=a%2Fb&x=two');
      assert.equal(response.headers.get('x-probe-path'),null,'canonical redirect precedes middleware');
      assert.equal(response.headers.get('x-configured-slash'),'yes','headers precede canonical redirects');
    }
    for(const path of ['/legacy/one','/app/start','/cached','/plain-file']) assert.equal((await get(canonical(path))).status,200,path);
    assert.equal((await get('/file.txt')).status,200);
    const image=await fetch(server.url+fixture.manifest.config.images.path+'?url='+encodeURIComponent(basePath+'/pixel.png')+'&w=32&q=75',{headers:{accept:'image/webp'},redirect:'manual'});
    assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
    const repeated=await fetch(server.url+'//outside.test/path/?q=1',{redirect:'manual'});
    assert.equal(repeated.status,308);assert.equal(repeated.headers.get('location'),'/outside.test/path/?q=1');
    assert.equal((await get('/file.txt/')).headers.get('location'),basePath+'/file.txt');
    assert.equal(await (await get('/.well-known/token')).text(),'well known');
    if(trailingSlash) assert.equal((await get('/.well-known/token/')).status,200);
    const root=await fetch(server.url+(basePath||'/')+(basePath&&!trailingSlash?'/':''),{redirect:'manual'});
    assert.equal(root.status,basePath?308:200);
    if(basePath) assert.equal(root.headers.get('location'),basePath+(trailingSlash?'/':''));
    const html=await (await get(canonical('/plain'))).text();
    assert.ok(html.includes(`href="${basePath}/legacy/linked${trailingSlash?'/':''}?query=one#anchor"`));
    const data=await get('/_next/data/slash-fixture/legacy/one.json?x=1');
    assert.equal(data.status,200);assert.equal(data.headers.get('x-probe-path'),'/legacy/one');
    assert.equal((await data.json()).pageProps.params.slug,'one');
    const rewritten=await get('/_rustyx/data/slash-fixture/alias/book.json?x=1');
    assert.equal(rewritten.status,200);assert.equal((await rewritten.json()).pageProps.params.slug,'book');
    const post=await get(trailingSlash?'/api/echo':'/api/echo/',{method:'POST',body:'payload',headers:{'content-type':'text/plain'}});
    assert.equal(post.status,308);
    const followed=await fetch(server.url+basePath+(trailingSlash?'/api/echo':'/api/echo/'),{method:'POST',body:'payload',headers:{'content-type':'text/plain'}});
    assert.equal((await followed.json()).body,'payload');
  }finally{await server?.close();await fixture.remove();}
});

for(const skipMiddlewareUrlNormalize of [false,true]) test(`skip flags preserve raw slash policy and ${skipMiddlewareUrlNormalize?'raw':'normalized'} middleware inputs`,async()=>{
  const fixture=await trailingSlashFixture({basePath:'/docs',trailingSlash:true,skipTrailingSlashRedirect:true,skipMiddlewareUrlNormalize});let server;
  try{
    server=await startServer(fixture.root);
    for(const path of ['/docs','/docs/','/docs/legacy/one','/docs/legacy/one/'])assert.equal((await fetch(server.url+path,{redirect:'manual'})).status,200,path);
    const path='/docs/_rustyx/data/slash-fixture/legacy/one.json?x=1&_rsc=token';
    const response=await fetch(server.url+path,{headers:{rsc:'1','next-router-state-tree':'tree'}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('x-probe-path'),skipMiddlewareUrlNormalize?'/_rustyx/data/slash-fixture/legacy/one.json':'/legacy/one');
    assert.equal(response.headers.get('x-probe-url').includes('_rsc=token'),skipMiddlewareUrlNormalize);
    assert.equal(response.headers.get('x-probe-rsc'),skipMiddlewareUrlNormalize?'1':'absent');
    assert.equal(response.headers.get('x-probe-tree'),skipMiddlewareUrlNormalize?'tree':'absent');
    assert.equal((await response.json()).pageProps.params.slug,'one');
  }finally{await server?.close();await fixture.remove();}
});
