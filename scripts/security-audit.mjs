import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {verifyVendoredFontkit} from '../packages/prnext/release/fontkit.mjs';
import {verifyVendoredNft} from './vendor-nft.mjs';
import {verifyOgProvenance} from './og-provenance.mjs';
import {isMainModule} from './main-module.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const severities=new Set(['info','low','moderate','high','critical']);
const packageName=value=>typeof value==='string'&&/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value)&&value.length<=214;
const severity=value=>{if(!severities.has(value))throw Error('Advisory severity is missing or unsupported.');return value;};
const blocking=value=>value==='high'||value==='critical';
const advisoryUrl=value=>typeof value==='string'&&/^https:\/\/(?:github\.com\/advisories\/|rustsec\.org\/advisories\/|npmjs\.com\/advisories\/)[A-Za-z0-9./_-]+$/.test(value)?value:undefined;
const advisoryId=value=>typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='string'&&/^[\w-]{1,80}$/.test(value)?value:undefined;
function result(kind,findings){return {schemaVersion:1,kind,passed:!findings.some(item=>item.blocking),findings};}

// Only reviewed fields enter artifacts. Raw npm/Cargo output may contain local
// paths or registry errors; credentials and arbitrary error text are discarded.
export function npmReport(input){
  if(input?.auditReportVersion!==2||input.error||!input.vulnerabilities||typeof input.vulnerabilities!=='object'||Array.isArray(input.vulnerabilities))throw Error('npm audit did not return a complete v2 report.');
  const counts=input.metadata?.vulnerabilities;
  if(!counts||![...severities,'total'].every(name=>Number.isSafeInteger(counts[name])&&counts[name]>=0)||[...severities].reduce((sum,name)=>sum+counts[name],0)!==counts.total||counts.total!==Object.keys(input.vulnerabilities).length)throw Error('npm audit returned inconsistent vulnerability counts.');
  const findings=[];
  for(const [name,item]of Object.entries(input.vulnerabilities)){
    if(!packageName(name))throw Error('Invalid package in npm audit report.');
    const level=severity(item.severity);
    if(!Array.isArray(item.via))throw Error('npm audit advisory details are missing.');
    findings.push({package:name,severity:level,blocking:blocking(level),advisories:(item.via||[]).filter(value=>value&&typeof value==='object').map(value=>({id:advisoryId(value.source),url:advisoryUrl(value.url)}))});
  }
  return result('npm',findings);
}
export function cargoReport(input){
  if(input?.error||typeof input?.vulnerabilities?.found!=='boolean'||!Number.isSafeInteger(input.vulnerabilities.count)||!Array.isArray(input.vulnerabilities.list)||input.vulnerabilities.count!==input.vulnerabilities.list.length||input.vulnerabilities.found!==(input.vulnerabilities.count>0))throw Error('Cargo audit did not return a complete report.');
  const report=result('cargo',input.vulnerabilities.list.map(item=>{
    if(!packageName(item.package?.name)||!advisoryId(item.advisory?.id))throw Error('Invalid Cargo advisory.');
    return {package:item.package.name,version:item.package.version,id:advisoryId(item.advisory.id),url:advisoryUrl(item.advisory.url)||`https://rustsec.org/advisories/${item.advisory.id}.html`,blocking:true};
  }));
  report.notices=Object.entries(input.warnings||{}).flatMap(([kind,items])=>{
    if(!/^[a-z-]{1,40}$/.test(kind)||!Array.isArray(items))throw Error('Invalid Cargo audit warning.');
    return items.map(item=>{if(!packageName(item.package?.name))throw Error('Invalid Cargo audit warning package.');return{kind,package:item.package.name,version:item.package.version,id:advisoryId(item.advisory?.id)};});
  });
  return report;
}
export function vendorPayload(components){
  const versions=new Map();
  if(!Array.isArray(components)||!components.length||components.length>256)throw Error('Incomplete vendor component inventory.');
  for(const {name,version}of components){
    if(!packageName(name)||typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))throw Error('Invalid vendor component.');
    let values=versions.get(name);if(!values)versions.set(name,values=new Set());values.add(version);
  }
  return Object.fromEntries([...versions].sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,values])=>[name,[...values].sort()]));
}
export function vendorReport(input,payload){
  if(!input||typeof input!=='object'||Array.isArray(input)||input.error)throw Error('Vendor advisory registry did not return a complete report.');
  const findings=[];
  for(const [name,advisories]of Object.entries(input)){
    if(!Object.hasOwn(payload,name)||!Array.isArray(advisories))throw Error('Unexpected vendor advisory response.');
    for(const advisory of advisories){
      const level=severity(advisory?.severity);
      if(!advisoryId(advisory.id))throw Error('Invalid vendor advisory identifier.');
      findings.push({package:name,submittedVersions:payload[name],severity:level,id:advisoryId(advisory.id),url:advisoryUrl(advisory.url),blocking:blocking(level)});
    }
  }
  return result('vendored',findings);
}
export async function queryVendorAdvisories(payload,{fetcher=fetch}={}){
  const response=await fetcher('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  if(!response.ok){await response.body?.cancel();throw Error('Vendor advisory registry is unavailable.');}
  const reader=response.body?.getReader();if(!reader)throw Error('Vendor advisory registry returned no body.');
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)throw Error('Vendor advisory response exceeds its size limit.');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  let input;try{input=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw Error('Vendor advisory registry returned invalid JSON.');}
  return vendorReport(input,payload);
}
export async function vendorComponents(){
  await verifyVendoredFontkit();await verifyVendoredNft();
  const fontkit=JSON.parse(await readFile(path.join(root,'packages/prnext/vendor/fontkit/upstream.json'),'utf8'));
  const nft=JSON.parse(await readFile(path.join(root,'packages/prnext/vendor/nft/upstream.json'),'utf8'));
  return [...Object.entries(fontkit.packages).map(([name,item])=>({name,version:item.version})),{name:nft.name,version:nft.version},...await verifyOgProvenance(path.join(root,'packages/prnext/runtime/og'))];
}
if(isMainModule(import.meta.url)){
  const [kind,input,output]=process.argv.slice(2);
  if(!['npm','cargo','vendored'].includes(kind)||!input||!output||process.argv.length!==5)throw Error('Use security-audit.mjs npm|cargo <input.json> <report.json>, or vendored --live <report.json>.');
  try{
    const report=kind==='vendored'?(input==='--live'?await queryVendorAdvisories(vendorPayload(await vendorComponents())):(()=>{throw Error('Vendor audits require --live.');})()):({npm:npmReport,cargo:cargoReport}[kind])(JSON.parse(await readFile(input,'utf8')));
    if(process.env.AUDIT_EXIT_CODE!==undefined&&report.passed&&process.env.AUDIT_EXIT_CODE!=='0')throw Error('Auditor exit status is inconsistent with its report.');
    await writeFile(output,JSON.stringify(report,null,2)+'\n');
    console.log(`${kind}: ${report.findings.length} advisory finding(s); ${report.passed?'passed':'blocked'}. Review the sanitized report artifact.`);
    if(!report.passed)process.exitCode=1;
  }catch{
    await writeFile(output,JSON.stringify({schemaVersion:1,kind,passed:false,incomplete:true,message:'Audit could not complete. Check service availability and rerun; no clean security result was produced.'},null,2)+'\n');
    console.error(`${kind}: audit incomplete. Check service availability and tool compatibility; raw transport/configuration errors are not logged.`);process.exitCode=2;
  }
}
