import path from 'node:path';
import {transformAsync} from '@babel/core';
import * as t from '@babel/types';
import {cachedAsyncTransform} from './transform-cache.mjs';
import {inlineSourceMap,sourceMapsEnabled,extractSourceMap} from './source-maps.mjs';
import {fileURLToPath} from 'node:url';

const keys=new Set(['styledComponents','emotion','removeConsole','reactRemoveProperties','relay','styledJsx','define','defineServer','runAfterProductionCompile']);
const fields={
  styledComponents:['displayName','ssr','fileName','meaninglessFileNames','minify','transpileTemplateLiterals','namespace','pure','cssProp','topLevelImportPaths'],
  emotion:['sourceMap','autoLabel','labelFormat','importMap'],
  removeConsole:['exclude'],reactRemoveProperties:['properties'],relay:['src','artifactDirectory','language','eagerEsModules'],styledJsx:['useLightningcss'],
};
export function normalizeNextCompiler(input){
  if(input===undefined)return;
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('compiler must be an object');
  for(const key of Object.keys(input))if(!keys.has(key))throw new TypeError(`Unknown compiler option ${key}`);
  for(const [key,allowed]of Object.entries(fields)){
    const value=input[key];if(value===undefined||typeof value==='boolean')continue;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new TypeError(`Invalid compiler.${key} configuration`);
    for(const [name,item]of Object.entries(value)){
      if(item===undefined)continue;
      if(['exclude','properties','meaninglessFileNames','topLevelImportPaths'].includes(name)){if(!Array.isArray(item)||item.some(x=>typeof x!=='string'))throw new TypeError(`compiler.${key}.${name} must be a string array`)}
      else if(['src','artifactDirectory','language','namespace','labelFormat','autoLabel'].includes(name)){if(typeof item!=='string')throw new TypeError(`compiler.${key}.${name} must be a string`)}
      else if(name==='importMap'){
        const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
        if(!object(item))throw new TypeError('compiler.emotion.importMap must be an object');
        for(const exports of Object.values(item)){
          if(!object(exports))throw new TypeError('compiler.emotion.importMap entries must map export names');
          for(const entry of Object.values(exports))if(!object(entry)||!entry.canonicalImport||Object.entries(entry).some(([key,pair])=>!['canonicalImport','styledBaseImport'].includes(key)||!Array.isArray(pair)||pair.length!==2||pair.some(value=>typeof value!=='string'||!value)))throw new TypeError('compiler.emotion.importMap requires canonicalImport and optional styledBaseImport module/export pairs');
        }
      }
      else if(typeof item!=='boolean')throw new TypeError(`compiler.${key}.${name} must be boolean`);
    }
  }
  if(input.relay&&(!input.relay.src||input.relay.language&&!['javascript','typescript','flow'].includes(input.relay.language)))throw new TypeError('compiler.relay requires src and a supported language');
  if(input.emotion?.autoLabel&&!['never','dev-only','always'].includes(input.emotion.autoLabel))throw new TypeError('compiler.emotion.autoLabel must be never, dev-only or always');
  for(const key of['define','defineServer'])if(input[key]!==undefined){
    if(!input[key]||typeof input[key]!=='object'||Array.isArray(input[key]))throw new TypeError(`compiler.${key} must be an object`);
    for(const [name,value]of Object.entries(input[key])){
      if(!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)||!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw new TypeError(`Invalid compiler.${key} definition ${name}`);
      if(/^(?:process\.env\.(?:NODE_ENV|NEXT_RUNTIME|PRNEXT_)|__prnext|__PRNEXT_)/.test(name))throw new TypeError(`compiler.${key} cannot override reserved ${name}`);
    }
  }
  if(input.runAfterProductionCompile!==undefined&&typeof input.runAfterProductionCompile!=='function')throw new TypeError('compiler.runAfterProductionCompile must be a function');
  return input;
}
const pluginNames={styledComponents:'babel-plugin-styled-components',emotion:'@emotion/babel-plugin',removeConsole:'babel-plugin-transform-remove-console',reactRemoveProperties:'babel-plugin-react-remove-properties',relay:'babel-plugin-relay',styledJsx:'styled-jsx/babel.js'};
const imports=new Map();
async function plugin(name){if(!imports.has(name))imports.set(name,import(name).then(m=>m.default?.default||m.default||m));return imports.get(name)}
function definitionsPlugin(values){
  const member=node=>t.isIdentifier(node)?node.name:t.isMemberExpression(node)&&(!node.computed&&t.isIdentifier(node.property)||node.computed&&t.isStringLiteral(node.property))?member(node.object)+'.'+(node.property.name||node.property.value):null;
  return()=>({visitor:{'ReferencedIdentifier|MemberExpression'(p){const name=member(p.node);if(!name||!Object.hasOwn(values,name)||p.scope.hasBinding(name.split('.')[0])||!t.isReferenced(p.node,p.parent))return;p.replaceWith(t.valueToNode(values[name]));p.skip()}}});
}
export async function transformNextCompiler(source,file,{config,root,stage,dev,target='node'}={}){
  const options=config?.compiler;if(!options||!root||!/[.](?:[cm]?[jt]s|[jt]sx)$/.test(file))return source;
  const relative=path.relative(root,file);
  if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||stage&&file.startsWith(stage+path.sep))return source;
  if(relative.split(path.sep).includes('node_modules')&&!(config.transpilePackages||[]).some(name=>file.split(path.sep).join('/').includes('/node_modules/'+name+'/')))return source;
  const {runAfterProductionCompile:hook,...settings}=options;
  if(!Object.entries(settings).some(([,v])=>!!v))return source;
  return cachedAsyncTransform('next-compiler-options',source,[file,settings,dev,target,'babel-contract-v1'],async()=>{
    const plugins=[];
    for(const [name,module]of Object.entries(pluginNames)){
      const value=settings[name];if(!value)continue;
      if(dev&&['removeConsole','reactRemoveProperties'].includes(name))continue;
      let opts=typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,value])=>value!==undefined)):{};
      if(name==='styledComponents')opts={displayName:!!dev,ssr:true,...opts};
      if(name==='emotion')opts={sourceMap:!!dev,autoLabel:'dev-only',...opts};
      if(name==='reactRemoveProperties'&&opts.properties)opts.properties=opts.properties.map(x=>new RegExp(x));
      if(name==='styledJsx'){
        const lightning=opts.useLightningcss;delete opts.useLightningcss;opts.optimizeForSpeed=!dev;
        if(lightning)opts.plugins=[[fileURLToPath(new URL('./styled-jsx-lightning.cjs',import.meta.url)),{development:!!dev}]];
      }
      plugins.push([await plugin(module),opts]);
    }
    const defines={...settings.define,...(target==='browser'?{}:settings.defineServer)};
    if(Object.keys(defines).length)plugins.push(definitionsPlugin(defines));
    if(!plugins.length)return source;
    const input=extractSourceMap(source),typed=/\.[cm]?tsx?$/.test(file);
    const result=await transformAsync(input.code,{filename:file,cwd:root,babelrc:false,configFile:false,sourceType:'unambiguous',sourceMaps:sourceMapsEnabled(),inputSourceMap:input.map||undefined,parserOpts:{plugins:['jsx',...(typed?['typescript']:[]),'decorators-legacy','importAttributes']},plugins});
    return inlineSourceMap(result.code,result.map);
  });
}
