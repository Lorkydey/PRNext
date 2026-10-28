'use strict';
const {createHash,randomBytes}=require('node:crypto');
const MAX_VALUE=2*1024*1024,MAX_META=65536;
const hash=value=>createHash('sha256').update(value).digest('hex');
const ACQUIRE=`
if not redis.call('HGET',KEYS[2],'_incarnation') then redis.call('HSET',KEYS[2],'_incarnation',ARGV[3],'_epoch',ARGV[3]) end
redis.call('PEXPIRE',KEYS[2],ARGV[4])
local epoch=redis.call('HGET',KEYS[2],'_epoch');local incarnation=redis.call('HGET',KEYS[2],'_incarnation')
if redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[2]) then return {1,epoch,incarnation} end
return {0}`;
const RELEASE=`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;
const READ=`
local fields=redis.call('HMGET',KEYS[1],'meta','value')
if not fields[1] or not fields[2] or string.len(fields[1])>65536 or string.len(fields[2])>tonumber(ARGV[2]) then return nil end
local meta=cjson.decode(fields[1]); local extra=cjson.decode(ARGV[1]); local stale=0
if redis.call('HGET',KEYS[2],'_incarnation')~=meta.incarnation then return nil end
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local seen={}
for _,id in ipairs(meta.tagIds) do seen[id]=true end
for _,id in ipairs(extra) do seen[id]=true end
for id,_ in pairs(seen) do
 local value=redis.call('HGET',KEYS[2],id)
 if value then
  local tag=cjson.decode(value)
  if tag.generation~=(meta.versions[id] or '0') then
   if tag.deadline>=0 and tag.deadline<=now then return nil end
   stale=1
  end
 end
end
return {fields[1],fields[2],math.max(0,now-meta.storedAt),stale}`;
const WRITE=`
if redis.call('GET',KEYS[3])~=ARGV[1] or redis.call('HGET',KEYS[2],'_epoch')~=ARGV[2] then return 0 end
local meta=cjson.decode(ARGV[3]); meta.versions={};meta.incarnation=ARGV[5];meta.writer=ARGV[1]
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
meta.storedAt=now-tonumber(ARGV[6])
for _,id in ipairs(meta.tagIds) do
 local value=redis.call('HGET',KEYS[2],id)
 meta.versions[id]=value and cjson.decode(value).generation or '0'
end
local encoded=cjson.encode(meta)
if string.len(encoded)>65536 then return 0 end
redis.call('HSET',KEYS[1],'meta',encoded,'value',ARGV[4])
redis.call('PEXPIRE',KEYS[1],ARGV[7]);redis.call('PEXPIRE',KEYS[2],ARGV[8]);return 1`;
const INVALIDATE=`
local generation=ARGV[3];local ids=cjson.decode(ARGV[4]);local added=0
for _,id in ipairs(ids) do if redis.call('HEXISTS',KEYS[1],id)==0 then added=added+1 end end
if redis.call('HLEN',KEYS[1])+added>4098 then redis.call('DEL',KEYS[1]) end
if not redis.call('HGET',KEYS[1],'_incarnation') then redis.call('HSET',KEYS[1],'_incarnation',generation) end
redis.call('HSET',KEYS[1],'_epoch',generation)
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local expiry=tonumber(ARGV[1]);local deadline=expiry<0 and -1 or now+expiry
for _,id in ipairs(ids) do redis.call('HSET',KEYS[1],id,cjson.encode({generation=generation,deadline=deadline})) end
redis.call('PEXPIRE',KEYS[1],ARGV[2])
return 1`;
const REMOVE=`local meta=redis.call('HGET',KEYS[1],'meta');if meta and cjson.decode(meta).writer==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;

