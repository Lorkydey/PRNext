// Keep inherited-stdio RPC frames below the native listener's 64 KiB limit.
const FRAME_BYTES=48*1024,MAX_FILES=100000,MAX_RECORDS=50000,MAX_EDGES=1000000,MAX_BYTES=16*1024*1024;
function batches(values){
  const result=[];let batch=[],bytes=2;
  for(const value of values){const size=Buffer.byteLength(JSON.stringify(value))+1;if(size>FRAME_BYTES)throw Error('Development graph entry exceeds the control frame budget');if(bytes+size>FRAME_BYTES){result.push(batch);batch=[];bytes=2;}batch.push(value);bytes+=size;}
  if(batch.length)result.push(batch);return result;
}
export function compactDependencyGraph(manifest){
  if(manifest.devDependencyStatus?.complete===false)throw Error(manifest.devDependencyStatus.reason||'Incomplete development graph');
  const files=[],ids=new Map(),records=[];let edges=0,bytes=0;
  const intern=file=>{if(typeof file!=='string'||!file||Buffer.byteLength(file)>8192)throw Error('Invalid development dependency');if(!ids.has(file)){bytes+=Buffer.byteLength(file);ids.set(file,files.length);files.push(file);}return ids.get(file);};
  for(const record of [...manifest.devDependencies||[],...manifest.devModules||[]]){
    const entries=[...new Set(record.files)].map(intern);edges+=entries.length;bytes+=Buffer.byteLength(record.route)+entries.length*4;
    // Split a single very broad route too; the native builder merges its parts.
    for(let offset=0;offset<Math.max(entries.length,1);offset+=4000)records.push({route:record.route,module:!!record.module,files:entries.slice(offset,offset+4000)});
    if(files.length>MAX_FILES||records.length>MAX_RECORDS||edges>MAX_EDGES||bytes>MAX_BYTES)throw Error('Development graph exceeds its bounded file, edge or memory budget');
  }
  return {files,records,edges};
}
export async function publishDependencyGraph(gateway,manifest){
  const graph=compactDependencyGraph(manifest),transaction=String(manifest.buildId);
  await gateway.request('graph-begin',{transaction,files:graph.files.length,records:graph.records.length,edges:graph.edges});
  try{
    for(const files of batches(graph.files))await gateway.request('graph-files',{transaction,files});
    for(const records of batches(graph.records))await gateway.request('graph-records',{transaction,records});
    return await gateway.request('graph-commit',{transaction});
  }catch(error){await gateway.request('graph-abort',{transaction}).catch(()=>{});throw error;}
}
export async function affectedDependencies(gateway,files){
  const routes=new Set(),modules=new Set(),unknown=new Set();let complete=true;
  for(const batch of batches(files).flatMap(batch=>{const chunks=[];for(let i=0;i<batch.length;i+=512)chunks.push(batch.slice(i,i+512));return chunks;})){
    const result=await gateway.request('affected',{files:batch,transitive:true});
    complete&&=result.complete!==false;
    for(const value of result.routes||[])routes.add(value);for(const value of result.modules||[])modules.add(value);for(const value of result.unknown||[])unknown.add(value);
  }
  // HMR compiler messages and frontend notifications also have finite budgets.
  if(Buffer.byteLength(JSON.stringify([...routes]))>32*1024||Buffer.byteLength(JSON.stringify([...modules]))>256*1024)complete=false;
  return {routes:complete?[...routes]:[],modules:complete?[...modules]:[],unknown:[...unknown],complete};
}
export const canSkipUnopenedRoutes=(result,files,dormant,indexValid)=>indexValid&&result.complete!==false&&files.length>0&&result.unknown.length===files.length&&result.unknown.every(file=>dormant.has(file));
