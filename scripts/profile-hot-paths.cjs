// Diagnostic only: enable with HOT_NODE_PRELOAD, never for reported timings.
const {Session}=require('node:inspector');
const {threadId}=require('node:worker_threads');
const {writeFileSync,mkdirSync}=require('node:fs');
const path=require('node:path');
const directory=path.resolve(__dirname,'../reports/hot-path-optimization/profiles');
const session=new Session();session.connect();
const post=(name,args={})=>new Promise((resolve,reject)=>session.post(name,args,(error,value)=>error?reject(error):resolve(value)));
const timer=setTimeout(async()=>{
 try{
  await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');
  const stop=setTimeout(async()=>{
   try{const {profile}=await post('Profiler.stop');mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,`${process.pid}-${threadId}.cpuprofile`),JSON.stringify(profile))}
   catch(error){process.stderr.write('Profile failed: '+error.message+'\n')}
   finally{session.disconnect()}
  },8000);stop.unref();
 }catch(error){session.disconnect();process.stderr.write('Profile failed: '+error.message+'\n')}
},3000);timer.unref();
