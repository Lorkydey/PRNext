import test from 'node:test';
import assert from 'node:assert/strict';
import { i18nFixture } from './i18n-fixture.mjs';
import { startServer } from './support.mjs';
import {request} from 'node:http';
function hostRequest(url,headers){return new Promise((resolve,reject)=>{request(url,{headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));}).on('error',reject).end()})}
test('Pages locales share bundles while static HTML, JSON and blocking paths remain separate',async()=>{
  const f=await i18nFixture();let server;
  try{
    const manifest=await f.build();server=await startServer(f.root);
    const negotiated=await fetch(server.url,{headers:{'accept-language':'fr;q=0.9,en;q=0.5'},redirect:'manual'});
    assert.equal(negotiated.status,307);assert.equal(negotiated.headers.get('location'),'/fr');
    const cookie=await fetch(server.url,{headers:{'accept-language':'fr','cookie':'NEXT_LOCALE=nl'},redirect:'manual'});assert.equal(cookie.headers.get('location'),'/nl');
    const domain=await hostRequest(server.url+'/server',{host:'fr.test'});assert.equal(domain.status,200);assert.equal(domain.headers.get('x-locale'),'fr');assert.equal(domain.headers.get('x-pathname'),'/server');
    const domainRedirect=await hostRequest(server.url,{host:'en.test','accept-language':'fr'});assert.equal(domainRedirect.headers.get('location'),'http://fr.test/');
    const alias=await fetch(server.url+'/fr/alias');assert.equal(alias.status,200);assert.match(await alias.text(),/fr/);
    const defaultData=await fetch(server.url+'/_next/data/i18n-test/en/index.json');assert.equal(defaultData.status,200);
    assert.equal(new Set(manifest.routes.filter(route=>route.originalPattern==='/').map(route=>route.client)).size,1);
    for(const locale of ['en','fr','nl']){
      const prefix=locale==='en'?'':'/'+locale;
      const missing=await fetch(server.url+prefix+'/does-not-exist');assert.equal(missing.status,404);assert.match(await missing.text(),new RegExp('Missing <!-- -->'+locale));
      const home=await fetch(server.url+prefix+'/');assert.equal(home.status,200);assert.match(await home.text(),new RegExp(`<html lang="${locale}"`));
      for(const id of ['one','unknown']){
        const response=await fetch(server.url+prefix+'/article/'+id);assert.equal(response.status,200);assert.match(await response.text(),new RegExp('Article <!-- -->'+locale));
        const data=await(await fetch(server.url+'/_next/data/i18n-test'+prefix+'/article/'+id+'.json')).json();
        assert.equal(data.pageProps.locale,locale);assert.equal(data.__PRNEXT_ROUTER__.pathname,'/article/[id]');assert.equal(data.__PRNEXT_ROUTER__.asPath,'/article/'+id);
      }
    }
  }finally{await server?.close();await f.remove()}
});
