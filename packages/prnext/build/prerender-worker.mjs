import {prerenderPages} from './prerender-pages.mjs';
import {prerenderApp} from './app-static.mjs';
process.once('message',async({stage,manifest})=>{
  try{
    await prerenderPages(stage,manifest,false);
    await prerenderApp(stage,manifest,false);
    process.send({ok:true,manifest},()=>process.exit(0));
  }catch(error){process.send({ok:false,error:error.stack||error.message},()=>process.exit(1));}
});
process.once('disconnect',()=>process.exit(1));
