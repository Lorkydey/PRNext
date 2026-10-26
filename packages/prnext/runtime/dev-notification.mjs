// Leave space for the inherited control envelope below its 64 KiB limit.
export const MAX_DEV_NOTIFICATION_BYTES=60*1024;
const size=value=>Buffer.byteLength(JSON.stringify(value));

// Measure the JSON representation too: control characters and lone surrogates
// expand when escaped, independently of their UTF-8 source length.
function boundedString(value,limit){
  if(size(value)<=limit)return value;
  const suffix='…';
  const prefix=end=>{
    if(end>0&&end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1])&&/[\uDC00-\uDFFF]/.test(value[end]))end--;
    return value.slice(0,end);
  };
  let low=0,high=value.length;
  while(low<high){const middle=Math.ceil((low+high)/2);if(size(prefix(middle)+suffix)<=limit)low=middle;else high=middle-1;}
  return prefix(low)+suffix;
}
function boundedList(value,{count,itemBytes,totalBytes}){
  const result=[];let bytes=2;
  for(const entry of value.slice(0,count)){
    if(typeof entry!=='string')continue;
    const comma=result.length?1:0,remaining=totalBytes-bytes-comma;
    if(remaining<5)break;
    const text=boundedString(entry,Math.min(itemBytes,remaining));
    result.push(text);bytes+=size(text)+comma;
  }
  return result;
}
const serialized=value=>{try{return JSON.stringify(value);}catch{return undefined;}};

/** Keep the wire event and state file identical, bounded, and conservative. */
export function prepareDevNotification(value){
  let notification={...value};const truncated=new Set();
  for(const [key,limits]of Object.entries({changed:{count:32,itemBytes:512,totalBytes:16*1024},typeErrors:{count:32,itemBytes:4096,totalBytes:8*1024}})){
    if(notification[key]===undefined)continue;
    const original=notification[key],next=Array.isArray(original)?boundedList(original,limits):[];
    if(serialized(original)!==JSON.stringify(next))truncated.add(key);
    notification[key]=next;
  }
  if(notification.error!==undefined){
    const next=typeof notification.error==='string'?boundedString(notification.error,8*1024):'Development compilation failed.';
    if(next!==notification.error)truncated.add('error');notification.error=next;
  }
  if(truncated.has('changed')&&Object.hasOwn(notification,'affectedRoutes')){delete notification.affectedRoutes;truncated.add('affectedRoutes');}
  const stamp=()=>{
    if(truncated.size){notification.notificationTruncated=true;notification.truncatedFields=[...truncated];}
  };
  const trimSelection=()=>{
    for(const key of ['routes','compiler','transforms','affectedRoutes'])if(Object.hasOwn(notification,key)){delete notification[key];truncated.add(key);}
  };
  const fits=text=>typeof text==='string'&&Buffer.byteLength(text)<=MAX_DEV_NOTIFICATION_BYTES;
  stamp();let text=serialized(notification);
  if(fits(text))return {notification,text};

  // Removing affectedRoutes asks every active page to refresh. Never send a
  // shortened selection, which could silently leave an affected page stale.
  trimSelection();stamp();text=serialized(notification);
  if(fits(text))return {notification,text};

  // Unexpected metadata or large identities must not defeat the final bound.
  // Preserve complete usable IDs/URLs; an omitted client manifest causes the
  // browser's existing conservative reload path instead of fetching a bad URL.
  const previous=notification;notification={};truncated.add('metadata');
  for(const [key,limit]of Object.entries({state:128,buildId:512,session:512,clientManifest:8192,pagesManifest:8192})){
    if(typeof previous[key]==='string'&&size(previous[key])<=limit)notification[key]=previous[key];
    else if(previous[key]!==undefined)truncated.add(key);
  }
  for(const key of ['sequence','listenerPid'])if(Number.isSafeInteger(previous[key])&&previous[key]>=0)notification[key]=previous[key];
  for(const key of ['safeMode','cssOnly'])if(typeof previous[key]==='boolean')notification[key]=previous[key];
  for(const key of ['changed','typeErrors','error'])if(previous[key]!==undefined)notification[key]=previous[key];
  if(previous.reason&&typeof previous.reason==='object'){
    notification.reason={};
    for(const [key,limit]of Object.entries({code:256,summary:2048}))if(typeof previous.reason[key]==='string')notification.reason[key]=boundedString(previous.reason[key],limit);
    if(serialized(previous.reason)!==JSON.stringify(notification.reason))truncated.add('reason');
  }
  stamp();text=JSON.stringify(notification);
  // The allowlisted fields have a combined byte budget below 60 KiB. Keep this
  // assertion next to serialization so future additions cannot break the RPC.
  if(!fits(text))throw Error('Development notification exceeds its byte budget');
  return {notification,text};
}
