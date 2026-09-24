import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProjectConfig, validateProjectConfig, defineEnvironment, generateBuildId } from './config.mjs';
import { loadEnvConfig } from '../runtime/env.mjs';
import { build } from './index.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, run) {
  const root = await mkdtemp(path.join(repo, '.rustyx-config-test-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{}');
    for (const [name, value] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), value);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    // Also clears values loaded by the last configuration in this process.
    loadEnvConfig(root);
  }
}

test('supports both config names and all four extensions, phase constants, TS types and async functions', async () => {
  for (const prefix of ['next', 'rustyx']) for (const extension of ['js', 'mjs', 'cjs', 'ts']) {
    const source = extension === 'js' || extension === 'cjs'
      ? `const {PHASE_DEVELOPMENT_SERVER}=require('next/constants');module.exports=async(phase,{defaultConfig})=>({...defaultConfig,env:{PHASE:phase,MATCH:String(phase===PHASE_DEVELOPMENT_SERVER)}});`
      : `${extension === 'ts' ? "import type {NextConfig} from 'next';" : ''}import {PHASE_DEVELOPMENT_SERVER} from 'rustyx/constants';export default async(phase${extension === 'ts' ? ':string' : ''},{defaultConfig})=>({...defaultConfig,env:{PHASE:phase,MATCH:String(phase===PHASE_DEVELOPMENT_SERVER)}});`;
    await fixture({ [`${prefix}.config.${extension}`]: source }, async root => {
      const development = await loadProjectConfig(root, { dev: true });
      assert.equal(development.env.PHASE, 'phase-development-server');
      assert.equal(development.env.MATCH, 'true');
      const production = await loadProjectConfig(root);
      assert.equal(production.env.PHASE, 'phase-production-build');
      assert.equal(production.env.MATCH, 'false');
      assert.equal(production.compress, true);
    });
  }
});

test('config reads loaded env and refreshed relative helpers with original module paths', async () => {
  await fixture({
    '.env': 'RUSTYX_CONFIG_TEST_PRIVATE=private-first',
    'helper/nested.mjs': `export const value='first';export const location=import.meta.url;`,
    'next.config.mjs': `import {value,location} from './helper/nested.mjs';export default {env:{VALUE:value,LOCATION:location,PRIVATE_EXPOSED:process.env.RUSTYX_CONFIG_TEST_PRIVATE,FILE:__filename,DIR:__dirname}};`,
  }, async root => {
    const first = await loadProjectConfig(root);
    assert.equal(first.env.VALUE, 'first');
    assert.equal(first.env.PRIVATE_EXPOSED, 'private-first');
    assert.equal(first.env.LOCATION, pathToFileURL(path.join(root, 'helper/nested.mjs')).href);
    assert.equal(first.env.FILE, path.join(root, 'next.config.mjs'));
    assert.equal(first.env.DIR, root);
    await writeFile(path.join(root, 'helper/nested.mjs'), `export const value='second';export const location=import.meta.url;`);
    await writeFile(path.join(root, '.env'), 'RUSTYX_CONFIG_TEST_PRIVATE=private-second');
    const second = await loadProjectConfig(root);
    assert.equal(second.env.VALUE, 'second');
    assert.equal(second.env.PRIVATE_EXPOSED, 'private-second');
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.rustyx-config-')), []);
  });
});

test('accepts Contentlayer page-retention hints and rejects invalid onDemandEntries values', () => {
  const input = { onDemandEntries: { maxInactiveAge: 3600000 } };
  assert.deepEqual(validateProjectConfig(input).onDemandEntries, {maxInactiveAge:3600000,pagesBufferLength:5});
  assert.deepEqual(input.onDemandEntries, {maxInactiveAge:3600000});
  assert.deepEqual(validateProjectConfig({onDemandEntries:{maxInactiveAge:0,pagesBufferLength:0}}).onDemandEntries, {maxInactiveAge:0,pagesBufferLength:0});
  for (const value of [null, false, [], {other:2}, {maxInactiveAge:-1}, {maxInactiveAge:Infinity}, {pagesBufferLength:1.5}, {pagesBufferLength:'5'}]) {
    assert.throws(() => validateProjectConfig({onDemandEntries:value}), /onDemandEntries/);
  }
});

test('undefined optional config and image fields retain defaults in wrapped Next configurations', () => {
  const config = validateProjectConfig({basePath:undefined,compress:undefined,output:undefined,experimental:undefined,images:{unoptimized:undefined,remotePatterns:undefined}});
  assert.equal(config.basePath, '');
  assert.equal(config.compress, true);
  assert.equal(config.images.unoptimized, false);
  assert.deepEqual(config.images.remotePatterns, []);
  assert.throws(() => validateProjectConfig({basePath:null}), /basePath/);
  assert.throws(() => validateProjectConfig({images:{unoptimized:null}}), /unoptimized/);
});

