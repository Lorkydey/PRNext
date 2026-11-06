import { renderToReadableStream, decodeReply, createTemporaryReferenceSet as serverReferences, registerClientReference } from 'react-server-dom-webpack/server.node';
import { encodeReply, createTemporaryReferenceSet as clientReferences, createFromReadableStream } from 'react-server-dom-webpack/client.edge';
import { actionManifest, registerCacheClientModule } from './action-server.mjs';
import { codecSymbol } from '../compat/use-cache.cjs';
import { encodeCacheArguments } from './cache-arguments.mjs';
import { flightBundler } from './worker-metadata.mjs';
import {primitiveCacheResult,flightCacheResult,isCacheResultPacket,readCacheResult,CACHE_RESULT_KEY_VERSION,CACHE_RESULT_LIMIT} from './cache-result.mjs';
const consumers = new WeakMap();
const emptyModules = Object.freeze({});

export function flightConsumer(context) {
  const clientModules = context.clientModules || emptyModules;
  let moduleMap = consumers.get(clientModules);
  if (!moduleMap) {
    moduleMap = Object.create(null);
    for (const id of Object.keys(clientModules)) {
      const cacheId = 'prnext-cache-client:' + id;
      const values = new Map();
      const namespace = new Proxy(Object.create(null), {
        get(_target, name) {
          if (typeof name !== 'string' || name === 'then') return;
          if (!values.has(name)) values.set(name, registerClientReference(function () { throw new Error('Cannot invoke a Client Component inside a cached Server Component'); }, id, name));
          return values.get(name);
        },
        getOwnPropertyDescriptor(_target, name) { if (typeof name === 'string' && name !== 'then') return { configurable: true, enumerable: true }; },
      });
      registerCacheClientModule(cacheId, namespace);
      moduleMap[id] = { '*': { id: cacheId, chunks: [], name: '*' } };
    }
    consumers.set(clientModules, moduleMap);
  }
  return { moduleMap, moduleLoading: null, serverModuleMap: actionManifest(context) };
}

globalThis[codecSymbol] = {
  cacheKeyVersion:CACHE_RESULT_KEY_VERSION,
  async arguments(values, context) {
    const temporaryReferences = clientReferences();
    const body = await encodeReply(values, { temporaryReferences, signal: context.signal });
    const key = await encodeCacheArguments(body);
    const serverTemporaryReferences = serverReferences();
    const decoded = await decodeReply(body, actionManifest(context), { temporaryReferences: serverTemporaryReferences, arraySizeLimit: 10000 });
    return { key, values: decoded, temporaryReferences, serverTemporaryReferences };
  },
  async render(callback, encoded, context) {
    context.signal?.throwIfAborted();
    const bundler = flightBundler(context.clientModules, false);
    let failure;
    // React calls then inside its rendering context, preserving React.cache isolation.
    // React can subscribe more than once while unwrapping a thenable. Start
    // lazily in its rendering context, but never execute the producer twice.
    let execution,checked=false,primitive;
    const result = { then(resolve, reject) { (execution ||= Promise.resolve().then(callback)).then(value=>{
      try{
        context.signal?.throwIfAborted();
        if(!checked){primitive=primitiveCacheResult(value);checked=true;}
        // The producer still runs inside the official renderer exactly once.
        // Do not return the original object through another Promise: that would
        // inspect a user-defined then getter again before React receives it.
        resolve(primitive?null:value);
      }catch(error){reject(error);}
    },reject); } };
    const stream = renderToReadableStream(result, bundler, { signal: context.signal, temporaryReferences: encoded.serverTemporaryReferences, onError(error) { failure ||= error; return 'PRNextCacheRenderError'; } });
    const chunks = [];
    let size = 0;
    for await (const value of stream) {
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error('Cached React result exceeds the 16 MiB rendering limit');
      // React exposes an official type:'bytes' Web stream: each delivered
      // Uint8Array owns its storage. Keep it until the sole packet aggregate;
      // copy Buffers/other representations defensively instead.
      chunks.push(value instanceof Uint8Array&&!Buffer.isBuffer(value)?value:Buffer.from(value));
    }
    if (failure) throw failure;
    context.signal?.throwIfAborted();
    // The packet always owns a final aggregate; no producer storage escapes.
    return primitive||flightCacheResult(chunks,size);
  },
  async decode(bytes, encoded, context) {
    if(isCacheResultPacket(bytes)){
      const result=readCacheResult(bytes);
      if(!result.flight)return result.value;
      bytes=result.flight;
    }else if(bytes.length>CACHE_RESULT_LIMIT)throw new Error('Invalid RSC cache result envelope');
    return createFromReadableStream(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), {
      serverConsumerManifest: flightConsumer(context), temporaryReferences: encoded.temporaryReferences, replayConsoleLogs: false,
    });
  },
};
