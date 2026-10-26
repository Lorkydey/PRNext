import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {createDevWorkerConsole,parseDevLogLine} from './dev-worker-logs.mjs';

test('development Console preserves levels, formatting, groups and full multiline text',async()=>{
  let output='';const stream=new Writable({write(chunk,encoding,done){output+=chunk;done();}}),logger=createDevWorkerConsole({output:stream});
  logger.console.log('count %d',3);logger.console.info('informational');logger.console.warn('warning');logger.console.error('failure');
  logger.console.group('Group');logger.console.log('nested');logger.console.groupEnd();logger.console.log('after');logger.console.error('one\ntwo');
  await new Promise(resolve=>setImmediate(resolve));
  const lines=output.trimEnd().split('\n').map(parseDevLogLine);
  assert.deepEqual(lines.map(line=>line.level),['info','info','warn','error','info','info','info','error','error']);
  assert.deepEqual(lines.map(line=>line.text),['count 3','informational','warning','failure','Group','  nested','after','one','two']);
});

test('development log context follows actual async requests without leaking search values',async()=>{
  let output='';const stream=new Writable({write(chunk,encoding,done){output+=chunk;done();}}),logger=createDevWorkerConsole({output:stream});
  await Promise.all([logger.run({requestId:1,route:'/a?secret=yes'},async()=>{await Promise.resolve();logger.console.log('A');}),logger.run({requestId:2,route:'/b'},async()=>{await Promise.resolve();logger.console.warn('B');})]);
  await new Promise(resolve=>setImmediate(resolve));const lines=output.trimEnd().split('\n').map(parseDevLogLine);
  assert.equal(lines[0].requestId,'1');assert.equal(lines[0].route,'/a');assert.equal(lines[1].requestId,'2');assert.equal(lines[1].route,'/b');
  assert.equal(parseDevLogLine('ordinary output').text,'ordinary output');assert.equal(parseDevLogLine('\x1ePRNEXT_DEV_LOG:invalid\x1ftext').text,'\x1ePRNEXT_DEV_LOG:invalid\x1ftext');
});
