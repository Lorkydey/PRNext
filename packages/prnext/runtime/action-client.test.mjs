import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

test('New development chunks use the mounted action transport, while production graphs stay isolated',async()=>{
  const before=process.env.NODE_ENV,key=Symbol.for('prnext.development.server-actions');
  const previous=globalThis[key];delete globalThis[key];
  try{
    process.env.NODE_ENV='development';
    const first=await import('./action-client.mjs?'+randomUUID()),second=await import('./action-client.mjs?'+randomUUID());
    first.configureServerActions({createServerReference:(id,call)=>(...args)=>call(id,args),callServer:async(id,args)=>['first',id,args]});
    const action=second.createServerReference('action-id');assert.deepEqual(await action('value'),['first','action-id',['value']]);
    second.configureServerActions({createServerReference:(id,call)=>(...args)=>call(id,args),callServer:async()=>['updated']});
    assert.deepEqual(await action(),['updated']);
    process.env.NODE_ENV='production';
    const production=await import('./action-client.mjs?'+randomUUID()),other=await import('./action-client.mjs?'+randomUUID());
    production.configureServerActions({createServerReference:id=>id,callServer:async()=>1});assert.equal(production.createServerReference('id'),'id');
    assert.throws(()=>other.createServerReference('id'),/load after/);
  }finally{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;if(previous===undefined)delete globalThis[key];else globalThis[key]=previous;}
});
