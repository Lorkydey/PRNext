import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from './index.mjs';
import { scanProject } from './scan.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.prnext-global-error-build-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    return await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const layout = `export default({children})=><html><body>{children}</body></html>`;
const globalError = `'use client';export default function GlobalError({error,reset,retry}){return <html><body><h1>{error.message}</h1><button onClick={reset}>Reset</button><button onClick={retry}>Retry</button></body></html>}`;

test('global-error is a root-only non-route convention shared across multiple root layouts', async () => {
  await fixture({
    'src/app/global-error.tsx': globalError,
    'src/app/(one)/layout.tsx': layout,
    'src/app/(one)/page.tsx': 'export default()=> <p>One</p>',
    'src/app/(one)/global-error.tsx': 'THIS_NESTED_FILE_MUST_NOT_BE_PARSED',
    'src/app/(two)/layout.tsx': layout,
    'src/app/(two)/other/page.tsx': 'export default()=> <p>Two</p>',
    'src/app/(two)/other/global-error.tsx': 'THIS_NESTED_FILE_MUST_NOT_BE_PARSED',
    'src/app/health/route.ts': 'export const GET=()=>new Response("ok")',
  }, async root => {
    const project = await scanProject(root);
    assert.equal(project.appGlobalError, path.join(root, 'src/app/global-error.tsx'));
    assert.deepEqual(project.routes.map(route => route.pattern).sort(), ['/', '/health', '/other']);
    assert.ok(project.routes.every(route => !route.segments?.some(segment => 'globalError' in segment)));
    const manifest = await build(root, { dev: true });
    const descriptor = manifest.app.globalError;
    assert.ok(descriptor.id); assert.deepEqual(descriptor.css, []);
    assert.equal(descriptor.name, 'default');
    for (const route of manifest.routes.filter(route => route.kind === 'page')) {
      const source = `import * as entry from ${JSON.stringify(pathToFileURL(path.join(manifest.outputDirectory, route.module)).href)};console.log(entry.GlobalError.$$id)`;
      const result = await execute(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', source], { cwd: root });
      assert.equal(result.stdout.trim(), `${descriptor.id}#default`);
    }
    const handler = manifest.routes.find(route => route.kind === 'api');
    const namespace = await import(pathToFileURL(path.join(manifest.outputDirectory, handler.module)).href);
    assert.equal(namespace.GlobalError, undefined);
    await writeFile(path.join(root, 'src/app/global-error.js'), globalError);
    await assert.rejects(scanProject(root), /Multiple global-error/);
  });
});

test('global-error gets Flight, SSR and browser modules with CSS isolated from layout styles', async () => {
  await fixture({
    'app/layout.jsx': `import './layout.css';import './shared.css';${layout}`,
    'app/page.jsx': `import 'server-only';const secret='GLOBAL_ERROR_SERVER_SECRET';export default()=> <p>{secret}</p>`,
    'app/global-error.jsx': `'use client';import './fallback.css';import './shared.css';import styles from './fallback.module.css';export default function GlobalError({error}){return <html><body className={styles.fallback}><h1>GLOBAL_ERROR_BROWSER_COMPONENT {error.message}</h1></body></html>}`,
    'app/layout.css': 'body{--layout-exclusive:yes;color:purple}',
    'app/shared.css': 'body{--shared-style:yes}',
    'app/fallback.css': 'body{--fallback-exclusive:yes;color:orange}',
    'app/fallback.module.css': '.fallback{--fallback-module:yes;background:beige}',
  }, async root => {
    const manifest = await build(root, { dev: true });
    const metadata = manifest.app.globalError;
    const reference = manifest.app.clientModules[metadata.id];
    assert.ok(reference.browserModule); assert.ok(reference.ssrModule);
    assert.equal(typeof (await import(pathToFileURL(path.join(manifest.outputDirectory, reference.ssrModule)).href)).default, 'function');
    const readStyles = urls => Promise.all(urls.map(url => readFile(path.join(manifest.outputDirectory, 'assets', path.basename(url)), 'utf8'))).then(parts => parts.join('\n'));
    const fallback = await readStyles(metadata.css);
    assert.match(fallback, /fallback-exclusive/); assert.match(fallback, /fallback-module/); assert.match(fallback, /shared-style/);
    assert.doesNotMatch(fallback, /layout-exclusive/);
    const route = manifest.routes.find(route => route.pattern === '/');
    const normal = await readStyles(route.css);
    assert.match(normal, /layout-exclusive/); assert.match(normal, /shared-style/);
    assert.doesNotMatch(normal, /fallback-exclusive|fallback-module/);
    const runtime = await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(route.client)), 'utf8');
    assert.ok(runtime.includes(metadata.id)); assert.ok(runtime.includes(metadata.css[0]));
    const browser = (await Promise.all((await readdir(path.join(manifest.outputDirectory, 'assets'))).filter(name => name.endsWith('.js')).map(name => readFile(path.join(manifest.outputDirectory, 'assets', name), 'utf8')))).join('\n');
    assert.match(browser, /GLOBAL_ERROR_BROWSER_COMPONENT/);
    assert.doesNotMatch(browser, /GLOBAL_ERROR_SERVER_SECRET/);
  });
});

