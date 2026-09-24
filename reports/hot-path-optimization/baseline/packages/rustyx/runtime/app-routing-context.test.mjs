import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('branch Flight and metadata isolate a warmed private cache and draft provider', async () => {
  const moduleURL = name => JSON.stringify(new URL(name, import.meta.url).href);
  const source = `
    import assert from 'node:assert/strict';
    import {getEventListeners} from 'node:events';
    import React from 'react';
    import {renderToReadableStream} from 'react-server-dom-webpack/server.node';
    import {routingBranchRenderer} from ${moduleURL('./app-routing-context.mjs')};
    import {resolveMetadata} from ${moduleURL('./app-metadata.mjs')};
    import {runRequestContext,currentRequest,headers,draftMode} from ${moduleURL('../compat/headers.cjs')};
    import {invokeCache} from ${moduleURL('../compat/use-cache.cjs')};
    const cached=()=>invokeCache('identity','private',[],[],async()=>{await Promise.resolve();return (await headers()).get('x-user')});
    await runRequestContext({url:'http://localhost/parent',distDir:process.cwd(),headers:{'x-user':'parent',cookie:'__prerender_bypass=build'},previewModeId:'build',phase:'render',clientModules:{},actions:{}},async()=>{
      assert.equal(await cached(),'parent');
      assert.equal((await draftMode()).isEnabled,true);
      const parentAbort=new AbortController();
      const beforeListeners=getEventListeners(parentAbort.signal,'abort').length;
      const branch=routingBranchRenderer(currentRequest(),{},parentAbort.signal,error=>{throw error});
      async function Child(){await Promise.resolve();return React.createElement('p',null,(await cached())+':'+(await draftMode()).isEnabled)}
      const stream=renderToReadableStream(['parent',...['alice','bob'].map(user=>React.cloneElement(branch(React.createElement(Child),{url:'http://localhost/'+user,headers:{'x-user':user}}),{key:user}))],{});
      const wire=await new Response(stream).text();
      assert.equal(getEventListeners(parentAbort.signal,'abort').length,beforeListeners);
      assert.match(wire,/alice:false/);assert.match(wire,/bob:false/);assert.doesNotMatch(wire,/parent:true/);
      const resolved=await resolveMetadata({metadataItems:['alice','bob'].map(user=>({params:Promise.resolve({}),context:{headers:{'x-user':user}},module:{generateMetadata:async()=>({title:(await cached())+':'+(await draftMode()).isEnabled})}}))},{params:Promise.resolve({})});
      assert.equal(resolved.title,'bob:false');
      assert.equal(await cached(),'parent');assert.equal((await draftMode()).isEnabled,true);
      const errors=[],signals=[];
      const limited=routingBranchRenderer(currentRequest(),{},AbortSignal.timeout(5000),error=>{errors.push(error.message);return 'branch-limit'},128*1024);
      async function Large({name}){signals.push(currentRequest().signal);await Promise.resolve();return React.createElement('p',null,name.repeat(96*1024))}
      const oversized=renderToReadableStream(['a','b'].map(name=>React.cloneElement(limited(React.createElement(Large,{name}),{headers:{'x-user':name}}),{key:name})),{}, {onError:error=>{errors.push(error.message);return 'branch-limit'}});
      await new Response(oversized).text();
      assert.ok(errors.some(message=>message.includes('Combined routing branch Flight exceeds')));
      assert.equal(signals.length,2);assert.ok(signals.every(signal=>signal.aborted));
    });
  `;
  const result = await promisify(execFile)(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', source], { timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(result.stderr, '');
});
