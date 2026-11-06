import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {escapeHtml} from './http.mjs';

export const NATIVE_PPR_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const NATIVE_PPR_PREFIX_BYTES = 128 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Only immutable build JSON is retained, after the caller verified the current
// file bytes. No live model, decoder, request context or continuation is cached.
export class NativePprArtifactCache {
  constructor({maxEntries=8,maxBytes=4*1024*1024,maxEntryBytes=1024*1024,maxNodes=8192}={}) {
    for(const value of [maxEntries,maxBytes,maxEntryBytes,maxNodes])if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Invalid native PPR parsing cache budget');
    this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.maxEntryBytes=maxEntryBytes;this.maxNodes=maxNodes;
    this.entries=new Map();this.bytes=0;this.hits=0;this.parses=0;
  }
  parse(filename,bytes,route,descriptor) {
    const key=JSON.stringify([filename,descriptor.artifactHash,route.client||null]);
    let entry=this.entries.get(key);
    if(entry){this.hits++;this.entries.delete(key);this.entries.set(key,entry);}
    else{
      this.parses++;
      const artifact=JSON.parse(bytes);
      const prefix=Buffer.from(partialShell(artifact,route).replace(/<\/body><\/html>$/i,''));
      entry={artifact,prefixHash:sha256(prefix),identity:sha256(artifact.flight)};
      if(artifact.version!==1||!artifact.postponed||artifact.complete||artifact.generic||entry.prefixHash!==descriptor.prefixHash||entry.identity!==descriptor.identity)throw new Error('Invalid native PPR snapshot');
      // Reserve substantial expansion for JSON slots/strings before walking.
      // This is a conservative admission estimate, not an exact V8 heap size.
      let size=bytes.length*16+key.length*2+256;
      if(this.maxEntries&&size<=Math.min(this.maxBytes,this.maxEntryBytes)){
        const pending=[artifact],objects=[];let nodes=1,eligible=this.maxNodes>0;
        while(eligible&&pending.length){
          const value=pending.pop();objects.push(value);size+=128;
          // JSON arrays are dense: reject wide arrays before enumerating keys
          // or allocating any list of their primitive/object children.
          if(Array.isArray(value)&&value.length>this.maxNodes-nodes){eligible=false;break;}
          for(const name in value){
            if(!Object.hasOwn(value,name))continue;
            if(++nodes>this.maxNodes){eligible=false;break;}
            const child=value[name];size+=16+name.length*2+(typeof child==='string'?child.length*2:0);
            if(size>Math.min(this.maxBytes,this.maxEntryBytes)){eligible=false;break;}
            if(child&&typeof child==='object'){
              if(Array.isArray(child)&&child.length>this.maxNodes-nodes){eligible=false;break;}
              pending.push(child);
            }
          }
        }
        if(eligible&&!pending.length&&size<=Math.min(this.maxBytes,this.maxEntryBytes)){
          for(const value of objects)Object.freeze(value);
          while(this.entries.size&&(this.entries.size>=this.maxEntries||this.bytes+size>this.maxBytes)){
            const [oldKey,old]=this.entries.entries().next().value;this.entries.delete(oldKey);this.bytes-=old.size;
          }
          entry.size=size;this.entries.set(key,entry);this.bytes+=size;
        }
      }
    }
    // Descriptor bindings remain authoritative even when the public JSON hit.
    if(entry.prefixHash!==descriptor.prefixHash||entry.identity!==descriptor.identity)throw new Error('Invalid native PPR snapshot');
    return entry.artifact;
  }
}
const parsedArtifacts=new NativePprArtifactCache();

export function partialShell(artifact, route) {
  const bootstrap = '<script>self.__PRNEXT_FLIGHT_STREAM__=self.__PRNEXT_FLIGHT_STREAM__||[];</script>' +
    (route.client ? `<script type="module" async src="${escapeHtml(route.client)}"></script>` : '');
  const end = artifact.shell.lastIndexOf('</body>');
  if (end < 0 || !/<\/body><\/html>$/i.test(artifact.shell)) throw new Error('Invalid partial prerender document');
  return artifact.shell.slice(0, end) + bootstrap + artifact.shell.slice(end);
}

// This is a private transport field, never an HTTP header. Rust has already
// checked cache generation and committed these exact build bytes. Pinning the
// same artifact gives the request one snapshot even if invalidation races Node.
export async function nativePprArtifact({renderMode, manifest, route, url, distDir},cache=parsedArtifacts) {
  if (!renderMode?.startsWith('native-ppr:')) return null;
  if (!manifest.config?.nativePprShell || manifest.dev || !/^[a-f\d]{64}$/.test(renderMode.slice(11))) throw new Error('Invalid native PPR continuation');
  const pathname = new URL(url).pathname;
  const descriptor = manifest.config.nativePprArtifacts?.find(item => item.routeId === route.id && item.path === pathname && item.artifactHash === renderMode.slice(11));
  if (!descriptor || new URL(url).search || descriptor.artifact !== route.ppr?.[pathname]) throw new Error('Native PPR artifact does not match the route');
  const filename = path.resolve(distDir, descriptor.artifact);
  if (!descriptor.artifact.startsWith('static/') || !filename.startsWith(path.resolve(distDir) + path.sep) || (await stat(filename)).size > NATIVE_PPR_ARTIFACT_BYTES) throw new Error('Invalid native PPR artifact path or size');
  const bytes = await readFile(filename);
  if (bytes.length > NATIVE_PPR_ARTIFACT_BYTES || sha256(bytes) !== descriptor.artifactHash) throw new Error('Native PPR artifact changed after publication');
  const artifact = cache.parse(filename,bytes,route,descriptor);
  return {artifact, descriptor};
}
