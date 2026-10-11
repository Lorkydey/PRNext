import { cp, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../packages/prnext/build/index.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const artifacts=path.join(repo,'artifacts/performance-v4');
const app=path.join(repo,'artifacts/performance/app');
const destination=path.join(app,'.prnext-v4-final');
if(await stat(destination).then(()=>true,()=>false))throw new Error('Final candidate build already exists; preserve it and choose a new snapshot');
await build(app);
await rename(path.join(app,'.prnext'),destination);
const staticRoot=path.join(artifacts,'static-app');
await mkdir(staticRoot,{recursive:true});
for(const name of ['package.json','next.config.mjs','pages','public'])await cp(path.join(repo,'artifacts/performance/static-app',name),path.join(staticRoot,name),{recursive:true,errorOnExist:true,force:false});
await build(staticRoot);
const dist=path.join(staticRoot,'.prnext-static');
const manifest=JSON.parse(await readFile(path.join(dist,'manifest.json'),'utf8'));
const page=manifest.prerendered.find(page=>page.path==='/pages-static');
// A routing control: same HTML/gzip bytes served as an asset in one I/O task.
// Copy timestamps as well, or the gzip freshness guard correctly rejects it.
for(const extension of ['', '.gz'])await cp(path.join(dist,page.file+extension),path.join(dist,'assets/control.html'+extension),{preserveTimestamps:true});
console.log(JSON.stringify({app,build:destination,staticRoot,staticBuild:dist,page:page.file}));
