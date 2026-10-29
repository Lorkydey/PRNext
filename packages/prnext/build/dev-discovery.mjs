import {loadProjectConfig} from './config.mjs';
import {scanProject} from './scan.mjs';
import {snapshotEnvConfig} from '../runtime/env.mjs';

export function routeFiles(project, patterns) {
  const files=new Set();
  const visit=value=>{
    if(typeof value==='string' && /\.(?:[cm]?js|jsx|tsx?)$/.test(value))files.add(value);
    else if(Array.isArray(value))for(const item of value)visit(item);
    else if(value&&typeof value==='object')for(const item of Object.values(value))visit(item);
  };
  for(const route of project.routes)if(patterns.includes(route.pattern)||route.internal||route.errorStatus)visit(route);
  visit(project.appNotFound);return files;
}
export async function discoverDevelopment(root) {
  const restore=snapshotEnvConfig();
  const envMode=process.env.NODE_ENV==='test'?'test':'development';
  process.env.NODE_ENV='development';
  try {
    const config=await loadProjectConfig(root,{dev:true,envMode});
    const project=await scanProject(root,{basePath:config.basePath,pageExtensions:config.pageExtensions,i18n:config.i18n,devAppFiles:new Set()});
    // Destinations unknown before routing are represented by deferred entries.
    // Their worker asks the compiler only after middleware has run once.
    const eager=false;
    return {project,eager,cssFast:!config.webpack&&!Object.keys(config.turbopack?.rules||{}).length,config:{basePath:config.basePath,assetPrefix:config.assetPrefix,i18n:config.i18n,distDir:config.distDir,
      onDemandEntries:config.onDemandEntries,typescript:config.typescript,typedRoutes:config.typedRoutes,cssEngine:config.cssEngine}};
  } finally {restore();}
}
