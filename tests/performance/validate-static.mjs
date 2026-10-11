// Verify actual wire bytes; fetch transparently decompresses and cannot be used
// for the precompressed identity control.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [base,htmlFile,gzipFile,route='/pages-static']=process.argv.slice(2);
const html=await readFile(htmlFile),gzip=gzipFile==='-'?null:await readFile(gzipFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function request(method,headers){return new Promise((resolve,reject)=>{
  const req=http.request(base+'/'+route.replace(/^\//,''),{method,headers},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
    res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
  });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('timeout')));req.end();
});}
const identity=await request('GET',{'accept-encoding':'identity'});
assert.equal(identity.status,200);assert.deepEqual(identity.bytes,html);
if(gzip){const compressed=await request('GET',{'accept-encoding':'gzip'});
assert.equal(compressed.status,200);assert.equal(compressed.headers['content-encoding'],'gzip');assert.deepEqual(compressed.bytes,gzip);}
const excluded=await request('GET',{'accept-encoding':'gzip;q=0, identity;q=1'});assert.deepEqual(excluded.bytes,html);
const head=await request('HEAD',{'accept-encoding':gzip?'gzip':'identity'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers['content-length']),(gzip||html).length);
const range=await request('GET',{'accept-encoding':'identity',range:'bytes=0-15'});assert.equal(range.status,206);assert.deepEqual(range.bytes,html.subarray(0,16));
assert.ok(identity.headers['last-modified']);
const validated=await request('GET',{'accept-encoding':'identity','if-modified-since':identity.headers['last-modified']});assert.equal(validated.status,304);assert.equal(validated.bytes.length,0);
// PRNext's file service validates mtime; it need not invent an ETag merely to
// match Nginx's default headers. Test a tag as well when the server emits one.
if(identity.headers.etag){const tagged=await request('GET',{'accept-encoding':'identity','if-none-match':identity.headers.etag});assert.equal(tagged.status,304);assert.equal(tagged.bytes.length,0);}
const ifRange=await request('GET',{'accept-encoding':'identity',range:'bytes=0-15','if-range':'"not-current"'});assert.equal(ifRange.status,200);assert.deepEqual(ifRange.bytes,html);
console.log(JSON.stringify({route,checks:6+Number(Boolean(gzip))+Number(Boolean(identity.headers.etag)),etagPresent:Boolean(identity.headers.etag),htmlSha256:hash(html),gzipSha256:gzip?hash(gzip):null,htmlBytes:html.length,gzipBytes:gzip?.length||null}));