test('rejects conflicting config files, unsupported options, unsafe env and invalid build IDs', async () => {
  await fixture({ 'next.config.js': 'module.exports={}', 'rustyx.config.ts': 'export default {}' }, root => assert.rejects(loadProjectConfig(root), /Multiple configuration files/));
  await fixture({ 'next.config.mts': 'export default {}' }, root => assert.rejects(loadProjectConfig(root), /Unsupported configuration file/));
  for (const key of ['basePath', 'assetPrefix', 'webpack', 'experimental', 'images', 'i18n', 'output']) assert.throws(() => validateProjectConfig({ [key]: false }), new RegExp(key));
  for (const key of ['NODE_ENV', '__PRIVATE', 'NEXT_RUNTIME', 'RUSTYX_CACHE_TOKEN']) assert.throws(() => validateProjectConfig({ env: { [key]: 'bad' } }), /reserved/);
  assert.throws(() => validateProjectConfig({ compress: 0 }), /boolean/);
  assert.throws(() => validateProjectConfig({ env: { NUMBER: 42 } }), /string/);
  assert.throws(() => validateProjectConfig({ headers: [] }), /function/);
  assert.equal(await generateBuildId({ generateBuildId: async () => 'release_123' }), 'release_123');
  for (const value of ['', undefined, '../bad', 'a/b', 42]) await assert.rejects(generateBuildId({ generateBuildId: () => value }), /generateBuildId/);
  assert.notEqual(await generateBuildId({ generateBuildId: () => null }), '');
  assert.deepEqual(defineEnvironment({ env: { NEXT_PUBLIC_SHARED: 'config', EXPOSED: 'yes' } }, { NEXT_PUBLIC_SHARED: 'file', PRIVATE: 'secret' }), { 'process.env.NEXT_PUBLIC_SHARED': '"config"', 'process.env.EXPOSED': '"yes"' });
});

test('programmatic builds isolate environment across projects, concurrent calls and failed configurations', async () => {
  const files = value => ({
    '.env': `CONFIG_TEST_ISOLATED=${value}`,
    'pages/index.jsx': `export function getStaticProps(){return {props:{label:process.env.CONFIG_TEST_ISOLATED}}}export default function Page({label}){return <p>{label}</p>}`,
  });
  await fixture(files('first-project'), async first => {
    await fixture(files('second-project'), async second => {
      const before = process.env.CONFIG_TEST_ISOLATED;
      const results = await Promise.all([build(first), build(second)]);
      assert.match(await readFile(path.join(results[0].outputDirectory, results[0].prerendered[0].file), 'utf8'), /first-project/);
      assert.match(await readFile(path.join(results[1].outputDirectory, results[1].prerendered[0].file), 'utf8'), /second-project/);
      assert.equal(process.env.CONFIG_TEST_ISOLATED, before);
      await writeFile(path.join(first, 'next.config.mjs'), 'export default {trailingSlash:123}');
      await assert.rejects(build(first), /trailingSlash/);
      assert.equal(process.env.CONFIG_TEST_ISOLATED, before);
    });
  });
});

