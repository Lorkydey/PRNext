import test from 'node:test';
import assert from 'node:assert/strict';
import {getQueryClient,dehydrateQuery} from '../compat/query-server.cjs';
import {runRequestContext} from '../compat/headers.cjs';
import {QueryClient} from '@tanstack/query-core';
import {runCacheScope} from '../compat/data-cache.cjs';

test('Query clients and concurrent prefetches are request-owned, with stable unchanged dehydration',async()=>{
  const clients=[];
  const results=await Promise.all(['owner-A','owner-B'].map(owner=>runRequestContext({headers:{}},async()=>{
    const client=getQueryClient();clients.push(client);assert.equal(getQueryClient(),client);
    let calls=0;const options={queryKey:['same-key'],queryFn:async()=>({owner,calls:++calls})};
    await Promise.all([client.prefetchQuery(options),getQueryClient().prefetchQuery(options)]);
    const first=dehydrateQuery();assert.equal(dehydrateQuery(),first);assert.equal(calls,1);
    assert.equal(client.getQueryCache().getAll()[0].gcTime,Infinity);
    client.setQueryData(['same-key'],{owner,calls:2});
    const updated=dehydrateQuery();assert.notEqual(updated,first);assert.equal(dehydrateQuery(),updated);
    return updated.queries[0].state.data;
  })));
  assert.notEqual(clients[0],clients[1]);assert.deepEqual(results,[{owner:'owner-A',calls:2},{owner:'owner-B',calls:2}]);
  for(const client of clients)client.clear();
  assert.throws(()=>getQueryClient(),/PRNext request/);
});

test('Query custom dehydration filters are reevaluated instead of caching mutable policy decisions',()=>{
  const client=new QueryClient();client.setQueryData(['x'],1);let allowed=true;
  const options={shouldDehydrateQuery:()=>allowed};
  assert.equal(dehydrateQuery(client,options).queries.length,1);allowed=false;
  assert.equal(dehydrateQuery(client,options).queries.length,0);client.clear();
});

test('request Query clients and snapshots cannot enter shared cache scopes',()=>{
  runRequestContext({},()=>{
    const client=getQueryClient();
    runCacheScope(()=>{
      assert.throws(()=>getQueryClient(),/outside a cache scope/);
      assert.throws(()=>dehydrateQuery(client),/outside a cache scope/);
    });
    client.clear();
  });
});
