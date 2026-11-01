import {build as bundle} from 'esbuild';
import {readFile,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {rename} from '../runtime/fs.mjs';
import {createCssModules} from './css-modules.mjs';
import {recordDevDependencies,developmentStyleDependencies} from './dev-dependencies.mjs';
import {writeBuildOutput} from './output-contract.mjs';
import {createStyleOverlay,StyleOverlayFallback} from './dev-css-assets.mjs';

/** Publish only styles when all JS-visible class maps remain identical. */
export async function tryDevCssUpdate({root,source,baseSource=source,destination,manifest,changed,sequence,cssEngine,onFallback=()=>{}}){
  const fallback=code=>{onFallback(code);return undefined;};
  if(!changed.length||changed.some(file=>!file.endsWith('.css'))||!manifest.devStyles?.bundles.length||manifest.app?.globalError?.css?.length)return;
  if(!manifest.config.assetBase.startsWith('/'))return fallback('external-asset-base');
  if(JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).postcss!==undefined)return fallback('css-processor');
  // Custom PostCSS/webpack generators can change JS or emit other files.
  for(const name of ['postcss.config.js','postcss.config.cjs','postcss.config.mjs','postcss.config.json','.postcssrc','.postcssrc.json'])if(await stat(path.join(root,name)).catch(()=>null)){
    if(name!=='postcss.config.json')return fallback('css-processor');
    const value=JSON.parse(await readFile(path.join(root,name),'utf8'));
    if(Object.keys(value).some(key=>key!=='plugins')||!value.plugins||Object.keys(value.plugins).length)return fallback('css-processor');
  }
  const plans=manifest.devStyles.bundles,dependencies=new Map(manifest.devStyles.dependencies||[]);
  // Older manifests lack enough provenance to select bundles safely.
  if(plans.some(([name])=>!dependencies.get(name)?.length))return fallback('missing-style-dependencies');
  const changedPaths=new Set(changed.map(file=>path.resolve(root,file)));
  const selected=plans.filter(([name])=>dependencies.get(name).some(file=>changedPaths.has(file)));
  const known=new Set([...dependencies.values()].flat());
  const allRoots=plans.flatMap(([,files])=>files);
  if(selected.flatMap(([,files])=>files).some(file=>!file.endsWith('.css')||!file.startsWith('prnext-compiled-css:')&&!path.isAbsolute(file)))return fallback('stylesheet-language');
  for(const file of allRoots)known.add(file.replace(/^prnext-compiled-css:/,''));
  for(const dependency of manifest.devDependencies||[])for(const file of dependency.files)if(file.endsWith('.css'))known.add(path.join(root,file));
  if(changed.some(file=>!known.has(path.join(root,file))))return fallback('unknown-style-dependency');
  if(!selected.length)return fallback('unknown-style-dependency');
  const stage=destination,modules=createCssModules({projectRoot:root,stage,assetBase:manifest.config.assetBase,cssEngine,dev:true});
  let overlay;
  try{
    overlay=await createStyleOverlay({root,source,baseSource,destination,manifest,plans,selected});
    for(const previous of manifest.devStyles.modules.filter(module=>(module.watchFiles||[module.file]).some(file=>changedPaths.has(file)))){
      if(!previous.file.endsWith('.css')){await rm(stage,{recursive:true,force:true});return fallback('stylesheet-language');}
      if((await modules.compile(previous.file)).mapping!==previous.mapping){await rm(stage,{recursive:true,force:true});return fallback('css-module-exports');}
    }
    const state={dev:true,root,stage};
    for(const [name,files]of selected){
      const options={absWorkingDir:root,stdin:{contents:files.map(file=>`@import ${JSON.stringify(file.replace(/^prnext-compiled-css:/,'prnext-css:'))};`).join('\n'),resolveDir:root,loader:'css'},outfile:path.join(stage,'assets',name),bundle:true,write:false,metafile:true,logLevel:'silent',publicPath:manifest.config.assetBase,assetNames:'[name]-[hash]',loader:Object.fromEntries(['.png','.jpg','.jpeg','.svg','.gif','.webp','.avif','.woff','.woff2','.ttf'].map(ext=>[ext,'file'])),plugins:[modules.plugin(true)]};
      const result=await bundle(options);recordDevDependencies(state,options,result);
      await overlay.recordBundle(name,result);
    }
    const compiled=await modules.mappings();
    if(compiled.some(value=>!manifest.devStyles.modules.some(previous=>previous.file===value.file&&previous.mapping===value.mapping))){await rm(stage,{recursive:true,force:true});return fallback('css-module-exports');}
    const updated=manifest.devStyles.modules.map(previous=>compiled.find(value=>value.file===previous.file)||previous);
    for(const [name,files]of developmentStyleDependencies(state)){
      for(const module of updated)if(files.includes(module.file))for(const file of module.watchFiles)if(!files.includes(file))files.push(file);
      dependencies.set(name,files);
    }
    const assets=await overlay.finish();
    const buildId=randomUUID(),baseClient=manifest.devStyles.baseClient||manifest.devClient,next={...manifest,buildId,devSequence:sequence,devClient:manifest.config.assetBase+'/dev-manifest-'+buildId+'.json',outputDirectory:stage,devStyles:{baseClient,overlay:assets,bundles:plans,dependencies:[...dependencies],modules:updated}};
    // Keep route invalidation conservative as CSS imports are added or removed.
    // Unchanged routes retain their original dependency arrays.
    next.devDependencies=(manifest.devDependencies||[]).map(route=>{
      const relevant=selected.filter(([name])=>manifest.devStyles.dependencies.find(([key])=>key===name)[1].some(file=>route.files.includes(path.relative(root,file).replaceAll(path.sep,'/'))));
      if(!relevant.length)return route;
      const currentStyleFiles=new Set([...dependencies.values()].flat());
      const removed=new Set(manifest.devStyles.dependencies.flatMap(([,files])=>files).filter(file=>!currentStyleFiles.has(file)).map(file=>path.relative(root,file).replaceAll(path.sep,'/')));
      const files=new Set(route.files.filter(file=>!removed.has(file)));
      for(const[name]of relevant)for(const file of dependencies.get(name)){
        const relative=path.relative(root,file).replaceAll(path.sep,'/');
        if(relative&&!relative.startsWith('../')&&!relative.includes(':'))files.add(relative);
      }
      return {...route,files:[...files]};
    });
    let old;
    try{old=JSON.parse(await readFile(path.join(source,'assets',path.basename(manifest.devClient)),'utf8'));}
    catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)throw new StyleOverlayFallback('missing-style-manifest');throw error;}
    if(!Array.isArray(old?.pages)||old.pages.some(page=>!Array.isArray(page.css))||old.app&&(!Array.isArray(old.app.css)||!Array.isArray(old.app.routes)||old.app.routes.some(route=>!Array.isArray(route.css))))throw new StyleOverlayFallback('invalid-style-manifest');
    old.buildId=buildId;
    const changedNames=new Set(selected.map(([name])=>name));
    const revise=urls=>urls.map(url=>changedNames.has(path.posix.basename(url.split('?')[0]))?url.split('?')[0]+'?v='+buildId:url);
    const reviseScopes=scopes=>scopes?.map(scope=>({...scope,css:revise(scope.css)}));
    for(const page of old.pages)page.css=revise(page.css);if(old.app){old.app.css=revise(old.app.css);for(const route of old.app.routes||[]){route.css=revise(route.css);if(route.cssScopes)route.cssScopes=reviseScopes(route.cssScopes);}}
    next.routes=next.routes.map(route=>({...route,css:revise(route.css||[]),...(route.cssScopes?{cssScopes:reviseScopes(route.cssScopes)}:{})}));
    await writeFile(path.join(stage,'assets',path.basename(next.devClient)),JSON.stringify(old));
    const temporary=path.join(stage,'manifest.'+buildId+'.tmp');await writeFile(temporary,JSON.stringify(next));await rename(temporary,path.join(stage,'manifest.json'));
    await writeBuildOutput(stage,next);
    return next;
  }catch(error){if(overlay)await rm(stage,{recursive:true,force:true});if(error instanceof StyleOverlayFallback)return fallback(error.code);throw error;}
}
