import {AsyncLocalStorage} from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const withSourceMaps = callback => scope.run({enabled:false},callback);
export const configureSourceMaps = enabled => {if(scope.getStore())scope.getStore().enabled=!!enabled;};
export const sourceMapsEnabled = () => scope.getStore()?.enabled === true;
const directive = /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^*]+)\*\/)/g;

export function extractSourceMap(source) {
  let map;
  const code=source.replace(directive,(comment,line,block)=>{
    const url=(line || block).trim();
    if(!url.startsWith('data:application/json'))return comment;
    const comma=url.indexOf(',');
    try {map=JSON.parse(url.slice(0,comma).includes(';base64')?Buffer.from(url.slice(comma+1),'base64').toString():decodeURIComponent(url.slice(comma+1)));}
    catch {throw new Error('Invalid inline source map');}
    // Keep original line coordinates while discarding the stale directive.
    return line ? '' : comment.replace(/[^\r\n]/g,' ');
  });
  return {code,map};
}
export function inlineSourceMap(source,map) {
  if(!map)return source;
  const clean=extractSourceMap(source).code;
  return clean+'\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(typeof map==='string'?JSON.parse(map):map)).toString('base64');
}

/** Babel composes the new locations directly with the previous transform map. */
export function generateMapped(generate,ast,options,source,file) {
  if(!sourceMapsEnabled())return generate(ast,options,source).code;
  const {code,map}=extractSourceMap(source);
  const result=generate(ast,{...options,sourceMaps:true,sourceFileName:file,inputSourceMap:map,
    shouldPrintComment:comment=>!/[#@]\s*sourceMappingURL=/.test(comment)},code);
  return inlineSourceMap(result.code,result.map);
}
