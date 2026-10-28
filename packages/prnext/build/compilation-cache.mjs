import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, readFile, opendir, realpath, readlink, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { version as esbuildVersion } from 'esbuild';
import { buildCacheIdentity, cacheHash, privateCacheDirectory, readCacheRecord, writeCacheRecord } from './persistent-cache.mjs';
import {mapConcurrent} from './concurrent.mjs';
import { readCompilationRecord, writeCompilationRecord } from './compilation-store.mjs';

// Graph outputs have a narrower contract than source transforms. In particular,
// application graph callbacks discover actions, boundaries and font assets. They
// must run on every generation and are never skipped by this cache.
const reports = new AsyncLocalStorage();
const MAX_FILES = 4096, MAX_DIRECTORIES = 8192, MAX_NAMES = 32768;
const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_BYTES = 48 * 1024 * 1024;
const RECORD_LIMIT = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const frameworkDirectory=name=>['.git','.prnext-cache','.prnext','.prnext-incremental-stage'].includes(name)||/^\.prnext-(?:build|backup|config|postcss)-/.test(name);
const frameworkPointer=name=>/^\.prnext-output(?:\.json|-.+\.tmp)$/.test(name);
const ignored = entry => entry.isDirectory() && (entry.name==='node_modules'||frameworkDirectory(entry.name)) || frameworkPointer(entry.name);
const safePath = file => typeof file === 'string' && file.length < 32768 && path.isAbsolute(file) && !file.includes('\0');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
export const withCompilationGraphCacheReporting = run => reports.run({ kinds: new Map(), identities:new Map(), listings:new Map(),listingNames:0 }, run);
export function compilationGraphCacheReport() {
  const kinds = [...(reports.getStore()?.kinds || [])].map(([kind, value]) => ({ kind, ...value, reasons: { ...value.reasons } }));
  return { version: 1, scope: 'eligible-production-compilation-graphs', kinds,
    hits: kinds.reduce((sum, item) => sum + item.hits, 0), misses: kinds.reduce((sum, item) => sum + item.misses, 0),
    bypasses: kinds.reduce((sum, item) => sum + item.bypasses, 0), reusedBytes: kinds.reduce((sum, item) => sum + item.reusedBytes, 0) };
}
function record(kind, outcome, reason, bytes = 0) {
  const state = reports.getStore(); if (!state) return;
  if (!state.kinds.has(kind)) state.kinds.set(kind, { hits: 0, misses: 0, bypasses: 0, writes: 0, reusedBytes: 0, reasons: {} });
  const item = state.kinds.get(kind); item[outcome]++; item.reusedBytes += bytes;
  if (reason) item.reasons[reason] = (item.reasons[reason] || 0) + 1;
}
function serializable(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(serializable);
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => item === undefined || serializable(item));
}
const directorySignature=info=>[info.dev,info.ino,info.mode,info.mtimeNs,info.ctimeNs].join(':');
async function directoryEntries(directory,budget){
  const state=reports.getStore(),before=await lstat(directory,{bigint:true});
  if(!before.isDirectory()||before.isSymbolicLink())throw Error('unstable-resolution');
  const signature=directorySignature(before),saved=state?.listings.get(directory);
  if(saved?.signature===signature){
    const after=await lstat(directory,{bigint:true});
    if(directorySignature(after)===signature){budget.names+=saved.entries.length;if(budget.names>MAX_NAMES)throw Error('resolution-limit');return {entries:saved.entries,info:after,stable:true};}
  }
  const entries=[];
  for await(const entry of await opendir(directory)){if(++budget.names>MAX_NAMES)throw Error('resolution-limit');entries.push(entry);}
  const after=await lstat(directory,{bigint:true}),stable=signature===directorySignature(after);
  if(state&&stable){
    if(state.listings.has(directory)){state.listingNames-=state.listings.get(directory).entries.length;state.listings.delete(directory);}
    while(state.listings.size&&(state.listings.size>=MAX_DIRECTORIES||state.listingNames+entries.length>MAX_NAMES)){
      const [oldest,value]=state.listings.entries().next().value;state.listings.delete(oldest);state.listingNames-=value.entries.length;
    }
    if(entries.length<=MAX_NAMES){state.listings.set(directory,{signature,entries});state.listingNames+=entries.length;}
  }
  return {entries,info:after,stable};
}
async function fileDigest(file, started = Infinity, budget = {bytes:0}) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES || before.mtimeMs > started || before.ctimeMs > started) throw Error('unstable-input');
  budget.bytes+=before.size;if(budget.bytes>MAX_BYTES)throw Error('dependency-limit');
  const bytes = await readFile(file), after = await lstat(file);
  if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('unstable-input');
  return cacheHash(bytes);
}
async function directoryDigest(directory, budget, started = Infinity, lookup = false, excluded = []) {
  let listing;
  try{listing=await directoryEntries(directory,budget);}catch(error){if(error.code==='ENOENT')return 'missing';throw error;}
  const {info}=listing;
  if(started!==Infinity&&(Number(info.mtimeNs)/1e6>started||Number(info.ctimeNs)/1e6>started))throw Error('unstable-resolution');
  const namesAt=async listing=>{
    const entries=listing.entries.filter(entry=>lookup?['package.json','tsconfig.json','jsconfig.json','.browserslistrc','browserslist','node_modules'].includes(entry.name):!ignored(entry)&&!excluded.includes(path.join(directory,entry.name)));
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    return mapConcurrent(entries,async entry=>[entry.name,entry.isDirectory()?'directory':entry.isSymbolicLink()?['link',await readlink(path.join(directory,entry.name))]:entry.isFile()?'file':'other']);
  };
  const names=await namesAt(listing),digest=cacheHash(JSON.stringify(names));
  if(!listing.stable&&cacheHash(JSON.stringify(await namesAt(await directoryEntries(directory,budget))))!==digest)throw Error('unstable-resolution');
  return digest;
}
async function snapshot(root, dependencies, { started = Infinity, imports = [], rejectTsconfig = false, styleTargets=false, baseline, excluded = [] } = {}) {
  if (!Array.isArray(dependencies) || dependencies.length > MAX_FILES || dependencies.some(file => !safePath(file))) throw Error('dependency-limit');
  const files = new Set(dependencies), directories = new Set(), trees = new Set([root]), fullDirectories = new Set();
  if(dependencies.some(file=>path.dirname(file).split(path.sep).some(frameworkDirectory)||frameworkPointer(path.basename(file))||excluded.some(directory=>inside(directory,file))))throw Error('generated-input');
  for(const name of ['package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','.env','.env.local','.env.production','.env.production.local','.env.development','.env.development.local','.env.test','.env.test.local']){
    const file=path.join(root,name);try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('unsafe-config');files.add(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const addParents = async file => {
    let directory = path.dirname(file);
    while (true) {
      directories.add(directory);
      // Node's package search includes missing nearer node_modules directories.
      directories.add(path.join(directory, 'node_modules'));
      for (const name of ['package.json', 'tsconfig.json', 'jsconfig.json', ...(styleTargets?['.browserslistrc','browserslist']:[])]) {
        const candidate = path.join(directory, name);
        try {
          const info = await lstat(candidate);
          if(name==='browserslist'&&info.isDirectory())continue;
          if (rejectTsconfig && /^(?:ts|js)config\.json$/.test(name)) throw Error('untracked-tsconfig');
          if (!info.isFile() || info.isSymbolicLink() || info.size>MAX_FILE_BYTES) throw Error('unsafe-config');
          if(styleTargets&&(name==='.browserslistrc'||name==='browserslist'||name==='package.json')){
            const source=await readFile(candidate,'utf8');
            const targets=name==='package.json'?JSON.stringify(JSON.parse(source).browserslist):source;
            if(typeof targets==='string'&&/\b(?:extends|stats)\b/i.test(targets))throw Error('custom-browser-targets');
          }
          files.add(candidate);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
  };
  for (const file of dependencies) {
    await addParents(file);
    // Package export/browser maps may choose an absent file anywhere inside the
    // package. Directory names, including absence, participate in invalidation.
    let directory = path.dirname(file);
    while (true) {
      try { if ((await lstat(path.join(directory, 'package.json'))).isFile()) { trees.add(directory); break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
  }
  for (const [importer, specifier] of imports) {
    if (typeof specifier !== 'string' || /^(?:node:|[./\\]|[A-Za-z]:)/.test(specifier)) continue;
    const parts = specifier.split('/'), name = parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    if (!name || name.includes('\0') || name.split('/').some(part => part === '..')) throw Error('unsafe-resolution');
    let directory = path.dirname(importer);
    while (true) {
      const candidate = path.join(directory, 'node_modules', name);
      try { const info = await lstat(candidate); if (info.isSymbolicLink()) throw Error('linked-package'); if (info.isDirectory()) trees.add(candidate); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
  }
  const walked={names:0};
  const walk = async (directory, depth = 0) => {
    if (depth > 32 || directories.size > MAX_DIRECTORIES) throw Error('resolution-limit');
    const listing=await directoryEntries(directory,walked);
    directories.add(directory); fullDirectories.add(directory);
    for (const entry of listing.entries) {
      if (ignored(entry) || excluded.includes(path.join(directory,entry.name))) continue;
      if (entry.isSymbolicLink()) throw Error('linked-input');
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), depth + 1);
    }
  };
  for (const tree of trees) await walk(tree);
  if (files.size > MAX_FILES || directories.size > MAX_DIRECTORIES) throw Error('dependency-limit');
  const budget = { names: 0,bytes:0 };
  const knownFiles = new Map(baseline?.files || []), knownDirectories = new Map((baseline?.directories || []).map(item => [item[0], item]));
  const result = { excluded, files: await mapConcurrent([...files].sort(),async file => [file, await fileDigest(file, knownFiles.has(file) ? Infinity : started,budget)]),
    directories: await mapConcurrent([...directories].sort(),async directory => {
      const lookup = !fullDirectories.has(directory) && path.basename(directory) !== 'node_modules';
      const known = knownDirectories.get(directory), comparable = known && known[2] === lookup;
      return [directory, await directoryDigest(directory, budget, comparable ? Infinity : started, lookup, excluded), lookup];
    }) };
  for (const [file,digest] of result.files) if (knownFiles.has(file) && knownFiles.get(file) !== digest) throw Error('unstable-input');
  for (const [directory,digest,lookup] of result.directories) {
    const known = knownDirectories.get(directory);
    if (known && known[2] === lookup && known[1] !== digest) throw Error('unstable-resolution');
  }
  return result;
}
async function validSnapshot(value) {
  const pairs = (list, missing) => Array.isArray(list) && list.length <= (missing ? MAX_DIRECTORIES : MAX_FILES)
    && new Set(list.map(item => item?.[0])).size === list.length
    && list.every(item => Array.isArray(item) && item.length === (missing ? 3 : 2) && safePath(item[0]) && (SHA.test(item[1]) || missing && item[1] === 'missing') && (!missing || typeof item[2] === 'boolean'));
  if (!value || !Array.isArray(value.excluded) || value.excluded.length>32 || !value.excluded.every(safePath) || !pairs(value.files, false) || !pairs(value.directories, true)) return false;
  const budget = { names: 0,bytes:0 };
  for (const [file, digest] of value.files) if (await fileDigest(file,Infinity,budget) !== digest) return false;
  for (const [directory, digest, lookup] of value.directories) if (await directoryDigest(directory, budget, Infinity, lookup, value.excluded) !== digest) return false;
  return true;
}
/** Framework-owned graph producers explicitly return dependencies and payloads. */
export async function cachedCompilation({ root, kind, settings, inputs = [], excluded = [], enabled = true, reason, validate, produce, bytes = () => 0, rejectTsconfig = false,styleTargets=false, binary = false }) {
  if (!enabled || process.env.PRNEXT_BUILD_CACHE === '0' || !serializable(settings)) {
    record(kind, 'bypasses', process.env.PRNEXT_BUILD_CACHE === '0' ? 'disabled' : reason || 'unsupported-configuration'); return (await produce()).value;
  }
  let directory, key;
  try {
    root = await realpath(root); directory = await privateCacheDirectory(root, binary ? 'compilation-graphs-v2' : 'compilation-graphs-v1');
    if(!directory)throw Error('unavailable');
    // Only metadata for the same current environment is shared. Individual
    // graph snapshots still re-hash source/config bytes and validate listings.
    const state=reports.getStore(),environment=cacheHash(JSON.stringify(Object.entries(process.env).sort())),identityKey=root+'\0'+environment;
    if(state&&!state.identities.has(identityKey)){
      if(state.identities.size>=8)state.identities.delete(state.identities.keys().next().value);
      state.identities.set(identityKey,buildCacheIdentity(root));
    }
    const identity = directory && await (state?.identities.get(identityKey)||buildCacheIdentity(root));
    if (!identity) throw Error('unavailable');
    if(excluded.length>32||!excluded.every(file=>safePath(file)&&inside(root,file)&&file!==root))throw Error('unsafe-output-directory');
    key = cacheHash(JSON.stringify([identity, esbuildVersion, kind, settings, excluded]));
    const cached = binary ? await readCompilationRecord(directory, key) : await readCacheRecord(directory, key, RECORD_LIMIT);
    if (cached?.format === 1 && validate(cached.value) && await validSnapshot(cached.snapshot)) {
      record(kind, 'hits', undefined, bytes(cached.value)); return cached.value;
    }
  } catch { /* Corrupt, excessive or unavailable caches are optional. */ }
  record(kind, 'misses');
  let baseline, baselineError;
  if(directory && key)try{baseline=await snapshot(root,inputs,{rejectTsconfig,excluded,styleTargets});}catch(error){baselineError=error;}
  const started = Date.now(), produced = await produce();
  if (directory && key && validate(produced.value)) try {
    if(!baseline)throw baselineError || Error('snapshot-unavailable');
    const current = await snapshot(root, produced.dependencies, { started, imports: produced.imports, rejectTsconfig,styleTargets, baseline, excluded });
    const saved = { format: 1, snapshot: current, value: produced.value };
    if (await (binary ? writeCompilationRecord(directory, key, saved) : writeCacheRecord(directory, key, saved, RECORD_LIMIT,{maxFiles:1024}))) record(kind, 'writes');
  } catch (error) { record(kind, 'bypasses', ['unstable-input', 'unstable-resolution', 'untracked-tsconfig', 'linked-package', 'linked-input', 'resolution-limit', 'dependency-limit','generated-input','custom-browser-targets'].includes(error.message) ? error.message : 'snapshot-unavailable'); }
  else if(!validate(produced.value))record(kind,'bypasses','generation-specific-output');
  return produced.value;
}

function validMetafile(value){
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value),text=value=>typeof value==='string'&&value.length<32768&&!value.includes('\0');
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  const imports=value=>Array.isArray(value)&&value.length<=MAX_FILES&&value.every(item=>object(item)&&text(item.path)&&text(item.kind)&&(item.external===undefined||typeof item.external==='boolean'));
  return object(value)&&object(value.inputs)&&object(value.outputs)&&Object.keys(value.inputs).length<=MAX_FILES&&Object.keys(value.outputs).length<=MAX_FILES
    &&Object.entries(value.inputs).every(([file,input])=>text(file)&&object(input)&&count(input.bytes)&&imports(input.imports))
    &&Object.entries(value.outputs).every(([file,output])=>text(file)&&object(output)&&count(output.bytes)&&imports(output.imports)
      &&(output.entryPoint===undefined||text(output.entryPoint))&&(output.cssBundle===undefined||text(output.cssBundle))
      &&Array.isArray(output.exports)&&output.exports.length<=MAX_FILES&&output.exports.every(text)&&object(output.inputs)
      &&Object.keys(output.inputs).length<=MAX_FILES&&Object.entries(output.inputs).every(([file,input])=>text(file)&&object(input)&&count(input.bytesInOutput)));
}
function validGraph(value) {
  return value && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= MAX_FILES
    && value.files.every(file => Array.isArray(file) && file.length === 3 && typeof file[0] === 'string' && !path.isAbsolute(file[0])
      && !/[\0<>:"|?*]/.test(file[0]) && file[0].split(/[\\/]/).every(part => part && part !== '.' && part !== '..') && file[1] instanceof Uint8Array && file[1].byteLength <= MAX_FILE_BYTES && typeof file[2] === 'string')
    && new Set(value.files.map(file => file[0])).size === value.files.length
    && value.files.reduce((sum, file) => sum + file[1].byteLength, 0) <= MAX_BYTES
    && validMetafile(value.metafile);
}
const deepMap = (value, convert) => typeof value === 'string' ? convert(value) : Array.isArray(value) ? value.map(item => deepMap(item, convert))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [convert(key), deepMap(item, convert)])) : value;
/** Cache native esbuild graphs only; plugins and generated entries need replay. */
export async function cachedGraphBuild(options, { root, stage, dev = false, config = {} }, compile) {
  const output = options.outdir || options.outfile && path.dirname(options.outfile);
  const permitted = !dev && !(options.plugins?.length) && options.bundle === true && output && stage && inside(stage, path.resolve(output))
    && !options.stdin && !options.tsconfig && !options.tsconfigRaw && options.mangleCache===undefined && !config.webpack && !Object.keys(config.turbopack?.rules || {}).length;
  if (!permitted) { record('javascript', 'bypasses', dev ? 'development' : options.plugins?.length ? 'graph-side-effects' : 'unsupported-configuration'); return compile(options); }
  const token = '__PRNEXT_COMPILATION_STAGE__', toSaved = value => value.replaceAll(stage,()=>token).replaceAll(path.basename(stage),()=>token), fromSaved = value => value.replaceAll(token,()=>stage);
  const rawSignature = { ...options, plugins: undefined, write: false, metafile: true };
  if(!serializable(rawSignature)){record('javascript','bypasses','unsupported-configuration');return compile(options);}
  const signature = deepMap(rawSignature, toSaved);
  if (!serializable(signature)) { record('javascript', 'bypasses', 'unsupported-configuration'); return compile(options); }
  let fresh;
  const entries = Array.isArray(options.entryPoints) ? options.entryPoints.map(entry=>typeof entry==='string'?entry:entry.in) : Object.values(options.entryPoints || {});
  const excluded = [path.resolve(root,config.distDir || '.prnext'),...(config.output==='export'?[path.join(root,'out')]:[])];
  const saved = await cachedCompilation({ root, kind: 'javascript', settings: signature, inputs:entries.map(file=>path.resolve(options.absWorkingDir || process.cwd(),file)), excluded, validate: validGraph, rejectTsconfig: true, binary: true,
    bytes: value => value.files.reduce((sum, file) => sum + file[1].byteLength, 0),
    produce: async () => {
      fresh = await compile({ ...options, write: false, metafile: true });
      // Warnings may carry plugin details/locations; do not replay approximate diagnostics.
      if (fresh.warnings?.length) return { value: null, dependencies: [] };
      if(JSON.stringify(fresh.metafile).includes(token))return {value:null,dependencies:[]};
      const dependencies = Object.keys(fresh.metafile.inputs).map(file => path.resolve(options.absWorkingDir || process.cwd(), file));
      if (dependencies.some(file => inside(stage, file))) return { value: null, dependencies: [] };
      const files = fresh.outputFiles.map(file => [path.relative(output, file.path), file.contents, file.hash]);
      if (fresh.outputFiles.some(file => Buffer.from(file.contents).includes(Buffer.from(stage)) || Buffer.from(file.contents).includes(Buffer.from(path.basename(stage))))) return { value: null, dependencies: [] };
      const imports = Object.entries(fresh.metafile.inputs).flatMap(([file, input]) => input.imports.filter(item => item.external).map(item => [path.resolve(options.absWorkingDir || process.cwd(), file), item.path]));
      return { value: { files, metafile: deepMap(fresh.metafile, toSaved) }, dependencies, imports };
    } });
  const outputFiles = saved ? saved.files.map(([name, data, hash]) => ({ path: path.join(output, name), contents: Buffer.from(data.buffer, data.byteOffset, data.byteLength), hash, get text() { return this.contents.toString(); } })) : fresh.outputFiles;
  if (options.write !== false) for (const file of outputFiles) { await mkdir(path.dirname(file.path), { recursive: true }); await writeFile(file.path, file.contents); }
  return { ...(fresh || { errors: [], warnings: [] }), ...(options.metafile ? { metafile: saved ? deepMap(saved.metafile, fromSaved) : fresh.metafile } : { metafile: undefined }),
    outputFiles: options.write === false ? outputFiles : undefined };
}

export const compilationCacheLimits = Object.freeze({ files: MAX_FILES, directories: MAX_DIRECTORIES, names: MAX_NAMES, fileBytes: MAX_FILE_BYTES, bytes: MAX_BYTES });
