/** Materialize a discovered route pattern without interpolating path separators. */
export function route(pattern,params={}) {
  if(typeof pattern!=='string'||!pattern.startsWith('/')||pattern.startsWith('//')||pattern.length>4096||!params||typeof params!=='object'||Array.isArray(params))throw TypeError('Invalid route pattern or parameters');
  const used=new Set(),parts=[];
  const segment=value=>{
    if(typeof value!=='string'||!value||value==='.'||value==='..'||/[/\\\0]/.test(value))throw TypeError('Route parameters must be nonempty path segments');
    return encodeURIComponent(value);
  };
  for(const part of pattern.split('/').slice(1)){
    const match=/^(?:\[\[\.\.\.([A-Za-z_$][\w$]*)\]\]|\[\.\.\.([A-Za-z_$][\w$]*)\]|\[([A-Za-z_$][\w$]*)\])$/.exec(part);
    if(!match){if(/[\[\]?#\\\0]/.test(part)||part==='.'||part==='..'||!part&&pattern!=='/')throw TypeError('Invalid route segment');parts.push(part);continue;}
    const name=match[1]||match[2]||match[3];used.add(name);const value=params[name];
    if(match[1]&&value===undefined)continue;
    if(match[1]||match[2]){if(!Array.isArray(value)||match[2]&&!value.length)throw TypeError(`Route parameter ${name} must be an array of segments`);parts.push(...value.map(segment));}
    else parts.push(segment(value));
  }
  for(const name of Object.keys(params))if(!used.has(name))throw TypeError(`Unknown route parameter ${name}`);
  const result='/'+parts.join('/');if(result.length>8192)throw TypeError('Route exceeds 8 KiB');return result;
}
