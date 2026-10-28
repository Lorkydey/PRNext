import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import React from 'react';
import {nodeHtmlReader} from './node-html-stream.mjs';

test('Node HTML exposes the Suspense shell before deferred content and completes without listeners',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),abort=new AbortController();
  async function Content(){await gate;return React.createElement('strong',null,'complete');}
  const tree=React.createElement('html',null,React.createElement('body',null,React.createElement(React.Suspense,{fallback:'waiting'},React.createElement(Content))));
  const reader=await nodeHtmlReader(tree,{signal:abort.signal,onError(){}});
  let text=(await reader.read()).value.toString();assert.match(text,/waiting/);assert.doesNotMatch(text,/>complete</);
  release();for(;;){const part=await reader.read();if(part.done)break;text+=part.value.toString();}
  assert.match(text,/>complete</);assert.equal(getEventListeners(abort.signal,'abort').length,0);
});
test('Node HTML cancellation and shell failures settle without retaining their signal',async()=>{
  const controller=new AbortController();let release;const gate=new Promise(resolve=>release=resolve);
  async function Blocked(){await gate;return React.createElement('p',null,'later');}
  const pending=nodeHtmlReader(React.createElement(Blocked),{signal:controller.signal,onError(){}});
  controller.abort(new Error('cancel-before-shell'));await assert.rejects(pending,/cancel-before-shell/);release();
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  const abort=new AbortController();
  function Broken(){throw new Error('shell-error');}
  await assert.rejects(nodeHtmlReader(React.createElement(Broken),{signal:abort.signal,onError(){}}),/shell-error/);
  assert.equal(getEventListeners(abort.signal,'abort').length,0);
  const reader=await nodeHtmlReader(React.createElement('html',null,React.createElement('body',null,'ok')),{signal:abort.signal});
  await reader.cancel();assert.equal(getEventListeners(abort.signal,'abort').length,0);
});
