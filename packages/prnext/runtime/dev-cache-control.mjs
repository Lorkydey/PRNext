import {open,lstat,realpath,rename,rm,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const name='.dev-cache-rpc.json';
function endpoint(value){
  let url;try{url=new URL(value);}catch{throw Error('Development cache connection is unavailable');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/cache'||url.search||url.hash||url.username||url.password)throw Error('Invalid development cache endpoint');return url.href;
}
async function scopedDirectory(root,directory){
  root=await realpath(root);directory=path.resolve(root,directory);
  const relative=path.relative(path.join(root,'.prnext-dev'),directory);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||relative.split(path.sep).length!==2||await realpath(directory)!==directory)throw Error('Development cache must belong to a live project generation');
  return directory;
}
export function normalizeDevCachePath(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.length>1024||/[\\\u0000-\u001f]/.test(value))throw Error('A local cache pathname is required');
  return new URL(value,'http://local').pathname.replace(/%[\da-f]{2}/gi,escape=>{const character=String.fromCharCode(parseInt(escape.slice(1),16));return /[a-z\d_.~-]/i.test(character)?character:escape.toUpperCase();}).replace(/\/+$/,'')||'/';
}
/** Only a development worker may publish its native process's private RPC. */
export async function publishDevCacheCapability({root,distDir,manifest,env=process.env}){
  if(manifest.dev!==true||typeof manifest.devSession!=='string'||typeof manifest.buildId!=='string'||!env.PRNEXT_CACHE_URL||!env.PRNEXT_CACHE_TOKEN)return false;
  const directory=await scopedDirectory(root,distDir);
  if(!/^[a-f\d]{64}$/i.test(env.PRNEXT_CACHE_TOKEN))throw Error('Invalid development cache capability');
  const value={version:1,session:manifest.devSession,buildId:manifest.buildId,endpoint:endpoint(env.PRNEXT_CACHE_URL),token:env.PRNEXT_CACHE_TOKEN};
  const filename=path.join(directory,name),temporary=filename+'.'+randomUUID()+'.tmp';
  try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(value));}finally{await file.close();}await rename(temporary,filename);return true;}finally{await rm(temporary,{force:true});}
}
export async function invalidateDevRouteCache({root,directory,session,buildId,paths,signal,fetcher=fetch}){
  directory=await scopedDirectory(root,directory);
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.dev!==true||manifest.devSession!==session||manifest.buildId!==buildId)throw Error('Development cache generation changed; retry');
  if(manifest.config?.cacheHandler||Object.keys(manifest.config?.cacheHandlers||{}).length)return {invalidated:false,scope:'custom-handler',reason:'Custom cache handlers must be invalidated through their own API.',persistentTransformsPreserved:true,generationPreserved:true};
  const filename=path.join(directory,name),info=await lstat(filename).catch(()=>null);
  if(!info)return {invalidated:false,scope:'native-route-cache',reason:'No active runtime cache yet. Visit the route first.',persistentTransformsPreserved:true,generationPreserved:true};
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096||process.platform!=='win32'&&(info.mode&0o077))throw Error('Invalid private development cache connection');
  const file=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let capability;
  try{const stat=await file.stat();if(stat.ino!==info.ino||!stat.isFile()||stat.size>4096)throw Error('Development cache connection changed');capability=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
  if(capability.version!==1||capability.session!==session||capability.buildId!==buildId||!/^[a-f\d]{64}$/i.test(capability.token||''))throw Error('Development cache connection changed; retry');
  const associations=[...new Set(paths.map(value=>'page:'+normalizeDevCachePath(value)))];if(!associations.length||associations.length>2)throw Error('A targeted development route is required');
  const timeout=AbortSignal.timeout(5000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const response=await fetcher(endpoint(capability.endpoint),{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+capability.token},body:JSON.stringify({op:'invalidate',paths:associations,mode:'expire'}),signal:combined});
  if(!response.ok){await response.body?.cancel();throw Error('Development cache invalidation failed ('+response.status+')');}
  const body=await response.text();if(Buffer.byteLength(body)>16384)throw Error('Invalid development cache reply');JSON.parse(body);
  return {invalidated:true,scope:'native-route-cache',paths:associations.map(value=>value.slice(5)),persistentTransformsPreserved:true,generationPreserved:true,customHandlersInvalidated:false};
}
