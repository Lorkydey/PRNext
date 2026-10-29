import {appendFile,access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {invokeCache,cacheTag,cacheLife} from '../packages/prnext/compat/use-cache.cjs';
import {runRequestContext} from '../packages/prnext/compat/headers.cjs';
import {flushCacheWork} from '../packages/prnext/compat/data-cache.cjs';

const [root,gated]=process.argv.slice(2);
try{
  const result=await runRequestContext({distDir:root,cacheHandlers:{remote:'server/handler.mjs'},url:'http://localhost/product',routePattern:'/product',phase:'route'},async()=>{
    try{return await invokeCache('shared-redis-component','remote',[],[],async()=>{
      await appendFile(path.join(root,'producers'),'x');await appendFile(path.join(root,'started'),'x');
      if(gated){const until=Date.now()+10000;while(Date.now()<until){try{await access(path.join(root,'release'));break;}catch{await delay(10);}}}
      else await delay(300);
      cacheTag('products');cacheLife('hours');return {value:'shared',date:new Date(0),amount:12n};
    });}finally{await flushCacheWork();}
  });
  console.log(JSON.stringify({value:result.value,date:result.date.toISOString(),amount:String(result.amount)}));
}catch(error){console.error(error);process.exitCode=1;}
finally{const {client}=await import(pathToFileURL(path.join(root,'server/handler.mjs')).href);if(client.isOpen)client.destroy();}