test('build normalizes external npm execution mode while test env file selection and caller mode survive', async () => {
  await fixture({
    '.env.development': 'CONFIG_TEST_MODE=development-file',
    '.env.production': 'CONFIG_TEST_MODE=production-file',
    '.env.local': 'CONFIG_TEST_LOCAL=local-file',
    '.env.test': 'CONFIG_TEST_MODE=test-file',
    'node_modules/config-test-mode/package.json': '{"name":"config-test-mode","main":"index.cjs"}',
    'node_modules/config-test-mode/index.cjs': `exports.read=()=>({mode:process.env.NODE_ENV,selected:process.env.CONFIG_TEST_MODE,local:process.env.CONFIG_TEST_LOCAL||'absent'});`,
    'pages/index.jsx': `import {read} from 'config-test-mode';export function getStaticProps(){return {props:read()}}export default function Page({mode,selected,local}){return <p>{mode+':'+selected+':'+local}</p>}`,
  }, async root => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const dev = await build(root, { dev: true });
      assert.match(await readFile(path.join(dev.outputDirectory, dev.prerendered[0].file), 'utf8'), /development:development-file:local-file/);
      assert.equal(process.env.NODE_ENV, 'production');
      process.env.NODE_ENV = 'test';
      const production = await build(root);
      assert.match(await readFile(path.join(production.outputDirectory, production.prerendered[0].file), 'utf8'), /production:test-file:absent/);
      assert.equal(process.env.NODE_ENV, 'test');
      await promisify(execFile)(process.execPath, [path.join(repo, 'packages/rustyx/cli.mjs'), 'build', root, '--dev'], { env: { ...process.env, NODE_ENV: 'test' } });
      const cli = JSON.parse(await readFile(path.join(root, '.rustyx/manifest.json'), 'utf8'));
      assert.match(await readFile(path.join(root, '.rustyx', cli.prerendered[0].file), 'utf8'), /development:test-file:absent/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

test('build freezes public/config env on both graphs, emits source maps, hides private env and separates cache IDs', async () => {
  await fixture({
    '.env': 'NEXT_PUBLIC_CONFIG_TEST=public-first\nRUSTYX_CONFIG_TEST_PRIVATE=private-secret-marker',
    'next.config.ts': `import type {NextConfig} from 'next';export default {env:{CONFIG_TEST_EXPOSED:'from-config'},generateBuildId:async()=> 'fixed-release',compress:false,poweredByHeader:false,productionBrowserSourceMaps:true} satisfies NextConfig;`,
    'pages/index.jsx': `export function getServerSideProps(){return {props:{public:process.env.NEXT_PUBLIC_CONFIG_TEST,exposed:process.env.CONFIG_TEST_EXPOSED,private:process.env.RUSTYX_CONFIG_TEST_PRIVATE}}}export default function Page(){return <p>{process.env.NEXT_PUBLIC_CONFIG_TEST}:{process.env.CONFIG_TEST_EXPOSED}</p>}`,
    'app/check/layout.jsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
    'app/check/page.jsx': `export const dynamic='force-dynamic';export default function Page(){return <p>{process.env.NEXT_PUBLIC_CONFIG_TEST}:{process.env.CONFIG_TEST_EXPOSED}</p>}`,
  }, async root => {
    const first = await build(root);
    assert.equal(first.buildId, 'fixed-release');
    assert.deepEqual(Object.fromEntries(['compress', 'poweredByHeader', 'basePath', 'assetPrefix', 'assetBase'].map(key => [key, first.config[key]])), { compress: false, poweredByHeader: false, basePath: '', assetPrefix: '', assetBase: '/_rustyx/assets' });
    assert.equal(first.config.cacheComponents, false);
    assert.equal(first.config.cacheLife.default.revalidate, 900);
    const assets = await readdir(path.join(first.outputDirectory, 'assets'));
    assert.ok(assets.some(file => file.endsWith('.map')));
    assert.ok(!assets.some(file => file.endsWith('.gz')));
    const browser = (await Promise.all(assets.filter(file => file.endsWith('.js')).map(file => readFile(path.join(first.outputDirectory, 'assets', file), 'utf8')))).join('\n');
    assert.match(browser, /public-first/);
    assert.match(browser, /from-config/);
    assert.doesNotMatch(browser, /private-secret-marker/);
    assert.doesNotMatch(await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8'), /private-secret-marker|NEXT_PUBLIC_CONFIG_TEST|CONFIG_TEST_EXPOSED/);
    const page = first.routes.find(route => route.pattern === '/');
    const module = await import(pathToFileURL(path.join(first.outputDirectory, page.module)).href);
    process.env.NEXT_PUBLIC_CONFIG_TEST = 'runtime-change';
    const result = module.getServerSideProps();
    assert.equal(result.props.public, 'public-first');
    assert.equal(result.props.exposed, 'from-config');
    assert.equal(result.props.private, undefined, 'build must restore the caller environment before a native child server starts');
    delete process.env.NEXT_PUBLIC_CONFIG_TEST;
    await writeFile(path.join(root, '.env'), 'NEXT_PUBLIC_CONFIG_TEST=public-second\nRUSTYX_CONFIG_TEST_PRIVATE=private-second');
    const second = await build(root);
    assert.equal(second.buildId, first.buildId);
    assert.notEqual(second.cacheId, first.cacheId);
  });
});


test('normalization options are explicit booleans and the Proxy alias overrides the legacy option', () => {
  const defaults = validateProjectConfig({});
  assert.equal(defaults.trailingSlash, false);
  assert.equal(defaults.skipTrailingSlashRedirect, false);
  assert.equal(defaults.skipMiddlewareUrlNormalize, false);
  assert.equal(validateProjectConfig({ skipMiddlewareUrlNormalize: true, skipProxyUrlNormalize: false }).skipMiddlewareUrlNormalize, false);
  for (const key of ['trailingSlash', 'skipTrailingSlashRedirect', 'skipMiddlewareUrlNormalize', 'skipProxyUrlNormalize']) {
    assert.equal(validateProjectConfig({ [key]: true })[key], true);
    assert.throws(() => validateProjectConfig({ [key]: 'true' }), /boolean/);
  }
});
