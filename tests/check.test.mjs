import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

test('check validates existing Next projects without building and reports incompatible React or config', async () => {
  const f = await appFixture();
  const cli = path.join(repositoryRoot,'packages/rustyx/cli.mjs');
  const check = () => promisify(execFile)(process.execPath,[cli,'check',f.root,'--json']);
  try {
    const before = (await readdir(f.root)).sort();
    const packageBefore = await readFile(path.join(f.root,'package.json'),'utf8');
    const report = JSON.parse((await check()).stdout);
    assert.equal(report.ok,true); assert.ok(report.routes.some(route=>route.router==='app'));
    assert.deepEqual((await readdir(f.root)).sort(),before);
    assert.equal(await readFile(path.join(f.root,'package.json'),'utf8'),packageBefore);
    const reactFile = path.join(f.root,'node_modules/react/package.json');
    const react = await readFile(reactFile,'utf8');
    await writeFile(reactFile,JSON.stringify({...JSON.parse(react),version:'19.0.0'}));
    await assert.rejects(check(),error=>{const result=JSON.parse(error.stdout);assert.equal(result.ok,false);assert.match(result.errors[0],/npm install --save-exact/);return error.code===1;});
    await writeFile(reactFile,react);
    await writeFile(path.join(f.root,'next.config.mjs'),"export default {webpack(config){return config}};");
    assert.equal(JSON.parse((await check()).stdout).ok,true);
    await writeFile(path.join(f.root,'next.config.mjs'),"export default {webpack(config){config.plugins.push({apply(){}});return config}};");
    const plugins=JSON.parse((await check()).stdout);
    assert.equal(plugins.ok,true);assert.ok(plugins.notes.some(note=>/plugin hooks are validated during compilation/.test(note)));
    await writeFile(path.join(f.root,'next.config.mjs'),"export default {webpack(config){config.plugins.push({});return config}};");
    await assert.rejects(check(),error=>{assert.match(JSON.parse(error.stdout).errors[0],/plugins must implement apply/);return error.code===1;});
  } finally {await f.remove();}
});
