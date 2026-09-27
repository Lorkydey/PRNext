import { renderToReadableStream, decodeReply, createTemporaryReferenceSet as serverReferences, registerClientReference } from 'react-server-dom-webpack/server.node';
import { encodeReply, createTemporaryReferenceSet as clientReferences, createFromReadableStream } from 'react-server-dom-webpack/client.edge';
import { actionManifest, registerCacheClientModule } from './action-server.mjs';
import { codecSymbol } from '../compat/use-cache.cjs';
import { encodeCacheArguments } from './cache-arguments.mjs';
import { flightBundler } from './worker-metadata.mjs';
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
  async arguments(values, context) {
    const temporaryReferences = clientReferences();
    const body = await encodeReply(values, { temporaryReferences, signal: context.signal });
    const key = await encodeCacheArguments(body);
    const serverTemporaryReferences = serverReferences();
    const decoded = await decodeReply(body, actionManifest(context), { temporaryReferences: serverTemporaryReferences, arraySizeLimit: 10000 });
    return { key, values: decoded, temporaryReferences, serverTemporaryReferences };
  },
  async render(callback, encoded, context) {
    const bundler = flightBundler(context.clientModules, false);
    let failure;
    // React calls then inside its rendering context, preserving React.cache isolation.
    const result = { then(resolve, reject) { Promise.resolve().then(callback).then(resolve, reject); } };
    const stream = renderToReadableStream(result, bundler, { signal: context.signal, temporaryReferences: encoded.serverTemporaryReferences, onError(error) { failure ||= error; return 'PRNextCacheRenderError'; } });
    const chunks = [];
    let size = 0;
    for await (const value of stream) {
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error('Cached React result exceeds the 16 MiB rendering limit');
      chunks.push(Buffer.from(value));
    }
    if (failure) throw failure;
    return Buffer.concat(chunks, size);
  },
  async decode(bytes, encoded, context) {
    return createFromReadableStream(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), {
      serverConsumerManifest: flightConsumer(context), temporaryReferences: encoded.temporaryReferences, replayConsoleLogs: false,
    });
  },
};
