import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const releaseNpmVersion = '11.21.0';
export const releaseNpmIntegrity = 'sha512-Zov8KhamNneiLdELtj5YALtNmJW4L4fCLTzjfpzXG2w6MSHcf0UxgdlK5uloCuksWT+7mGUU7wi79cO6RqivPg==';
const tarball = 'https://registry.npmjs.org/npm/-/npm-11.21.0.tgz';
const execute = promisify(execFile);

export function toolingEnvironment(parent, directory) {
  const env = {...parent};
  for (const key of Object.keys(env)) {
    if (/^(?:npm_|NPM_|NODE_AUTH_TOKEN$|NODE_OPTIONS$|NODE_PATH$|ACTIONS_ID_TOKEN_REQUEST_|INIT_CWD$)/i.test(key) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    npm_config_userconfig: path.join(directory, 'empty-user.npmrc'),
    npm_config_globalconfig: path.join(directory, 'empty-global.npmrc'),
    npm_config_cache: path.join(directory, 'cache'),
    npm_config_registry: 'https://registry.npmjs.org/',
  });
  return env;
}

export async function installReleaseNpm() {
  assert.ok(process.env.RUNNER_TEMP, 'A dedicated runner temporary directory is required');
  const parent = await realpath(process.env.RUNNER_TEMP);
  const directory = await mkdtemp(path.join(parent, 'release-npm-'));
  await Promise.all(['empty-user.npmrc','empty-global.npmrc'].map(name => writeFile(path.join(directory,name),'',{flag:'wx'})));
  const response = await fetch(tarball, {redirect:'error',signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);
  const chunks=[]; let size=0;
  for await (const chunk of response.body) {
    size += chunk.length; assert.ok(size <= 16 * 1024 ** 2, 'Oversized npm distribution'); chunks.push(chunk);
  }
  const bytes=Buffer.concat(chunks);
  assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),releaseNpmIntegrity,'npm distribution integrity mismatch');
  const archive=path.join(directory,'npm.tgz');
  await writeFile(archive,bytes,{flag:'wx'});
  const binaries=path.dirname(process.execPath);
  const candidates=[path.join(binaries,'node_modules/npm/bin/npm-cli.js'),path.resolve(binaries,'../lib/node_modules/npm/bin/npm-cli.js')];
  let bundled;
  for(const candidate of candidates) { try { await access(candidate); bundled=candidate; break; } catch(error) { if(error.code!=='ENOENT')throw error; } }
  assert.ok(bundled,'The Node distribution must contain npm');
  const prefix=path.join(directory,'client');
  await mkdir(prefix);
  const env=toolingEnvironment(process.env,directory);
  await execute(process.execPath,[bundled,'install','--prefix',prefix,'--global=false','--workspaces=false','--ignore-scripts','--no-audit','--no-fund','--no-package-lock',archive],{cwd:directory,env,windowsHide:true,timeout:120000,maxBuffer:1024**2});
  const manifest=JSON.parse(await readFile(path.join(prefix,'node_modules/npm/package.json'),'utf8'));
  assert.equal(manifest.version,releaseNpmVersion);
  const cli=await realpath(path.join(prefix,'node_modules/npm/bin/npm-cli.js'));
  const relative=path.relative(prefix,cli);
  assert.ok(relative && !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep));
  const result=await execute(process.execPath,[cli,'--version'],{cwd:directory,env,windowsHide:true,timeout:15000,maxBuffer:65536});
  assert.equal(result.stdout.trim(),releaseNpmVersion);
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'npm_cli='+cli+'\n');
  console.log('Verified npm '+releaseNpmVersion+' supports publication and distribution tags.');
  return {version:releaseNpmVersion,cli,integrity:releaseNpmIntegrity};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await installReleaseNpm();
