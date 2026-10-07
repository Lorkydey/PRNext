import test from 'node:test';
import { binary, freePort } from '../../../tests/support.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { createStyleProcessor } from './styles.mjs';
import { shouldWatchProjectFile } from '../runtime/env.mjs';
import { stylesFixture } from '../../../tests/styles-fixture.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(t, files) {
  const root = await mkdtemp(path.join(repository, '.prnext-styles-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ 'package.json': '{"type":"module"}', ...files })) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  return root;
}

test('PostCSS resolves named plugins, disabled entries and fresh local configuration helpers', async t => {
  const root = await fixture(t, {
    'postcss.config.mjs': `import options from './options.js';export default {plugins:[['missing-disabled-plugin',false],['autoprefixer',options]]}`,
    'options.js': `export default {overrideBrowserslist:['Safari 8']}`,
    'style.css': '.item { user-select: none }',
  });
  const file = path.join(root, 'style.css');
  assert.match((await createStyleProcessor({ projectRoot: root }).process(file)).css, /-webkit-user-select/);
  await writeFile(path.join(root, 'options.js'), `export default {overrideBrowserslist:['Chrome 140']}`);
  assert.doesNotMatch((await createStyleProcessor({ projectRoot: root }).process(file)).css, /-webkit-user-select/);
});

test('PostCSS rejects invalid configuration and missing plugins with actionable errors', async t => {
  const root = await fixture(t, { 'style.css': '.item{color:red}', '.postcssrc.json': '{"plugins":{"missing-style-plugin":{}}}' });
  const file = path.join(root, 'style.css');
  await assert.rejects(createStyleProcessor({ projectRoot: root }).process(file), /missing-style-plugin.*missing from the application/);
  await writeFile(path.join(root, '.postcssrc.json'), '{"plugins":{"autoprefixer":null}}');
  await assert.rejects(createStyleProcessor({ projectRoot: root }).process(file), /PostCSS plugins/);
  await writeFile(path.join(root, 'postcss.config.mjs'), 'export default ()=>({plugins:[]})');
  await assert.rejects(createStyleProcessor({ projectRoot: root }).process(file), /Multiple PostCSS/);
  await rm(path.join(root, '.postcssrc.json'));
  await assert.rejects(createStyleProcessor({ projectRoot: root }).process(file), /configuration functions/);
});

test('default PostCSS follows the project Browserslist and a custom configuration replaces defaults', async t => {
  const root = await fixture(t, {
    'package.json': '{"type":"module","browserslist":["Safari 8"]}',
    'style.css': '.item{user-select:none}',
  });
  const file = path.join(root, 'style.css');
  assert.match((await createStyleProcessor({ projectRoot: root }).process(file)).css, /-webkit-user-select/);
  await writeFile(path.join(root, 'postcss.config.json'), '{"plugins":[]}');
  assert.doesNotMatch((await createStyleProcessor({ projectRoot: root }).process(file)).css, /-webkit-user-select/);
});

test('Sass uses package imports, additional data, ICSS exports and source maps to rebase partial assets', async t => {
  const root = await fixture(t, {
    'postcss.config.json': '{"plugins":[]}',
    'styles/card.module.scss': '@use "pkg-sass/theme";@use "parts/image";.card{color:$injected}:export{tone:$injected}',
    'styles/parts/_image.scss': '.picture {background-image:url("./tile.svg");}',
    'styles/parts/tile.svg': '<svg/>',
    'node_modules/pkg-sass/package.json': '{"name":"pkg-sass"}',
    'node_modules/pkg-sass/_theme.scss': '.package {font-weight:700}',
  });
  const result = await createStyleProcessor({ projectRoot: root, sassOptions: { additionalData: async source => '$injected: #123456;\n' + source } }).process(path.join(root, 'styles/card.module.scss'));
  assert.match(result.css, /\.package/);
  assert.match(result.css, /\.card\s*\{\s*color: #123456/);
  assert.match(result.css, /url\("\.\/parts\/tile.svg"\)/);
  assert.doesNotMatch(result.css, /:export/);
  assert.equal(result.exports.tone, '#123456');
  assert.ok(result.watchFiles.includes(path.join(root, 'styles/parts/_image.scss')));
});

test('hidden PostCSS and Browserslist configuration changes trigger development rebuilds', () => {
  for (const file of ['.postcssrc', '.postcssrc.json', '.postcssrc.cjs', '.postcssrc.mjs', '.browserslistrc', 'postcss.config.mjs', 'styles/_tokens.scss', 'styles/card.module.sass']) assert.equal(shouldWatchProjectFile(file), true, file);
  for (const file of ['node_modules/tool/.postcssrc', '.git/config', '.prnext-postcss-tmp.mjs']) assert.equal(shouldWatchProjectFile(file), false, file);
});

test('CLI dev rebuilds hidden PostCSS configuration and imported Sass partials', { timeout: 60_000 }, async t => {
  const root = await fixture(t, {
    '.postcssrc.json': '{"plugins":{"autoprefixer":{"overrideBrowserslist":["Safari 8"]}}}',
    'pages/index.jsx': `import '../styles/global.scss';export default function Page(){return <p>Styles</p>}`,
    'styles/global.scss': '@use "tokens";.item{color:tokens.$color;user-select:none}',
    'styles/_tokens.scss': '$color:rgb(12,34,56);',
  });
  const child = spawn(process.execPath, [path.join(repository, 'packages/prnext/cli.mjs'), 'dev', root, '--port', String(await freePort())], {
    env: { ...process.env, PRNEXT_BINARY: binary, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  async function waitForCss(count, matches) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) assert.fail(`dev exited: ${output}`);
      if (output.split('Source compiled.').length - 1 >= count) {
        const assets = path.join(root, '.prnext/assets');
        const files = (await readdir(assets)).filter(file => file.endsWith('.css'));
        const css = (await Promise.all(files.map(file => readFile(path.join(assets, file), 'utf8')))).join('\n');
        if (matches(css)) return;
      }
      await delay(40);
    }
    assert.fail(`dev did not rebuild styles: ${output}`);
  }
  try {
    await waitForCss(1, css => css.includes('-webkit-user-select') && /rgb\(12, 34, 56\)/.test(css));
    await writeFile(path.join(root, '.postcssrc.json'), '{"plugins":[]}');
    await waitForCss(2, css => !css.includes('-webkit-user-select'));
    await writeFile(path.join(root, 'styles/_tokens.scss'), '$color:rgb(98,76,54);');
    await waitForCss(3, css => /rgb\(98, 76, 54\)/.test(css));
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 6000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
    }
  }
});

test('Sass missing dependencies and failing additionalData produce useful build errors', async t => {
  const root = await fixture(t, {
    'node_modules/sass/package.json': '{"name":"sass","exports":{}}',
    'style.scss': '.item{color:red}',
  });
  const file = path.join(root, 'style.scss');
  await assert.rejects(createStyleProcessor({ projectRoot: root }).process(file), /requires sass.*Install it/);
  await rm(path.join(root, 'node_modules'), { recursive: true });
  await assert.rejects(createStyleProcessor({ projectRoot: root, sassOptions: { additionalData: () => undefined } }).process(file), /must return a string/);
});

test('Pages and App compile real Tailwind, PostCSS and both Sass syntaxes with shared SSR/browser class maps', async t => {
  const fixture = await stylesFixture();
  t.after(fixture.remove);
  const result = await fixture.build();
  const files = await readdir(path.join(result.outputDirectory, 'assets'));
  const contents = async suffix => (await Promise.all(files.filter(file => file.endsWith(suffix)).map(file => readFile(path.join(result.outputDirectory, 'assets', file), 'utf8')))).join('\n');
  const css = await contents('.css'), javascript = await contents('.js');
  assert.match(css, /\.p-4\{/);
  assert.match(css, /\.font-bold\{/);
  assert.match(css, /-webkit-user-select/);
  assert.match(css, /letter-spacing:1px/);
  assert.match(css, /text-decoration-line:underline/);
  assert.match(css, /\/resources\/_prnext\/assets\/dot-[\w-]+\.svg/);
  assert.ok(files.some(file => /^dot-[\w-]+\.svg$/.test(file)));
  const pages = result.routes.find(route => route.pattern === '/pages');
  const prerendered = result.prerendered.find(page => page.routeId === pages.id || page.pattern === '/pages' || page.path === '/pages');
  const html = await readFile(path.join(result.outputDirectory, prerendered.file), 'utf8');
  const classes = /data-testid="styled" class="([^"]+)"/.exec(html)[1].split(' ').filter(name => !['p-4', 'font-bold', 'postcss-global'].includes(name));
  for (const className of classes) { assert.ok(css.includes('.' + className), className); assert.ok(javascript.includes(className), className); }
  assert.match(html, /color:rgb\(12, 34, 56\)/);
  assert.doesNotMatch(javascript, /compileStringAsync|postcssPlugin|loadConfiguration/);
});
