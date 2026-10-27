import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevToolsClient } from './dev-tools-client.mjs';
import { durationLabel, materializeRoute, normalizeEntries, routeParameters, safeRequestPath, formatMcpConfig } from './dev-tools-model.mjs';

function environment(handler) {
  const events = new EventTarget(), calls = [], timeouts = new Map(), intervals = new Map(); let serial = 0;
  const target = { location: new URL('http://localhost:3017/account?token=private#secret'), crypto: { randomUUID: () => 'browser-test' },
    performance: { now: () => 125 }, document: { visibilityState: 'visible' },
    addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout(callback) { const id = ++serial; timeouts.set(id, callback); return id; }, clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback) { const id = ++serial; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); },
    async fetch(url, options) { calls.push({ url: String(url), options }); return handler?.(url, options) || { ok: true, status: 200, json: async () => ({ version: 1, session: 'test' }) }; },
  };
  return { target, calls, timeouts, intervals, async flush() { const callbacks = [...timeouts.values()]; timeouts.clear(); for (const callback of callbacks) callback(); await new Promise(resolve => setImmediate(resolve)); } };
}
const config = { version: 1, endpoint: 'http://127.0.0.1:49999', token: 'ephemeral', session: 'test' };

test('isolated replay browsers cannot send the development capability or start telemetry', async () => {
  const env=environment();env.target.__PRNEXT_REPLAY__=true;
  const tools=createDevToolsClient({target:env.target,config});
  await assert.rejects(tools.call('dev_snapshot'),/unavailable/);
  await env.flush();assert.equal(env.calls.length,0);assert.equal(env.intervals.size,0);
  assert.equal(tools.snapshot().available,false);tools.dispose();
});

test('route tools encode dynamic values and require only nonoptional parameters', () => {
  assert.deepEqual(routeParameters('/shop/[id]/[...parts]/[[...extra]]'), [
    { name: 'id', optional: false, catchAll: false }, { name: 'parts', optional: false, catchAll: true }, { name: 'extra', optional: true, catchAll: true },
  ]);
  assert.equal(materializeRoute('/shop/[id]/[[...extra]]', { id: 'a/b ?' }), '/shop/a%2Fb%20%3F/');
  assert.equal(materializeRoute('/docs/[...path]', { path: 'a/b c' }), '/docs/a/b%20c');
  assert.throws(() => materializeRoute('/[id]', {}), /Enter id/);
  assert.equal(safeRequestPath('/api/key?token=hidden#secret', 'http://localhost:3017/'), '/api/key');
  assert.equal(safeRequestPath('https://example.com/api?secret=x', 'http://localhost:3017/'), 'https://example.com/api');
  assert.equal(durationLabel(undefined), 'Not measured'); assert.equal(durationLabel(0), '0 ms');
});

test('Codex receives TOML with quoted Windows paths while Cursor and Claude receive JSON', () => {
  const server={command:'C:\\Program Files\\node.exe',args:['C:\\project\\cli.mjs','mcp','C:\\a "quoted" project'],env:{'WITH SPACE':'a\\b\nc'}};
  const toml=formatMcpConfig(server,'codex');assert.match(toml,/^\[mcp_servers\.prnext-dev\]/);assert.ok(toml.includes('command = '+JSON.stringify(server.command)));
  assert.ok(toml.includes('args = ['+server.args.map(JSON.stringify).join(', ')+']'));assert.ok(toml.includes('"WITH SPACE" = '+JSON.stringify(server.env['WITH SPACE'])));
  assert.deepEqual(JSON.parse(formatMcpConfig(server,'cursor')),{mcpServers:{'prnext-dev':{type:'stdio',...server}}});assert.deepEqual(JSON.parse(formatMcpConfig(server,'claude')),{mcpServers:{'prnext-dev':server}});
});

test('authenticated sidecar requests never appear in captured application network traffic', async () => {
  const env = environment(), tools = createDevToolsClient({ target: env.target, config });
  await tools.call('dev_routes', { path: '/test' });
  assert.equal(env.calls[0].url, config.endpoint + '/v1/tools/dev_routes');
  assert.equal(env.calls[0].options.headers.Authorization, 'Bearer ephemeral');
  assert.deepEqual(JSON.parse(env.calls[0].options.body), { path: '/test' });
  assert.equal(tools.snapshot().localRequests.length, 0);
  await env.target.fetch('/api/account?secret=hello', { method: 'POST', headers: { 'Private-Key': 'hidden' }, body: 'do not record' });
  const [record] = tools.snapshot().localRequests;
  assert.equal(record.path, '/api/account'); assert.equal(record.method, 'POST'); assert.equal(record.status, 200);
  assert.equal(JSON.stringify(record).includes('secret'), false); assert.equal(JSON.stringify(record).includes('hidden'), false); assert.equal(JSON.stringify(record).includes('do not record'), false);
  tools.dispose(); assert.equal(env.intervals.size, 0); assert.equal(env.timeouts.size, 0);
});

