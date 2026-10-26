import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDevIssues, formatDevIssuesForAI, MAX_DEV_ISSUES, MAX_DEV_ISSUE_TEXT, MAX_DEV_SOURCE_BYTES, MAX_DEV_AI_REPORT_BYTES } from './dev-error-report.mjs';

test('current issues preserve original identity, ordering and distinct TypeScript diagnostics', () => {
  const critical = new Error('Application crashed'), recovered = new Error('Hydration recovered');
  const diagnostic = { name: 'TypeError', message: 'app/page.tsx(3,8): TS2322: wrong type', stack: 'Type checking frame' };
  const multiline = 'first.ts(1,1): first diagnostic\nsecond.ts(2,2): retained as one diagnostic';
  const result = collectDevIssues({ critical, criticalKind: 'build', typeErrors: [diagnostic, multiline, diagnostic, multiline], recoverable: recovered });
  assert.equal(result.omitted, 0);assert.equal(result.issues.length, 4);
  assert.deepEqual(result.issues.map(issue => [issue.kind, issue.recoverable]), [['build', false], ['typescript', false], ['typescript', false], ['recoverable', true]]);
  assert.equal(result.issues[0].id, 'critical');assert.equal(result.issues.at(-1).id, 'recoverable');
  assert.equal(result.issues[0].error, critical);assert.equal(result.issues[1].error, diagnostic);assert.equal(result.issues[2].error, multiline);assert.equal(result.issues.at(-1).error, recovered);
  assert.notEqual(result.issues[0].report, critical);assert.equal(result.issues[2].report.message, multiline);
  critical.message = 'Changed after capture';assert.equal(result.issues[0].report.message, 'Application crashed');
});

test('TypeScript IDs are content-stable across refresh, duplicate objects and reorder', () => {
  const first = collectDevIssues({ typeErrors: ['src/a.ts: private diagnostic', 'src/b.ts: another diagnostic'] }).issues;
  const second = collectDevIssues({ typeErrors: ['src/b.ts: another diagnostic', 'src/a.ts: private diagnostic'] }).issues;
  assert.equal(first[0].id, second[1].id);assert.equal(first[1].id, second[0].id);
  assert.match(first[0].id, /^ts-[a-z0-9]+$/);assert.doesNotMatch(first[0].id, /src|private|diagnostic/);
  const duplicate = collectDevIssues({ typeErrors: [{message:'Same error'}, {message:'Same error'}] });assert.equal(duplicate.issues.length, 1);
});

test('actual short-hash collisions resolve uniquely and consistently after reorder', () => {
  // These two distinct complete diagnostic keys share the FNV-1a32 hash3430704691.
  const a = 'Type diagnostic 22674', b = 'Type diagnostic 38749';
  const first = collectDevIssues({typeErrors:[a,b]}).issues, reversed = collectDevIssues({typeErrors:[b,a]}).issues;
  assert.notEqual(first[0].id, first[1].id);assert.equal(first[0].id, reversed[1].id);assert.equal(first[1].id, reversed[0].id);
  assert.equal(first[1].id, first[0].id + '-2');
});

test('list bounds preserve both critical and recovered issues and count only omitted unique types', () => {
  const typeErrors = Array.from({length:120}, (_,index) => 'Type issue ' + index % 60);
  const result = collectDevIssues({critical:'Critical issue',typeErrors,recoverable:'Recovered issue'});
  assert.equal(result.issues.length, MAX_DEV_ISSUES);assert.equal(result.omitted, 12);
  assert.equal(result.issues[0].id, 'critical');assert.equal(result.issues.at(-1).id, 'recoverable');
  assert.equal(result.issues.filter(issue => issue.kind === 'typescript').length, 48);
  assert.deepEqual(collectDevIssues(), {issues:[],omitted:0});
  assert.equal(collectDevIssues({critical:0,recoverable:''}).issues.length,2,'provided false-like errors are still diagnostic values');
});

test('diagnostic snapshots match the48KiB message/stack limit without splitting TypeScript input', () => {
  const message = 'Full recorded text\n' + 'x'.repeat(MAX_DEV_ISSUE_TEXT), stack = 'Actual error stack\n' + 'y'.repeat(MAX_DEV_ISSUE_TEXT);
  const original = {name:'SpecialError',message,stack}, result = collectDevIssues({critical:original});
  assert.equal(result.issues[0].error, original);assert.equal(result.issues[0].report.message, message.slice(0,MAX_DEV_ISSUE_TEXT));assert.equal(result.issues[0].report.stack, stack.slice(0,MAX_DEV_ISSUE_TEXT));
  assert.match(formatDevIssuesForAI(result.issues), /fields are limited to 48 KiB/);
  const prefix = 'x'.repeat(MAX_DEV_ISSUE_TEXT);
  assert.equal(collectDevIssues({typeErrors:[prefix+'first',prefix+'second']}).issues.length,2,'different full diagnostics must not be deduplicated after clipping');
});

