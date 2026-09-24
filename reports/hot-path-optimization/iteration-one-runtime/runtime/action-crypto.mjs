import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { currentRequest } from '../compat/headers.cjs';

const LIMIT = 16 * 1024 * 1024;
function key() {
  const encoded = currentRequest().actionKey;
  if (typeof encoded !== 'string') throw new Error('Server Action encryption key is unavailable in this request');
  const value = Buffer.from(encoded, 'base64');
  if (![16,24,32].includes(value.length)) throw new Error('Invalid Server Action encryption key');
  return value;
}

// The graph envelope preserves cycles and rich capture values without confusing
// user object properties with transport tags. Functions and class instances are
// rejected instead of being silently reduced to incomplete plain objects.
async function encodeCaptures(value) {
  const nodes = [];
  const seen = new Map();
  async function encode(value) {
    if (typeof value === 'symbol') {
      const name = Symbol.keyFor(value);
      if (name === undefined) throw new Error('Server Action closures cannot capture a non-global Symbol');
      return { symbol: name };
    }
    const serverReference=typeof value === 'function' && value.$$typeof===Symbol.for('react.server.reference') && typeof value.$$id==='string';
    if (typeof value === 'function' && !serverReference) throw new Error('Server Action closures cannot capture functions; move helpers to module scope');
    if (value === null || (typeof value !== 'object' && !serverReference)) return { value };
    if (seen.has(value)) return { reference: seen.get(value) };
    const index = nodes.length;
    seen.set(value, index);
    const node = {};
    nodes.push(node);
    if (value instanceof Promise) {
      node.type='promise';
      let result;
      try { result=await value; } catch(error) { node.rejected=true;result=error; }
      node.result=await encode(result);
    }
    else if (serverReference) { node.type='action'; node.id=value.$$id; node.bound=await encode(await value.$$bound); }
    else if (Array.isArray(value)) { node.type='array'; node.items=await Promise.all(Array.from(value,encode)); }
    else if (value instanceof Map) { node.type='map'; node.items=await Promise.all([...value].map(async ([key,value])=>[await encode(key),await encode(value)])); }
    else if (value instanceof Set) { node.type='set'; node.items=await Promise.all([...value].map(encode)); }
    else if (typeof Blob !== 'undefined' && value instanceof Blob) {
      if(value.size>LIMIT) throw new Error('Server Action closure exceeds the 16 MiB limit');
      node.type='blob'; node.bytes=Buffer.from(await value.arrayBuffer()); node.mime=value.type;
      if (typeof File !== 'undefined' && value instanceof File) { node.name=value.name; node.lastModified=value.lastModified; }
    } else if (typeof FormData !== 'undefined' && value instanceof FormData) { node.type='form'; node.items=await Promise.all([...value].map(async ([key,value])=>[key,await encode(value)])); }
    else if (value instanceof Date || value instanceof Error || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) { node.type='value'; node.value=value; }
    else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Server Action closures can only capture plain objects and supported serializable values');
      node.type='object'; node.nullPrototype=prototype===null;
      node.items=await Promise.all(Object.keys(value).map(async name=>[name,await encode(value[name])]));
      if (Object.getOwnPropertySymbols(value).length) throw new Error('Server Action closures cannot capture objects with symbol keys');
    }
    return { reference: index };
  }
  return { root: await encode(value), nodes };
}

async function decodeCaptures(graph) {
  const actionTargets=[];
  const promises=[];
  const values = graph.nodes.map((node,index) => {
    if (node.type==='action') return function(...args){return actionTargets[index](...args);};
    if (node.type==='promise') {
      const promise=new Promise((resolve,reject)=>{promises[index]={resolve,reject};});
      promise.catch(()=>{});
      return promise;
    }
    if (node.type==='array') return [];
    if (node.type==='map') return new Map();
    if (node.type==='set') return new Set();
    if (node.type==='form') return new FormData();
    if (node.type==='blob') return node.name === undefined ? new Blob([node.bytes],{type:node.mime}) : new File([node.bytes],node.name,{type:node.mime,lastModified:node.lastModified});
    if (node.type==='value') return node.value;
    return node.nullPrototype ? Object.create(null) : {};
  });
  const decode = value => Object.hasOwn(value,'reference') ? values[value.reference] : Object.hasOwn(value,'symbol') ? Symbol.for(value.symbol) : value.value;
  for (let index=0;index<graph.nodes.length;index++) {
    const node=graph.nodes[index], value=values[index];
    if (node.type==='promise') promises[index][node.rejected?'reject':'resolve'](decode(node.result));
    if (node.type==='array') for (const item of node.items) value.push(decode(item));
    if (node.type==='map') for (const [key,item] of node.items) value.set(decode(key),decode(item));
    if (node.type==='set') for (const item of node.items) value.add(decode(item));
    if (node.type==='form') for (const [key,item] of node.items) value.append(key,decode(item));
    if (node.type==='object') for (const [key,item] of node.items) Object.defineProperty(value,key,{value:decode(item),enumerable:true,configurable:true,writable:true});
  }
  if(graph.nodes.some(node=>node.type==='action')) {
    const {loadActionReference}=await import('./action-reference.mjs');
    for(let index=0;index<graph.nodes.length;index++) {
      const node=graph.nodes[index];
      if(node.type!=='action') continue;
      const reference=await loadActionReference(node.id,decode(node.bound));
      actionTargets[index]=reference;
      for(const property of ['$$typeof','$$id','$$bound','$$location','bind']) {
        const descriptor=Object.getOwnPropertyDescriptor(reference,property);
        if(descriptor) Object.defineProperty(values[index],property,descriptor);
      }
    }
  }
  return decode(graph.root);
}

export async function encryptBoundArgs(id, captures) {
  const secret = key();
  const bytes = serialize(await encodeCaptures(captures));
  if (bytes.length > LIMIT) throw new Error('Server Action closure exceeds the 16 MiB limit');
  const nonce = randomBytes(12);
  const cipher = createCipheriv(`aes-${secret.length*8}-gcm`, secret, nonce);
  cipher.setAAD(Buffer.from('rustyx-server-action:' + id));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return 'v1.' + Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64url');
}

export async function decryptBoundArgs(id, encrypted) {
  const secret = key();
  encrypted = await encrypted;
  try {
    if (typeof encrypted !== 'string' || !encrypted.startsWith('v1.') || encrypted.length > Math.ceil((LIMIT+28)*4/3)+3 || !/^[A-Za-z0-9_-]+$/.test(encrypted.slice(3))) throw new Error();
    const bytes = Buffer.from(encrypted.slice(3),'base64url');
    if (bytes.length < 28) throw new Error();
    const decipher = createDecipheriv(`aes-${secret.length*8}-gcm`,secret,bytes.subarray(0,12));
    decipher.setAAD(Buffer.from('rustyx-server-action:' + id));
    decipher.setAuthTag(bytes.subarray(12,28));
    return await decodeCaptures(deserialize(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()])));
  } catch { throw new Error('Invalid encrypted Server Action closure'); }
}

export function bindEncryptedReference(reference, id, capture) {
  let bound;
  Object.defineProperty(reference,'$$bound',{configurable:true,get(){
    if (!bound) bound=[encryptBoundArgs(id,capture())];
    return bound;
  }});
  return reference;
}
