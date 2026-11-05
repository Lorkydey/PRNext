import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {npmReport,cargoReport,vendorPayload,vendorReport,queryVendorAdvisories,vendorComponents} from './security-audit.mjs';
import {ogComponents,reviewOgInputs,writeOgProvenance,verifyOgProvenance} from './og-provenance.mjs';
function npmInput(vulnerabilities={}){const counts={info:0,low:0,moderate:0,high:0,critical:0,total:Object.keys(vulnerabilities).length};for(const item of Object.values(vulnerabilities))counts[item.severity]++;return {auditReportVersion:2,vulnerabilities,metadata:{vulnerabilities:counts}};}

test('npm audit gates high and critical findings and strips unreviewed configuration/error fields',()=>{
  const report=npmReport({...npmInput({library:{severity:'high',via:[{source:123,severity:'high',url:'https://github.com/advisories/GHSA-1234-abcd-5678',title:'secret registry token',nodes:['C:/private/path']}],fixAvailable:true}}),private:'secret registry token'});
  assert.equal(report.passed,false);assert.equal(report.findings[0].advisories[0].id,'123');assert.ok(!JSON.stringify(report).includes('secret registry token'));assert.ok(!JSON.stringify(report).includes('private/path'));
  assert.equal(npmReport(npmInput({library:{severity:'moderate',via:[]}})).passed,true);
  assert.equal(npmReport(npmInput()).passed,true);
  assert.throws(()=>npmReport({...npmInput(),metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:1,critical:0,total:1}}}));
  for(const value of [{},{auditReportVersion:2,vulnerabilities:{},error:{summary:'secret'}},{auditReportVersion:2,vulnerabilities:[]},{auditReportVersion:2,vulnerabilities:{library:{severity:'unknown'}}}])assert.throws(()=>npmReport(value));
});

test('Cargo audit refuses incomplete reports and blocks all declared vulnerabilities',()=>{
  const report=cargoReport({vulnerabilities:{found:true,count:1,list:[{package:{name:'example',version:'1.2.3'},advisory:{id:'RUSTSEC-2026-1234',url:'https://rustsec.org/advisories/RUSTSEC-2026-1234.html',description:'private content'}}]}});
  assert.equal(report.passed,false);assert.ok(!JSON.stringify(report).includes('private content'));
  assert.equal(cargoReport({vulnerabilities:{found:false,count:0,list:[]}}).passed,true);
  for(const value of [{},{vulnerabilities:{found:true,count:1,list:[]}},{vulnerabilities:{found:false,count:1,list:[{}]}}])assert.throws(()=>cargoReport(value));
});

test('vendored audit submits every distinct embedded version and rejects unknown advisory severity',()=>{
  const payload=vendorPayload([{name:'fontkit',version:'2.0.4'},{name:'base64-js',version:'0.0.8'},{name:'base64-js',version:'1.5.1'},{name:'fontkit',version:'2.0.4'}]);
  assert.deepEqual(payload,{'base64-js':['0.0.8','1.5.1'],fontkit:['2.0.4']});
  assert.equal(vendorReport({},payload).passed,true);
  const report=vendorReport({fontkit:[{id:42,severity:'critical',url:'https://github.com/advisories/GHSA-test-test-test'}]},payload);
  assert.equal(report.passed,false);assert.deepEqual(report.findings[0].submittedVersions,['2.0.4']);
  assert.throws(()=>vendorReport({fontkit:[{id:42}]},payload));assert.throws(()=>vendorReport({unknown:[]},payload));
  assert.throws(()=>vendorPayload([{name:'fontkit',version:'latest'}]));assert.throws(()=>vendorPayload([]));
});

test('advisory service failures and malformed or oversized bodies cannot produce a clean result',async()=>{
  const payload={fontkit:['2.0.4']};let received;
  const report=await queryVendorAdvisories(payload,{fetcher:async(url,options)=>{received={url,options};return new Response('{}');}});
  assert.equal(report.passed,true);assert.equal(received.url,'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');assert.equal(received.options.redirect,'error');assert.deepEqual(JSON.parse(received.options.body),payload);assert.equal(Object.hasOwn(received.options.headers,'authorization'),false);
  for(const fetcher of [async()=>new Response('{}',{status:503}),async()=>new Response('not json'),async()=>new Response('x'.repeat(8*1024*1024+1)),async()=>{throw Error('unavailable');}])await assert.rejects(queryVendorAdvisories(payload,{fetcher}));
});

test('OG provenance guards inventory and upstream review before any renderer replacement',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-og-provenance-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const name of ['index.node.mjs','resvg.wasm','NOTICE.txt'])await writeFile(path.join(directory,name),'reviewed '+name);
  const inputs={sourceSha256:'reviewed',packages:{},components:[{name:'@vercel/og',version:'1.0.3'}]};
  await assert.rejects(reviewOgInputs(directory,inputs),/review-upstream/);
  await writeOgProvenance(directory,inputs);await reviewOgInputs(directory,inputs);
  assert.deepEqual(await verifyOgProvenance(directory),inputs.components);
  await assert.rejects(reviewOgInputs(directory,{...inputs,sourceSha256:'new'}),/review-upstream/);
  await reviewOgInputs(directory,{...inputs,sourceSha256:'new'},{reviewUpstream:true});
  await writeFile(path.join(directory,'index.node.mjs'),'modified');await assert.rejects(verifyOgProvenance(directory),/differ/);
  await mkdir(path.join(directory,'extra'));await assert.rejects(verifyOgProvenance(directory),/inventory/);
});

test('current reviewed renderer and vendor inventories cover actual embedded components',async()=>{
  const components=await vendorComponents(),payload=vendorPayload(components);
  for(const name of ['@vercel/og','@vercel/nft','fontkit','satori','@resvg/resvg-wasm','harfbuzzjs','fflate'])assert.ok(payload[name],name);
  assert.deepEqual(payload.fflate,['0.7.5'],'The removed upstream implementation must not appear as shipped');
  assert.deepEqual(payload['base64-js'],['0.0.8','1.5.1'],'OG and Fontkit embed different versions of this package');
  assert.throws(()=>ogComponents('changed upstream with no source inventory','0.7.5'),/Incomplete/);
});

test('failed audit CLI writes only a sanitized incomplete report and returns nonzero',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'prnext-audit-report-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=path.join(directory,'input.json'),output=path.join(directory,'output.json');
  await writeFile(input,JSON.stringify({error:{summary:'private-registry-token'}}));
  await assert.rejects(promisify(execFile)(process.execPath,[path.resolve('scripts/security-audit.mjs'),'npm',input,output]),error=>{assert.equal(error.code,2);assert.ok(!error.stderr.includes('private-registry-token'));return true;});
  const report=JSON.parse(await readFile(output,'utf8'));assert.equal(report.passed,false);assert.equal(report.incomplete,true);assert.ok(!JSON.stringify(report).includes('private-registry-token'));
});
