import test from 'node:test';
import assert from 'node:assert/strict';
import {productionDiagnostics} from './production-check.mjs';
import {validateProjectConfig} from './config.mjs';
const app={routes:[{router:'app'}]},pages={routes:[{router:'pages'}]};
const check=(input={},project=app,env={})=>productionDiagnostics(validateProjectConfig(input),project,{env});
test('production checks distinguish static hosting, public origins and explicit proxy trust',()=>{
  const missing=check();assert.ok(missing.some(item=>item.code==='production-origin'&&item.severity==='warning'&&item.path==='server.publicOrigin'));
  const staticReport=check({output:'export'});assert.ok(staticReport.some(item=>item.code==='production-static'));assert.ok(!staticReport.some(item=>item.code==='production-origin'));
  assert.ok(check({server:{publicOrigin:'http://example.test'}}).some(item=>item.code==='production-origin-https'));
  for(const publicOrigin of ['https://example.test','http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000'])assert.ok(!check({server:{publicOrigin}}).some(item=>item.code==='production-origin-https'));
  const broad=check({server:{trustedProxies:['0.0.0.0/0','::/0']}});assert.ok(broad.some(item=>item.code==='production-proxy-range'&&item.severity==='error'));
  for(const range of ['127.0.0.1/0','2001:db8::1/0','::ffff:127.0.0.1/96'])assert.ok(check({server:{trustedProxies:[range]}}).some(item=>item.code==='production-proxy-range'&&item.severity==='error'));
  assert.ok(!check({server:{trustedProxies:['127.0.0.1','::1']}}).some(item=>item.severity==='error'));
});
test('authentication guidance never guesses cookies or requires sessions on public Pages/static apps',()=>{
  for(const navigationCache of [{}, {authCookies:[]}])assert.ok(check({navigationCache}).some(item=>item.code==='production-auth-cookies'&&item.severity==='warning'));
  for(const [input,project] of [[{navigationCache:false},app],[{},pages],[{output:'export'},app]])assert.ok(!check(input,project).some(item=>item.code==='production-auth-cookies'));
  const configured=check({navigationCache:{authCookies:['session','__Secure-session']}}).find(item=>item.code==='production-auth-cookies');
  assert.equal(configured.severity,'info');assert.match(configured.action,/account A.*account B/);
  assert.ok(check({experimental:{serverActions:{allowedOrigins:['**.example.test']}}}).some(item=>item.code==='production-action-origins'));
});
test('only active opt-ins are flagged and diagnostics identify their configuration paths',()=>{
  assert.ok(!check().some(item=>item.code==='production-experimental'));
  const report=check({experimental:{nextScriptWorkers:true,lazyDynamicImports:true,streamingRequestBodies:true,parallelBuilds:true,nativePprShell:true},cacheComponents:true,partialPrefetching:true,reactCompiler:{backend:'oxc'},productionBrowserSourceMaps:true},app,{PRNEXT_SSR_STREAM:'node'});
  assert.deepEqual(report.filter(item=>item.code==='production-experimental').map(item=>item.path).sort(),['experimental.lazyDynamicImports','experimental.nativePprShell','experimental.nextScriptWorkers','experimental.parallelBuilds','experimental.streamingRequestBodies','partialPrefetching','reactCompiler.backend','PRNEXT_SSR_STREAM'].sort());
  assert.ok(report.some(item=>item.code==='production-source-maps'));
  assert.ok(report.every(item=>typeof item.code==='string'&&typeof item.path==='string'&&typeof item.action==='string'||item.severity==='info'));
});