test('failed native fetch behavior is preserved and wrappers restore on disposal', async () => {
  const failure = new TypeError('connection failed'), env = environment(url => { if (!String(url).startsWith(config.endpoint)) throw failure; });
  const original = env.target.fetch, tools = createDevToolsClient({ target: env.target, config });
  await assert.rejects(env.target.fetch('/unreachable?password=x'), error => error === failure);
  const [record] = tools.snapshot().localRequests; assert.equal(record.failed, true); assert.equal(record.path, '/unreachable'); assert.equal(record.status, null);
  tools.dispose(); assert.equal(env.target.fetch, original);
});

test('only loopback endpoints receive capabilities and polling stops with its last watcher', async () => {
  const env = environment(), invalid = createDevToolsClient({ target: env.target, config: { ...config, endpoint: 'https://attacker.example' } });
  await assert.rejects(invalid.call('dev_snapshot'), /unavailable/); assert.equal(env.calls.length, 0); invalid.dispose();
  const tools = createDevToolsClient({ target: env.target, config });
  const stop = tools.watch(), stopAgain = tools.watch(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.intervals.size, 2); // heartbeat plus one shared panel poller
  stop();stop();assert.equal(env.intervals.size, 2); stopAgain(); assert.equal(env.intervals.size, 1);
  tools.dispose(); assert.equal(env.intervals.size, 0);
});

test('fresh builds report browser application despite retained historic console errors', async () => {
  const env = environment(); let sequence = 1;
  const capture = { snapshot: () => ({ entries: [{ id: 1, time: 10, level: 'error', text: 'Historic error' }], dropped: 0 }), subscribe: () => () => {} };
  const tools = createDevToolsClient({ target: env.target, config, capture, snapshot: () => ({ buildId: 'build-' + sequence, sequence, issues: 0, building: false, confirmed: true }) });
  await env.flush();
  const report = env.calls.find(call => call.url.endsWith('/v1/browser'));
  assert.equal(JSON.parse(report.options.body).kind, 'applied');
  assert.equal(JSON.parse(report.options.body).path, '/account');
  sequence = 2; env.target.dispatchEvent(new Event('prnext:refresh')); await env.flush();
  const reports = env.calls.filter(call => call.url.endsWith('/v1/browser')).map(call => JSON.parse(call.options.body));
  assert.equal(reports.at(-1).kind, 'applied'); assert.equal(reports.at(-1).sequence, 2);
  tools.dispose();
});

test('unified console preserves browser/server identity, ordering and detached capture context', async () => {
  const browser = [{ id: 1, time: 20, level: 'error', text: 'browser' }];
  assert.deepEqual(normalizeEntries({ serverLogs: [{ id: 1, time: 10, level: 'info', text: 'server' }] }, browser).map(entry => [entry.id, entry.source]), [['server:1', 'server'], ['browser:1', 'browser']]);
  const env = environment(() => ({ ok: true, json: async () => ({ serverLogs: [{ id: 4, time: 10, level: 'log', text: 'request' }] }) }));
  const capture = { snapshot: () => ({ entries: browser, dropped: 0 }), subscribe: () => () => {}, clear() { browser.length = 0; } };
  const tools = createDevToolsClient({ target: env.target, config, capture }); await tools.refresh();
  const preview = { snapshot: () => ({ entries: [{ id: 5, time: 30, level: 'log', text: 'preview' }], dropped: 0 }), subscribe: () => () => {} };
  assert.deepEqual(tools.captureFor(preview).snapshot().entries.map(entry => entry.text), ['request', 'preview']);
  assert.deepEqual(tools.consoleCapture.snapshot().entries.map(entry => entry.text), ['request', 'browser']);
  tools.consoleCapture.clear(); assert.deepEqual(tools.consoleCapture.snapshot().entries, []); tools.dispose();
});

test('browser evidence waits for a committed application and bridge reports remain bounded', async () => {
  const env = environment(); let confirmed = false;
  const entries = Array.from({ length: 100 }, (_, id) => ({ id, level: 'error', time: id + 1, text: 'long log '.repeat(16000) }));
  const capture = { snapshot: () => ({ entries, dropped: 0 }), subscribe: () => () => {} };
  const tools = createDevToolsClient({ target: env.target, config, capture, snapshot: () => ({ sequence: 1, buildId: 'initial', confirmed }) });
  await env.flush();
  const reports = () => env.calls.filter(call => call.url.endsWith('/v1/browser')).map(call => call.options.body);
  assert.equal(JSON.parse(reports()[0]).confirmed, false); assert.notEqual(JSON.parse(reports()[0]).kind, 'applied');
  assert.ok(Buffer.byteLength(reports()[0]) < 300 * 1024); assert.match(JSON.parse(reports()[0]).logs[0].text, /Truncated for the local AI bridge/);
  confirmed = true; env.target.dispatchEvent(new Event('prnext:devtools:ready')); await env.flush();
  assert.equal(JSON.parse(reports().at(-1)).kind, 'applied'); assert.equal(JSON.parse(reports().at(-1)).confirmed, true);
  tools.dispose();
});