test('global-error requires its own client directive while metadata exports are ignored', async () => {
  await fixture({ 'app/layout.jsx': layout, 'app/page.jsx': 'export default()=>null', 'app/global-error.jsx': globalError }, async root => {
    const first = await build(root, { dev: true });
    for (const source of [globalError.replace("'use client';", ''), `export {default} from './client-error'`]) {
      await writeFile(path.join(root, 'app/client-error.jsx'), globalError);
      await writeFile(path.join(root, 'app/global-error.jsx'), source);
      await assert.rejects(build(root, { dev: true }), /global-error must be a Client Component/);
      assert.equal(JSON.parse(await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8')).cacheId, first.cacheId);
    }
    await writeFile(path.join(root, 'app/global-error.jsx'), globalError + ';export const metadata={title:"IGNORED_GLOBAL_METADATA"};export function generateMetadata(){throw Error("GLOBAL_METADATA_MUST_NOT_EXECUTE")}');
    const accepted = await build(root, { dev: true });
    assert.deepEqual(Object.keys(accepted.app.globalError).sort(), ['css', 'id', 'name']);
    assert.doesNotMatch(JSON.stringify(accepted), /IGNORED_GLOBAL_METADATA|GLOBAL_METADATA_MUST_NOT_EXECUTE/);
  });
});

test('global-error uses the same module and CSS identity through a symlinked project', async () => {
  await fixture({
    'project/app/layout.jsx': `import './layout.css';${layout}`,
    'project/app/page.jsx': 'export default()=> <p>Page without a global-error import</p>',
    'project/app/layout.css': 'body{--normal-symlink-style:yes}',
    'project/app/global-error.jsx': `'use client';import './global.css';${globalError.replace("'use client';", '')}`,
    'project/app/global.css': 'body{--global-symlink-style:yes}',
  }, async root => {
    const linked = path.join(root, 'linked-project');
    await symlink(path.join(root, 'project'), linked, 'dir');
    const manifest = await build(linked, { dev: true });
    const metadata = manifest.app.globalError;
    const reference = manifest.app.clientModules[metadata.id];
    assert.ok(reference, 'globalError.id must identify an actual client module');
    const route = manifest.routes.find(route => route.pattern === '/');
    const runtime = await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(route.client)), 'utf8');
    const importer = runtime.match(new RegExp(`"${metadata.id}":\\s*\\(\\)\\s*=>\\s*import\\("([^\"]+)"\\)`));
    assert.ok(importer, 'bootstrap must be able to import the declared global-error module');
    assert.equal(path.basename(importer[1]), path.basename(reference.browserModule));
    const styles = (await Promise.all(metadata.css.map(url => readFile(path.join(manifest.outputDirectory, 'assets', path.basename(url)), 'utf8')))).join('\n');
    assert.match(styles, /global-symlink-style/);
    assert.doesNotMatch(styles, /normal-symlink-style/);
    const normalStyles = (await Promise.all(route.css.map(url => readFile(path.join(manifest.outputDirectory, 'assets', path.basename(url)), 'utf8')))).join('\n');
    assert.match(normalStyles, /normal-symlink-style/);
    assert.doesNotMatch(normalStyles, /global-symlink-style/);
  });
});

test('global-error isolates browser-only lazy CSS while preserving styles shared with normal pages', async () => {
  await fixture({
    'project/app/layout.jsx': layout,
    'project/app/page.jsx': `'use client';import dynamic from 'next/dynamic';const Widget=dynamic(()=>import('./page-widget'),{ssr:false});export default()=> <Widget/>`,
    'project/app/page-widget.jsx': `import './normal.css';import './shared.css';import shared from './shared.module.css';export default()=> <p className={shared.label}>Normal browser widget</p>`,
    'project/app/normal.css': 'body{--normal-lazy-exclusive:yes}',
    'project/app/global-error.jsx': `'use client';import dynamic from 'next/dynamic';const Widget=dynamic(()=>import('./error-widget'),{ssr:false});export default()=> <html><body><Widget/></body></html>`,
    'project/app/error-widget.jsx': `import './fallback.css';import './shared.css';import styles from './fallback.module.css';import shared from './shared.module.css';export default()=> <p className={styles.error+' '+shared.label}>Fallback browser widget</p>`,
    'project/app/fallback.css': 'body{--fallback-lazy-exclusive:yes}',
    'project/app/fallback.module.css': '.error{--fallback-lazy-module:yes}',
    'project/app/shared.css': 'body{--shared-lazy-style:yes}',
    'project/app/shared.module.css': '.label{--shared-lazy-module:yes}',
  }, async root => {
    const linked = path.join(root, 'linked-project');
    await symlink(path.join(root, 'project'), linked, 'dir');
    const manifest = await build(linked, { dev: true });
    const readStyles = async urls => (await Promise.all(urls.map(url => readFile(path.join(manifest.outputDirectory, 'assets', path.basename(url)), 'utf8')))).join('\n');
    const fallback = await readStyles(manifest.app.globalError.css);
    assert.match(fallback, /fallback-lazy-exclusive/);
    assert.match(fallback, /fallback-lazy-module/);
    assert.match(fallback, /shared-lazy-style/);
    assert.match(fallback, /shared-lazy-module/);
    assert.doesNotMatch(fallback, /normal-lazy-exclusive/);
    const normal = await readStyles(manifest.routes.find(route => route.pattern === '/').css);
    assert.match(normal, /normal-lazy-exclusive/);
    assert.match(normal, /shared-lazy-style/);
    assert.match(normal, /shared-lazy-module/);
    assert.doesNotMatch(normal, /fallback-lazy-exclusive|fallback-lazy-module/);
    const mapping = css => css.match(/\.([\w-]+)\s*\{\s*--shared-lazy-module:/)?.[1];
    assert.ok(mapping(fallback));
    assert.equal(mapping(fallback), mapping(normal), 'shared CSS Modules retain identical class names in both documents');
  });
});
