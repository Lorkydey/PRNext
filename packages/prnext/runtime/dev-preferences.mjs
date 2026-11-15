const key='prnext:dev-tools:v1';
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
  let state={version:1},storage;
  try{storage=view.localStorage;const raw=storage.getItem(key);if(raw&&raw.length<=4096)state=normalizeDevPreferences(JSON.parse(raw));}catch{}
  return {
    snapshot:()=>normalizeDevPreferences(state),
    update(patch){
      state=normalizeDevPreferences({version:1,console:{...state.console,...patch.console},preview:{...state.preview,...patch.preview}});
      try{storage?.setItem(key,JSON.stringify(state));}catch{}
      return normalizeDevPreferences(state);
    },
  };
}
