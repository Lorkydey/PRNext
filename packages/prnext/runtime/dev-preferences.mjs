const key='prnext:dev-tools:v1';
const marker='prnext:dev-tools:v2';
const fields={console:['level','source','bounds'],preview:['device','rotated','folded','frameEnabled','customWidth']};
const entries=Object.entries(fields).flatMap(([group,names])=>names.map(name=>({group,name,key:`${marker}:${group}:${name}`})));
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
export function normalizeDevPreferences(value) {
  const result={version:1};if(!plain(value)||value.version!==1)return result;
  if(plain(value.console)){
    const source=value.console,console={};
    if(['all','error','warn','info','debug'].includes(source.level))console.level=source.level;
    if(['all','browser','server'].includes(source.source))console.source=source.source;
    const bounds=source.bounds;
    if(plain(bounds)&&finite(bounds.x,-32768,32768)&&finite(bounds.y,-32768,32768)&&finite(bounds.width,1,16384)&&finite(bounds.height,1,16384))console.bounds={x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};
    if(Object.keys(console).length)result.console=console;
  }
  if(plain(value.preview)&&['desktop','phone','tablet','duo'].includes(value.preview.device)){
    const source=value.preview,preview={device:source.device};
    for(const name of ['rotated','folded','frameEnabled'])if(typeof source[name]==='boolean')preview[name]=source[name];
    if(finite(source.customWidth,240,2560)&&Number.isInteger(source.customWidth)&&source.device!=='duo')preview.customWidth=source.customWidth;
    result.preview=preview;
  }
  return result;
}
// Only UI preferences enter browser storage: no queries, logs, page URLs,
// project paths, screenshots, credentials or assistant context.
export function createDevPreferences(view=globalThis) {
  let state={version:1},storage;const listeners=new Set();
  const parse=raw=>raw&&raw.length<=4096?JSON.parse(raw):undefined;
  try{
    storage=view.localStorage;
    if(storage.getItem(marker)==null){
      try{state=normalizeDevPreferences(parse(storage.getItem(key)));}catch{}
      // Independent fields prevent two tabs changing unrelated settings from
      // overwriting each other's complete snapshot. Migrate the old key once.
      for(const entry of entries){const value=state[entry.group]?.[entry.name];if(value!==undefined)storage.setItem(entry.key,JSON.stringify(value));}
      storage.setItem(marker,'1');storage.removeItem?.(key);
    }
  }catch{storage=undefined;}
  function read(){
    if(storage)try{
      const value={version:1,console:{},preview:{}};
      for(const entry of entries){const raw=storage.getItem(entry.key);try{value[entry.group][entry.name]=parse(raw);}catch{}}
      state=normalizeDevPreferences(value);
    }catch{storage=undefined;}
    return normalizeDevPreferences(state);
  }
  let serialized=JSON.stringify(read());
  function notify(reset=false){const snapshot=read(),next=JSON.stringify(snapshot);if(next===serialized&&!reset)return;serialized=next;for(const listener of listeners)listener(snapshot,{reset});}
  function storageChanged(event){if(event.storageArea&&event.storageArea!==storage)return;if(event.key===marker||entries.some(entry=>entry.key===event.key))notify(event.key===marker);}
  view.addEventListener?.('storage',storageChanged);
  return {
    snapshot:read,
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    update(patch){
      const current=read();state=normalizeDevPreferences({version:1,console:{...current.console,...patch.console},preview:{...current.preview,...patch.preview}});
      try{for(const entry of entries)if(Object.hasOwn(patch[entry.group]||{},entry.name)||(entry.name==='customWidth'&&state.preview?.device==='duo')){
        const value=state[entry.group]?.[entry.name];if(value===undefined)storage?.removeItem(entry.key);else storage?.setItem(entry.key,JSON.stringify(value));
      }}catch{storage=undefined;}
      notify();return normalizeDevPreferences(state);
    },
    reset(){state={version:1};try{for(const entry of entries)storage?.removeItem(entry.key);storage?.removeItem(key);storage?.setItem(marker,String(Date.now()));}catch{storage=undefined;}notify(true);},
    dispose(){listeners.clear();view.removeEventListener?.('storage',storageChanged);},
  };
}
