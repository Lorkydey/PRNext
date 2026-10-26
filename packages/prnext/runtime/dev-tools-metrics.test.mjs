import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDevMetricsCollector} from './dev-tools-metrics.mjs';

test('development metrics tails current HTTP/fetch events once and excludes bodies/headers',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-metrics-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const time=Date.now(),events=[
    {time:time-1000,type:'http',route:'/old',durationMs:100},
    {time,type:'http',route:'/products/1',method:'GET',status:200,durationMs:12,headers:{Authorization:'secret'},body:'private'},
    {time:time+1,type:'fetch',route:'/products/1',destination:'https://api.example/items?secret=yes',status:503,durationMs:30},
    {time,type:'process',rssBytes:100},
  ];
  await writeFile(path.join(directory,'worker-123-0.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\nnot JSON\n');
  await writeFile(path.join(directory,'unrelated.jsonl'),JSON.stringify({...events[1],route:'/unrelated'}));
  const collect=createDevMetricsCollector(directory,{since:time}),recorded=[];await collect(event=>recorded.push(event));await collect(event=>recorded.push(event));
  assert.equal(recorded.length,2);assert.equal(recorded[0].source,'server');assert.equal(recorded[0].duration,12);assert.equal(recorded[1].failed,true);
  assert.equal(recorded[0].headers,undefined);assert.equal(recorded[0].body,undefined);
});

test('development metrics ignore partial lines and files outside the session via symlinks',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-metrics-')),outside=await mkdtemp(path.join(tmpdir(),'prnext-metrics-private-'));t.after(async()=>{await rm(directory,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});});
  const time=Date.now(),line=JSON.stringify({time,type:'http',route:'/inside',durationMs:5})+'\n';
  await writeFile(path.join(directory,'native-123.jsonl'),'x'.repeat(70000)+'\n'+line);
  await writeFile(path.join(outside,'private'),JSON.stringify({time,type:'http',route:'/private',durationMs:5})+'\n');
  try{await symlink(path.join(outside,'private'),path.join(directory,'worker-999-0.jsonl'));}catch(error){if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;}
  const collected=[];await createDevMetricsCollector(directory,{since:time})(event=>collected.push(event));assert.deepEqual(collected.map(event=>event.path),['/inside']);
  await mkdir(path.join(directory,'folder'));try{await symlink(outside,path.join(directory,'linked'),'junction');const ignored=[];await createDevMetricsCollector(path.join(directory,'linked'),{since:time})(event=>ignored.push(event));assert.equal(ignored.length,0);}catch(error){if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;}
});
