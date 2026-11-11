import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {frameworkOptimizationsFixture} from './framework-optimizations-fixture.mjs';
import {startServer} from './support.mjs';

test('production bootstrap excludes unrelated routes while Query Flight snapshots are deduplicated and request-private',async()=>{
  const fixture=await frameworkOptimizationsFixture();let server;
  try{
    const manifest=await fixture.build();assert.equal(manifest.app.clientReferenceMode,'chunk-v1');
    const entry=manifest.routes.find(route=>route.router==='app'&&route.pattern==='/query').client;
    const bootstrap=await readFile(path.join(fixture.root,'.prnext/assets',path.basename(entry)),'utf8');
    for(const [id,entry]of Object.entries(manifest.app.clientModules)){
      assert.ok(!bootstrap.includes(entry.browserModule),'bootstrap contains no all-route importer URL: '+id);
    }
    server=await startServer(fixture.root);
    for(const rsc of [false,true]){
      const results=await Promise.all(['request-A','request-B','request-C','request-D'].map(async owner=>{
        const response=await fetch(server.url+'/query',{headers:{'x-query-owner':owner,...(rsc?{RSC:'1'}:{})}});
        assert.equal(response.status,200);const body=await response.text();assert.ok(body.includes(owner));
        if(rsc)assert.equal(body.split('QUERY-SNAPSHOT-ONLY-ONCE-123456789').length-1,1,'unchanged state is serialized once across two hydration boundaries');
        else for(const name of ['one','two'])assert.match(body,new RegExp('data-testid="query-'+name+'">'+owner+':ssr:1<'));
        return body;
      }));
      for(let i=0;i<results.length;i++)for(let j=0;j<results.length;j++)if(i!==j)assert.ok(!results[i].includes('request-'+String.fromCharCode(65+j)),'concurrent requests retain distinct data');
    }
    const deferred=await fetch(server.url+'/deferred');assert.equal(deferred.status,200);const html=await deferred.text();assert.match(html,/data-testid="deferred-button">Deferred <!-- -->0/);assert.match(html,/server text/);
    const legacy=await fetch(server.url+'/query-legacy',{headers:{'x-query-owner':'pages-owner'}});assert.equal(legacy.status,200);const legacyHtml=await legacy.text();assert.match(legacyHtml,/pages-owner:ssr:1/);
    const edge=await fetch(server.url+'/deferred-edge');assert.equal(edge.status,200);assert.match(await edge.text(),/server text/);
    await server.close();server=undefined;
    const manifestFile=path.join(fixture.root,'.prnext/manifest.json'),before=await readFile(manifestFile);
    await fixture.write('app/query-edge/page.jsx',`import{getQueryClient}from'@thomas.f/prnext/query/server';export const runtime='edge';export default function Page(){getQueryClient();return null}`);
    await assert.rejects(fixture.build(),/Query SSR integration requires the Node runtime/);
    assert.deepEqual(await readFile(manifestFile),before,'unsupported Edge Query cannot publish a partial replacement build');
  }finally{await server?.close();await fixture.remove();}
});
