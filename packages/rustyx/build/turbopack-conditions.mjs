import path from 'node:path';
import picomatch from 'picomatch';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const builtins = new Set(['browser','foreign','development','production','node','edge-light']);
const frameworkRoot=fileURLToPath(new URL('../',import.meta.url));
export function validateCondition(value, depth = 0, budget = {remaining:256}) {
  if (depth > 32 || --budget.remaining < 0) throw new TypeError('Turbopack condition is too complex');
  if (typeof value === 'string' && builtins.has(value)) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof RegExp) throw new TypeError('Invalid Turbopack condition');
  const keys = Object.keys(value);
  if (keys.length === 1 && ['all','any','not'].includes(keys[0])) {
    const key = keys[0];
    if (key === 'not') return validateCondition(value.not,depth+1,budget);
    if (!Array.isArray(value[key])) throw new TypeError(`Turbopack condition ${key} must be an array`);
    for (const child of value[key]) validateCondition(child,depth+1,budget);
    return;
  }
  if (!keys.length || keys.some(key=>!['path','content'].includes(key)) ||
      ('path' in value && !(value.path instanceof RegExp) && typeof value.path !== 'string') ||
      ('content' in value && !(value.content instanceof RegExp))) throw new TypeError('Invalid Turbopack path/content condition');
}

const regex = (pattern,value) => {pattern.lastIndex=0;return pattern.test(value);};
const glob = pattern => {const match=picomatch(pattern);return file=>match(pattern.includes('/')?file:path.posix.basename(file));};
function compileCondition(value, state, target) {
  if (typeof value === 'string') {
    if (value === 'foreign') return async file=>/(^|\/)node_modules\//.test(file) || path.resolve(state.root,file).startsWith(frameworkRoot);
    const enabled={browser:target==='browser',node:target==='node','edge-light':target==='edge',development:!!state.dev,production:!state.dev}[value];
    return async()=>enabled;
  }
  if (value.not) {const child=compileCondition(value.not,state,target);return async(file,read)=>!await child(file,read);}
  if (value.all || value.any) {
    const all=!!value.all, children=(value.all || value.any).map(child=>compileCondition(child,state,target));
    return async(file,read)=>{for(const child of children)if(await child(file,read)!==all)return !all;return all;};
  }
  const match=value.path instanceof RegExp?file=>regex(value.path,file):typeof value.path==='string'?glob(value.path):()=>true;
  return async(file,read)=>match(file) && (!value.content || regex(value.content,await read()));
}

// Conditions read source only when a content predicate is actually reached.
// No file contents survive selection, and boolean operators short-circuit.
export function turbopackRules(rules, state, target) {
  const root = state.config?.turbopack?.root || state.root;
  const conditionState = {...state,root};
  return Object.entries(rules || {}).flatMap(([pattern,entries])=>{
    const match=glob(pattern);
    return (Array.isArray(entries)?entries:[entries]).map(rule=>{
      const predicate=rule.condition===undefined?async()=>true:compileCondition(rule.condition,conditionState,target);
      return {test:file=>match(path.relative(root,file).replaceAll(path.sep,'/')),use:rule.loaders,
        rustyxCondition:async(file,read)=>predicate(path.relative(root,file).replaceAll(path.sep,'/'),read)};
    });
  });
}
export function sourceReader(file) {
  let source;
  return ()=>source ||= readFile(file,'utf8');
}
