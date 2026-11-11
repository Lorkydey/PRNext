import test from 'node:test';
import assert from 'node:assert/strict';
import {clientChunk,readClientChunk} from '../compat/client-chunk.cjs';
import {flightBundler} from './worker-metadata.mjs';
import {installFlightModuleLoader} from './app-client.mjs';

test('self-describing Flight chunks preserve public module identity with no global import table',async t=>{
  const names=['__webpack_require__','__webpack_chunk_load__','__webpack_get_script_filename__'];
  const saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  t.after(()=>names.forEach((name,index)=>saved[index]?Object.defineProperty(globalThis,name,saved[index]):delete globalThis[name]));
  const modules={client:{browserModule:'/docs/assets/client-HASH.js',ssrModule:'client.mjs'}};
  const token=flightBundler(modules,true,true).client.chunks[0],imports=[];
  const namespace={default:()=>null};
  installFlightModuleLoader({}, {assetBase:'/docs/assets',documentUrl:'https://app.test/docs/',importModule:async source=>{imports.push(source);return namespace;}});
  await Promise.all([globalThis.__webpack_chunk_load__(token),globalThis.__webpack_chunk_load__(token)]);
  assert.deepEqual(imports,['https://app.test/docs/assets/client-HASH.js']);
  assert.equal(globalThis.__webpack_require__('client'),namespace);
  assert.equal(globalThis.__webpack_require__.u('client'),imports[0]);
  await assert.rejects(globalThis.__webpack_chunk_load__(clientChunk('client','/docs/assets/client-OTHER.js')),/Conflicting/);
  assert.deepEqual(flightBundler(modules,false,true).client.chunks,[]);
});

test('client references accept configured CDN entries and reject executable URLs outside their build namespace',()=>{
  const decode=url=>readClientChunk(clientChunk('client',url),'https://cdn.test/build/assets','https://app.test/');
  assert.equal(decode('https://cdn.test/build/assets/client-HASH.js').id,'client');
  for(const url of ['https://evil.test/build/assets/client-HASH.js','https://cdn.test/build/assets/../client-HASH.js','https://cdn.test/build/assets/user/client-HASH.js','https://cdn.test/build/assets/other-HASH.js','https://cdn.test/build/assets/client-HASH.js?x=1','https://cdn.test/build/assets/client-HASH.js#x','javascript:alert(1)','data:text/javascript,alert(1)','https://user@cdn.test/build/assets/client-HASH.js'])assert.throws(()=>decode(url));
  assert.throws(()=>clientChunk('__proto__:x','/client-HASH.js'));
  assert.equal(readClientChunk('legacy-id'),null);
});
