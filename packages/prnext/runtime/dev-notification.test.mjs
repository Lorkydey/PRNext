import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDevNotification,MAX_DEV_NOTIFICATION_BYTES} from './dev-notification.mjs';

const check=({notification,text})=>{
  assert.ok(Buffer.byteLength(text)<=MAX_DEV_NOTIFICATION_BYTES);
  assert.deepEqual(JSON.parse(text),notification);
  assert.ok(Buffer.byteLength(JSON.stringify({id:Number.MAX_SAFE_INTEGER,command:'notify',value:notification})+'\n')<65536);
};

test('small notifications retain their fields and do not mutate the source',()=>{
  const value={state:'ready',buildId:'build',session:'session',sequence:3,safeMode:false,clientManifest:'/_prnext/assets/dev.json',changed:['pages/index.tsx'],affectedRoutes:['/'],typeErrors:[],compiler:{hits:7}};
  const copy=structuredClone(value),prepared=prepareDevNotification(value);
  check(prepared);assert.deepEqual(prepared.notification,value);assert.deepEqual(value,copy);
  assert.equal(prepared.notification.notificationTruncated,undefined);
});

test('large UTF-8 diagnostics and escaped filenames stay below the real JSON byte limit',()=>{
  const value={state:'ready',buildId:'build',session:'session',sequence:5,clientManifest:'/_prnext/assets/dev.json',
    affectedRoutes:Array.from({length:2000},(_,i)=>'/'+('界'.repeat(30))+i),changed:Array.from({length:32},()=>('😀界\n\u0000"\\'.repeat(256))),
    typeErrors:Array.from({length:32},()=>('型エラー😀\u0000'.repeat(4000))),error:'失敗😀\u0000'.repeat(10000),routes:Array(2000).fill('/long'),compiler:{details:'x'.repeat(50000)}};
  const prepared=prepareDevNotification(value);check(prepared);
  const next=prepared.notification;
  assert.equal(next.state,'ready');assert.equal(next.buildId,'build');assert.equal(next.sequence,5);assert.equal(next.clientManifest,value.clientManifest);
  assert.equal(next.affectedRoutes,undefined);assert.ok(next.notificationTruncated);
  for(const field of ['changed','typeErrors','error','affectedRoutes','routes','compiler'])assert.ok(next.truncatedFields.includes(field),field);
  assert.ok(Buffer.byteLength(JSON.stringify(next.changed))<=16*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(next.typeErrors))<=8*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(next.error))<=8*1024);
  // The source's selective list remains intact; only the transmitted event changes.
  assert.equal(value.affectedRoutes.length,2000);
});

test('identity URLs remain complete and oversized unknown metadata is dropped',()=>{
  const clientManifest='/'+('界'.repeat(2000))+'.json',pagesManifest='/'+('😀'.repeat(1800))+'.json';
  const value={state:'ready',buildId:'build',session:'session',sequence:8,safeMode:true,cssOnly:true,listenerPid:123,clientManifest,pagesManifest,
    changed:Array(32).fill('😀'.repeat(1000)),typeErrors:Array(32).fill('失敗'.repeat(10000)),error:'\u0000'.repeat(50000),reason:{code:'source-changed',summary:'界'.repeat(10000),extra:'x'.repeat(70000)},custom:'x'.repeat(100000),affectedRoutes:['/one']};
  const prepared=prepareDevNotification(value);check(prepared);
  const next=prepared.notification;
  for(const key of ['state','buildId','session','sequence','safeMode','cssOnly','listenerPid','clientManifest','pagesManifest'])assert.equal(next[key],value[key],key);
  assert.equal(next.custom,undefined);assert.equal(next.affectedRoutes,undefined);assert.ok(next.truncatedFields.includes('metadata'));
  assert.equal(next.reason.code,'source-changed');assert.ok(Buffer.byteLength(JSON.stringify(next.reason.summary))<=2048);
});

test('oversized URLs are omitted instead of truncated and strings retain surrogate pairs',()=>{
  const value={state:'ready',buildId:'build',clientManifest:'/'+('😀'.repeat(30000)),changed:['😀'.repeat(1000)],typeErrors:[],extra:1n};
  const prepared=prepareDevNotification(value);check(prepared);
  assert.equal(prepared.notification.clientManifest,undefined);
  assert.ok(prepared.notification.truncatedFields.includes('clientManifest'));
  const filename=prepared.notification.changed[0].slice(0,-1);
  assert.equal(filename.length%2,0);assert.ok([...filename].every(character=>character==='😀'));
});

test('truncating changed filenames disables the selective refresh hint even when the event fits',()=>{
  const prepared=prepareDevNotification({state:'ready',buildId:'build',clientManifest:'/dev.json',changed:['界'.repeat(1000)],affectedRoutes:['/one'],typeErrors:[]});
  check(prepared);assert.equal(prepared.notification.affectedRoutes,undefined);
  assert.deepEqual(prepared.notification.truncatedFields,['changed','affectedRoutes']);
});
