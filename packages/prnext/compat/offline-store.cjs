'use strict';
const waiting=new Set(),listeners=new Set();
const changed=()=>{for(const listener of listeners)listener();};
const snapshot=()=>waiting.size>0||globalThis.navigator?.onLine===false;
function subscribe(listener){
  if(!listeners.size){globalThis.window?.addEventListener('online',changed);globalThis.window?.addEventListener('offline',changed);}
  listeners.add(listener);
  return()=>{listeners.delete(listener);if(!listeners.size){globalThis.window?.removeEventListener('online',changed);globalThis.window?.removeEventListener('offline',changed);}};
}
function beginWait(){const id={};waiting.add(id);changed();let ended=false;return()=>{if(ended)return;ended=true;waiting.delete(id);changed();};}
module.exports={snapshot,subscribe,beginWait};
