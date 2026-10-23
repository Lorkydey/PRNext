import path from 'node:path';
import {pathToFileURL} from 'node:url';
// This is an import budget, not a total RSS limit. An individual module and its
// transitive imports can exceed it; imported JavaScript cannot be unloaded.
export async function preloadModules(files,{maxRssMb,timeoutMs},load=file=>import(pathToFileURL(file).href)){
  const deadline=performance.now()+timeoutMs,loaded=[];
  for(const file of files){
    if(performance.now()>=deadline||process.memoryUsage().rss>=maxRssMb*1024*1024)break;
    await load(path.resolve(file));loaded.push(file);
  }
  return loaded.length;
}