test('XHR captures metadata without changing request bodies or retaining a reused internal request', async () => {
  const env=environment();
  class XHR extends EventTarget { open(method,url){this.method=method;this.url=url;}send(body){this.sent=body;this.status=201;queueMicrotask(()=>this.dispatchEvent(new Event('loadend')));} }
  env.target.XMLHttpRequest=XHR;const originalOpen=XHR.prototype.open,originalSend=XHR.prototype.send;
  const tools=createDevToolsClient({target:env.target,config});const request=new XHR();
  request.open('POST','/api/upload?token=private');request.send('private body');await new Promise(resolve=>setImmediate(resolve));
  const [record]=tools.snapshot().localRequests;assert.equal(record.kind,'xhr');assert.equal(record.path,'/api/upload');assert.equal(record.status,201);assert.equal(request.sent,'private body');assert.equal(JSON.stringify(record).includes('private'),false);
  request.open('GET',config.endpoint+'/v1/ignored');request.send();await new Promise(resolve=>setImmediate(resolve));assert.equal(tools.snapshot().localRequests.length,1);
  tools.dispose();assert.equal(XHR.prototype.open,originalOpen);assert.equal(XHR.prototype.send,originalSend);
});

test('sending context rechecks actual assistant activity and leaves disconnected drafts unsent',async()=>{
  let connected=false;
  const env=environment(url=>({ok:true,status:200,json:async()=>String(url).endsWith('/dev_snapshot')?{ai:{connected}}:{queued:true,connected:true}}));
  const tools=createDevToolsClient({target:env.target,config}),context={kind:'element',tag:'button'};tools.setContext(context);
  await assert.rejects(tools.sendContext(context,'Keep this draft'),/Connect your assistant/);
  assert.equal(env.calls.some(call=>call.url.endsWith('/dev_ai_context')),false);assert.equal(tools.snapshot().context,context);
  connected=true;await tools.refresh();assert.equal(tools.snapshot().ai.connected,true);
  connected=false;await assert.rejects(tools.sendContext(context,'Keep this draft'),/Connect your assistant/);
  assert.equal(env.calls.some(call=>call.url.endsWith('/dev_ai_context')),false);assert.equal(tools.snapshot().context.sent,undefined);
  connected=true;await tools.sendContext(context,'Keep this draft');assert.equal(tools.snapshot().context.sent,true);
  assert.equal(env.calls.filter(call=>call.url.endsWith('/dev_ai_context')).length,1);tools.dispose();
});

test('assistant rejection preserves local transport and does not mark context as sent',async()=>{
  let rejected=true;
  const env=environment(url=>String(url).endsWith('/dev_snapshot')?{ok:true,status:200,json:async()=>({ai:{connected:true}})}:
    rejected?{ok:false,status:409,json:async()=>({error:'Connect your assistant first.',code:'assistant_required'})}:{ok:true,status:200,json:async()=>({queued:true,connected:false})});
  const tools=createDevToolsClient({target:env.target,config}),context={kind:'element',tag:'button'};tools.setContext(context);
  await assert.rejects(tools.sendContext(context,'Preserve this request'),/Connect your assistant first/);
  assert.equal(tools.snapshot().connection,'connected');assert.equal(tools.snapshot().ai.connected,false);assert.equal(tools.snapshot().context.sent,undefined);
  rejected=false;await assert.rejects(tools.sendContext(context,'Preserve this request'),/no longer connected/);
  assert.equal(tools.snapshot().context.sent,undefined);tools.dispose();
});

test('a completed context submission cannot replace a newer selection or error',async()=>{
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),sending=new Promise(resolve=>{started=resolve;});
  const env=environment(async url=>{
    if(String(url).endsWith('/dev_snapshot'))return{ok:true,status:200,json:async()=>({ai:{connected:true}})};
    started();await gate;return{ok:true,status:200,json:async()=>({queued:true,connected:true})};
  });
  const tools=createDevToolsClient({target:env.target,config}),first={kind:'element',tag:'button'},latest={kind:'error',text:'New error'};tools.setContext(first);
  const submitted=tools.sendContext(first,'Fix the button');await sending;tools.setContext(latest);release();await submitted;
  assert.equal(tools.snapshot().context,latest);assert.equal(tools.snapshot().context.sent,undefined);tools.dispose();
});
