import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditMigration, compareServers } from './migration-audit.mjs';
import { parseMigrationArgs } from './migrate.mjs';

test('migration audit locates unsupported imports, accepts type imports, and leaves sources untouched', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pages'));
  const pkg = '{"name":"audit-app","scripts":{"dev":"next dev","build":"next build","start":"next start"}}';
  await writeFile(path.join(root, 'package.json'), pkg);
  await writeFile(path.join(root, 'pages/index.tsx'), `import type {NextPage} from 'next';\nimport Link from 'next/link';\nimport hidden from 'next/dist/unsupported';\nexport default function Page(){return <Link href="/">Hello</Link>}`);
  const report = await auditMigration(root);
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.filter(item => item.id === 'unsupported-import').map(({file,line}) => ({file,line})), [{file:'pages/index.tsx',line:3}]);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), pkg);
  assert.deepEqual((await readdir(root)).sort(), ['package.json', 'pages']);
  await writeFile(path.join(root, 'pages/index.tsx'), `import type {NextPage} from 'next'; export default function Page(){return <p>Hello</p>}`);
  assert.equal((await auditMigration(root)).ok, true);
  assert.equal(parseMigrationArgs(['--check',root,'--against','http://localhost:1','--candidate','http://localhost:2']).options.check, true);
  assert.throws(() => parseMigrationArgs(['--against','http://localhost']), /requires/);
});

test('server comparison reports changed pages, JSON, redirects and failures without following redirects', async t => {
  const servers = [];
  t.after(() => Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))));
  async function server(candidate) {
    const instance = createServer((req,res) => {
      if (req.url === '/json') {res.setHeader('content-type','application/json');res.end(candidate ? '{"b":2,"a":1}' : '{"a":1,"b":2}');}
      else if (req.url === '/redirect') {res.writeHead(307,{location:'/json'});res.end();}
      else {res.setHeader('content-type','text/html');res.end(`<html><script>${candidate ? 'prnext' : 'next'}</script><h1>${req.url === '/changed' && candidate ? 'Different' : 'Same'}</h1></html>`);}
    });
    await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve)); servers.push(instance);
    return `http://127.0.0.1:${instance.address().port}`;
  }
  const against=await server(false), candidate=await server(true);
  const report=await compareServers({against,candidate,routes:['/','/json','/redirect','/changed']});
  assert.deepEqual(report.results.map(value=>value.equal),[true,true,true,false]);
  assert.deepEqual(report.results[3].differences,['bodySha256']);
  await assert.rejects(compareServers({against,candidate,routes:['//external.test']}),/local URL/);
  assert.equal((await compareServers({against,candidate:'http://127.0.0.1:1',routes:['/']})).ok,false);
});