test('AI report retains exact message, unique stack frames and actual mapped source', () => {
  const message = 'Cannot render component\nKeep this second line exactly.';
  const critical = {name:'RenderError',message,stack:'RenderError: '+message+'\n    at Widget (app/widget.tsx:12:8)\n    at Page (app/page.tsx:4:2)'};
  const {issues} = collectDevIssues({critical,typeErrors:['TS2322: Type string is not assignable to number.'],recoverable:{message:'Recovered hydration warning'}});
  const source = {file:'app/widget.tsx',line:12,column:8,frame:'11 | export function Widget() {\n12 |   throw new Error("broken");\n   |         ^',mapped:true};
  const text = formatDevIssuesForAI(issues,{route:'/lab?token=private#fragment',sourceById:new Map([['critical',source]])});
  assert.ok(text.startsWith('Fix all errors below.\n\nRoute: /lab'));
  assert.equal(text.split(message).length-1,1);assert.ok(text.includes('    at Widget (app/widget.tsx:12:8)'));
  assert.ok(text.includes('Source: app/widget.tsx:12:8\n'+source.frame));
  assert.ok(text.includes('1. runtime — RenderError'));assert.ok(text.includes('2. typescript — Error'));assert.ok(text.includes('3. recoverable — Error'));
  assert.doesNotMatch(text,/private|fragment|mapped|clientId|session/);
  assert.equal(formatDevIssuesForAI(issues,{sourceById:{critical:source}}).includes(source.frame),true);
});

test('AI report omits duplicated message-only stacks but retains genuinely different stack text', () => {
  for(const stack of ['Exact message','Error: Exact message']){
    const {issues} = collectDevIssues({critical:{name:'Error',message:'Exact message',stack}});
    const text = formatDevIssuesForAI(issues);assert.equal(text.split('Exact message').length-1,1);assert.doesNotMatch(text,/Stack:/);
  }
  const {issues} = collectDevIssues({critical:{message:'Original message',stack:'Independent trace\n    at caller (file.ts:2:2)'}});
  assert.ok(formatDevIssuesForAI(issues).includes('Stack:\nIndependent trace\n    at caller (file.ts:2:2)'));
});

test('only the route pathname is copied, with no origin, URL credentials, query or hash', () => {
  const {issues} = collectDevIssues({critical:'Known test error'});
  const text = formatDevIssuesForAI(issues,{route:'https://user:password@private.example:8443/docs/lab?api_key=private-secret#private-fragment'});
  assert.match(text,/Route: \/docs\/lab\n/);assert.doesNotMatch(text,/user|password|private|8443|https|api_key/);
  assert.match(formatDevIssuesForAI(issues,{route:'//secret.example/a?secret=1#fragment'}),/Route: \/a\n/);
  assert.match(formatDevIssuesForAI(issues,{route:'http://['}),/Route: \/\n/);
});

test('source frames are UTF-8 bounded with an explicit note and do not include unrelated source metadata', () => {
  const {issues} = collectDevIssues({critical:'Short error'}), source = {file:'app/page.tsx',line:2,column:3,frame:'😀'.repeat(MAX_DEV_SOURCE_BYTES),token:'never injected',session:'never injected'};
  const text = formatDevIssuesForAI(issues,{sourceById:new Map([['critical',source]])});
  assert.ok(text.includes('Source: app/page.tsx:2:3'));assert.ok(text.endsWith('[Source frame truncated at 48 KiB.]'));
  assert.ok(Buffer.byteLength(text.slice(text.indexOf('Source: ')))<=MAX_DEV_SOURCE_BYTES);assert.doesNotMatch(text,/never injected|token|session|�/);
});

test('global AI report stays below512KiB in UTF-8 with explicit truncation and omitted counts', () => {
  const {issues,omitted} = collectDevIssues({typeErrors:Array.from({length:100},(_,index)=>'TS'+index+': '+'😀'.repeat(20000))});
  const text = formatDevIssuesForAI(issues,{omitted});
  assert.ok(Buffer.byteLength(text)<=MAX_DEV_AI_REPORT_BYTES);assert.match(text,/Report truncated at 512 KiB/);assert.match(text,/\[\d+ additional current issues omitted\.\]/);
  assert.doesNotMatch(text,/�/);assert.ok(text.startsWith('Fix all errors below.'));
  const report = formatDevIssuesForAI(collectDevIssues({typeErrors:['One type error']}).issues,{omitted:1});assert.ok(report.endsWith('[1 additional current issue omitted.]'));
});

test('reports snapshot only diagnostic allowlisted fields without claiming secret sanitization', () => {
  const {issues} = collectDevIssues({critical:{name:'Error',message:'User logged token=already-recorded-secret',stack:'A distinct trace',token:'configuration-secret-not-injected',session:'session-not-injected',clientId:'client-not-injected'}});
  const text = formatDevIssuesForAI(issues);assert.ok(text.includes('token=already-recorded-secret'));assert.doesNotMatch(text,/configuration-secret-not-injected|session-not-injected|client-not-injected/);
  const hostile = { get message(){throw Error('Getter must not escape');}, get stack(){throw Error('Getter must not escape');}, toString(){throw Error('Coercion must not escape');} };
  assert.equal(collectDevIssues({critical:hostile}).issues[0].report.message,'[unavailable diagnostic]');
});
