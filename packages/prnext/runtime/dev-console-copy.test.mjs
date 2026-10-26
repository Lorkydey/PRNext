import test from 'node:test';
import assert from 'node:assert/strict';
import {consolePrompt} from './dev-console-copy.mjs';

test('AI errors prompt preserves complete stacks, groups repeated errors and omits URL parameters',()=>{
  const entries=[{level:'error',text:'Error: boom\n at app.tsx:20'},{level:'error',text:'Error: boom\n at app.tsx:20'},{level:'error',text:'Other failure'}];
  const text=consolePrompt(entries,{kind:'errors',version:'0.1.17-alpha',route:'http://localhost/app?token=secret#private',source:'Preview',dropped:3});
  assert.ok(text.startsWith('Fix all errors below.'));
  assert.match(text,/2 occurrences/);assert.match(text,/ at app\.tsx:20/);assert.match(text,/Other failure/);
  assert.match(text,/3 \(2 unique\)/);assert.match(text,/Earlier messages/);
  assert.match(text,/Route: \/app/);assert.doesNotMatch(text,/token|secret|private/);
});
test('single message report copies diagnostic text literally without interpreting markup',()=>{
  const payload='<script>bad()</script>\n'+ 'long message '.repeat(3000);
  const text=consolePrompt([{level:'log',text:payload}],{kind:'message',route:'/test'});
  assert.ok(text.includes(payload));assert.match(text,/Investigate the client message below/);
});

test('unified AI reports identify execution context and never merge browser and server failures',()=>{
  const text=consolePrompt([{source:'browser',level:'error',text:'Same message'},{source:'server',level:'error',text:'Same message'}],{kind:'errors'});
  assert.match(text,/2 \(2 unique\)/);assert.match(text,/ERROR · server/);assert.match(text,/ERROR · browser/);assert.match(text,/development console/);
});