function tags(values=[]){
  if(!Array.isArray(values)||values.length>256||values.some(value=>typeof value!=='string'||!value||Buffer.byteLength(value)>8192))throw new TypeError('Redis cache tags must be bounded nonempty strings.');
  return [...new Set(values)];
}
function positive(value,fallback,min,max,name){value??=fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError(`Redis cache ${name} must be between ${min} and ${max}.`);return value;}
function pause(ms,signal){return new Promise((resolve,reject)=>{const done=error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};const abort=()=>done(signal.reason);const timer=setTimeout(done,ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});}
function boundedRead(reader,ms){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Redis cache value read timed out.')),ms);reader.read().then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}

/** First-party Cache Components handler; Redis is loaded only when configured. */
function createRedisCache(options={},maxValueBytes=MAX_VALUE){
  if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Redis cache options must be an object.');
  const known=new Set(['namespace','urlEnv','client','leaseMs','waitMs','commandTimeoutMs','maxAgeSeconds']);
  for(const key of Object.keys(options))if(!known.has(key))throw new TypeError(`Unknown Redis cache option: ${key}`);
  if(options.client!==undefined&&typeof options.client?.withTypeMapping!=='function')throw new TypeError('Redis cache client must be a node-redis client.');
  if(typeof options.namespace!=='string'||!options.namespace||Buffer.byteLength(options.namespace)>256)throw new TypeError('Redis cache requires an application-specific namespace.');
  const urlEnv=options.urlEnv??'REDIS_URL';if(typeof urlEnv!=='string'||!/^[_A-Za-z][_A-Za-z0-9]*$/.test(urlEnv))throw new TypeError('Redis cache urlEnv must name an environment variable.');
  const leaseMs=positive(options.leaseMs,30000,1000,120000,'leaseMs'),waitMs=positive(options.waitMs,2500,100,3500,'waitMs');
  const commandTimeoutMs=positive(options.commandTimeoutMs,1000,100,2000,'commandTimeoutMs'),maxAgeSeconds=positive(options.maxAgeSeconds,604800,1,2592000,'maxAgeSeconds');
  if(waitMs+2*commandTimeoutMs>4500)throw new TypeError('Redis cache waitMs plus twice commandTimeoutMs must not exceed 4500 ms.');
  const prefix='prnext:v1:{'+hash(options.namespace)+'}:',epochKey=prefix+'tags',retention=String(maxAgeSeconds*1000+leaseMs+60000);
  let owned,connecting,closed=false;
  async function client(){
    if(closed)throw new Error('Redis cache is closed.');
    if(options.client){
      if(options.client.isReady===false)throw new Error('Redis cache client is not connected.');
      return options.client;
    }
    if(owned?.isReady)return owned;
    if(!connecting){
      connecting=(async()=>{
        const url=process.env[urlEnv];
        if(!url||!/^rediss?:\/\//.test(url))throw new Error(`Set ${urlEnv} to a Redis connection URL.`);
        // Use node-redis's base client; Redis Stack command packages are not
        // needed by this provider's bounded EVAL/HASH protocol.
        const {createClient}=require('@redis/client');
        owned?.destroy();owned=createClient({url,disableOfflineQueue:true,commandsQueueMaxLength:128,socket:{connectTimeout:commandTimeoutMs,reconnectStrategy:false}});
        owned.on('error',()=>{});await owned.connect();return owned;
      })().finally(()=>{connecting=undefined;});
    }
    return connecting;
  }
  async function command(args,signal){
    const connection=await client();
    // '$' (36) is RESP's binary-safe bulk-string type, as exposed by node-redis.
    const binary=connection.withTypeMapping({36:Buffer});
    const deadline=AbortSignal.timeout(commandTimeoutMs);
    return binary.sendCommand(args,{abortSignal:signal?AbortSignal.any([signal,deadline]):deadline});
  }
  const keys=key=>{if(typeof key!=='string'||!key||Buffer.byteLength(key)>8192)throw new TypeError('Invalid Redis cache key.');const id=hash(key);return {entry:prefix+'entry:'+id,lock:prefix+'lease:'+id};};
  async function acquire(key,{signal}={}){
    const {lock}=keys(key),token=randomBytes(24).toString('hex'),until=performance.now()+waitMs;
    for(;;){
      signal?.throwIfAborted();
      const started=performance.now();
      const result=await command(['EVAL',ACQUIRE,'2',lock,epochKey,token,String(leaseMs),randomBytes(24).toString('hex'),retention],signal);
      if(Number(result[0])===1){let released=false;return {token,started,epoch:String(result[1]),incarnation:String(result[2]),async release(){if(released)return;released=true;await command(['EVAL',RELEASE,'1',lock,token]);}};}
      if(performance.now()>=until)throw Object.assign(new Error('Redis cache fill wait exceeded its budget.'),{code:'PRNEXT_REDIS_BUSY'});
      await pause(Math.min(50,Math.max(1,until-performance.now())),signal);
    }
  }
  async function get(key,softTags=[]){
    const result=await command(['EVAL',READ,'2',keys(key).entry,epochKey,JSON.stringify(tags(softTags).map(hash)),String(maxValueBytes)]);
    if(!result)return undefined;
    const meta=JSON.parse(result[0].toString('utf8')),bytes=result[1];
    if(meta.version!==1||!Buffer.isBuffer(bytes)||bytes.length>maxValueBytes)throw new Error('Invalid Redis cache entry.');
    const age=Number(result[2]);if(!Number.isFinite(age)||age<0)throw new Error('Invalid Redis cache age.');
    let offset=0;
    return {tags:meta.tags,stale:meta.stale,revalidate:Number(result[3])?0:meta.revalidate,expire:meta.expire,timestamp:Math.max(0,Date.now()-age),
      value:new ReadableStream({pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(bytes.length,offset+65536);controller.enqueue(new Uint8Array(bytes.subarray(offset,end)));offset=end;}},{highWaterMark:0})};
  }
  async function set(key,pending,{lease,softTags=[]}={}){
    if(!lease||!Number.isFinite(lease.started)){
      // Observe and release a caller's value even when its lease is missing.
      // An unfenced producer must never publish after an invalidation.
      void Promise.resolve(pending).then(entry=>entry.value.cancel()).catch(()=>{});
      throw new Error('Redis cache writes require the lease returned by acquire().');
    }
    const entry=await pending,entryTags=tags(entry.tags);
    for(const field of ['timestamp','stale','revalidate','expire'])if(!Number.isFinite(entry[field])||entry[field]<0)throw new TypeError('Invalid Redis cache '+field);
    const reader=entry.value.getReader(),chunks=[];let size=0,complete=false;
    const until=performance.now()+commandTimeoutMs;
    let reads=0;
    try{for(;;){if(performance.now()>=until||++reads>10000)throw new Error('Redis cache value read timed out.');const part=await boundedRead(reader,Math.max(1,until-performance.now()));if(part.done){complete=true;break;}if(!(part.value instanceof Uint8Array)||(size+=part.value.byteLength)>maxValueBytes)throw new Error(`Redis cache value exceeds ${maxValueBytes/1024/1024} MiB.`);chunks.push(Buffer.from(part.value));}}
    finally{if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();}
    const meta={version:1,tags:entryTags,tagIds:tags([...entryTags,...softTags]).map(hash),stale:entry.stale,revalidate:entry.revalidate,expire:entry.expire};
    const metadata=JSON.stringify(meta);if(Buffer.byteLength(metadata)>MAX_META)throw new Error('Redis cache metadata exceeds 64 KiB.');
    const ttl=Math.ceil(Math.min(maxAgeSeconds,entry.expire)*1000);if(ttl<=0)return;
    const {entry:entryKey,lock}=keys(key);
    return Number(await command(['EVAL',WRITE,'3',entryKey,epochKey,lock,lease.token,lease.epoch,metadata,Buffer.concat(chunks,size),lease.incarnation,String(Math.max(0,performance.now()-lease.started)),String(ttl),retention]))===1;
  }
  async function updateTags(values,durations){
    const list=tags(values);if(!list.length)return;
    const expire=durations?.expire;if(expire!==undefined&&(!Number.isFinite(expire)||expire<0))throw new TypeError('Invalid Redis tag expiration.');
    await command(['EVAL',INVALIDATE,'1',epochKey,String(expire===undefined?-1:Math.ceil(expire*1000)),retention,randomBytes(24).toString('hex'),JSON.stringify(list.map(hash))]);
  }
  return {get,set,acquire,updateTags,
    async release(key,lease){if(lease?.token)await command(['EVAL',RELEASE,'1',keys(key).lock,lease.token]);},
    async remove(key,lease){if(lease?.token)await command(['EVAL',REMOVE,'1',keys(key).entry,lease.token]);},
    async refreshTags(){},async getExpiration(){return Infinity;},async close(){closed=true;await connecting?.catch(()=>{});if(owned?.isOpen)owned.destroy();}};
}

/** Legacy incremental handler for HTML/ISR, fetch and unstable_cache. */
function createRedisIncrementalCache(options){
  const {serialize,deserialize}=require('node:v8');
  const backend=createRedisCache({leaseMs:60000,...options},16*1024*1024);
  const keyFor=key=>'incremental:v8-'+process.versions.v8.split('.')[0]+':'+key;
  function leaseFor(lease){
    if(!lease||!['token','epoch','incarnation'].every(field=>typeof lease[field]==='string'&&/^[a-f0-9]{48}$/.test(lease[field]))||!Number.isFinite(lease.startedAt))throw new Error('Incremental Redis writes require a valid generation lease.');
    return {...lease,started:performance.now()-Math.max(0,Date.now()-lease.startedAt)};
  }
  return class RedisIncrementalCache {
    get prnextLeaseVersion(){return 1;}
    async acquire(key,{signal}={}){
      const lease=await backend.acquire(keyFor(key),{signal});
      return {token:lease.token,epoch:lease.epoch,incarnation:lease.incarnation,startedAt:Date.now()};
    }
    async release(key,lease){await backend.release(keyFor(key),lease);}
    async get(key,context={}){
      const entry=await backend.get(keyFor(key),tags([...new Set([...(context.tags||[]),...(context.softTags||[])])]));
      if(!entry)return null;
      const bytes=Buffer.from(await new Response(entry.value).arrayBuffer());
      const payload=deserialize(bytes);
      if(payload?.version!==1||!Number.isFinite(payload.lastModified)||!payload.value||typeof payload.value.kind!=='string')throw new Error('Invalid incremental Redis payload.');
      return {value:payload.value,lastModified:payload.lastModified,isStale:entry.revalidate===0};
    }
    async set(key,value,context={}){
      const lease=leaseFor(context.prnextLease);
      if(value===null){await backend.remove(keyFor(key),lease);return true;}
      const raw=context.cacheControl?.revalidate??value.revalidate??value._prnext?.revalidate??false;
      if(raw!==false&&(!Number.isFinite(raw)||raw<0))throw new TypeError('Invalid incremental Redis revalidate value.');
      if(raw===0)return true;
      const revalidate=raw===false?31536000:raw;
      const entryTags=tags([...new Set([...(context.tags||[]),...(context.softTags||[])])]);
      const bytes=serialize({version:1,lastModified:Date.now(),value});
      if(bytes.length>16*1024*1024)throw new Error('Incremental Redis entry exceeds 16 MiB.');
      return backend.set(keyFor(key),Promise.resolve({timestamp:Date.now(),stale:0,revalidate,expire:Math.max(revalidate,options?.maxAgeSeconds??604800),tags:entryTags,
        value:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})}),{lease});
    }
    async revalidateTag(values,durations){await backend.updateTags(Array.isArray(values)?values:[values],durations);}
    resetRequestCache(){}
    async close(){await backend.close();}
  };
}
module.exports={createRedisCache,createRedisIncrementalCache};
