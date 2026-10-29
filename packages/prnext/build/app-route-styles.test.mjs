import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';
import { tryDevCssUpdate } from './dev-css-update.mjs';
import { snapshotDevelopmentBuild } from '../runtime/development.mjs';

test('App CSS is scoped to page/layout graphs, including client-only chunks, Edge and isolated global errors', async t => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(repository, '.prnext-route-css-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': '{"type":"module"}',
    'app/layout.jsx': `import './base.css';export default({children})=><html><body>{children}</body></html>`,
    'app/base.css': 'body{--root-layout:1;font-family:system-ui}',
    'app/work/layout.jsx': `import './shared.css';export default({children})=><section>{children}</section>`,
    'app/work/shared.css': 'section{--work-layout:1}',
    'app/work/a/page.jsx': `import './page.css';import Client from './client';export default()=> <main><Client/></main>`,
    'app/work/a/page.css': 'main{--page-a:1;color:rgb(1,2,3)}',
    'app/work/a/client.jsx': `'use client';import dynamic from 'next/dynamic';import styles from './client.module.css';const Lazy=dynamic(()=>import('./lazy'),{ssr:false});export default()=> <div className={styles.box}><Lazy/></div>`,
    'app/work/a/client.module.css': '.box{--client-a:1}',
    'app/work/a/lazy.jsx': `import './lazy.css';export default()=> <p>Lazy</p>`,
    'app/work/a/lazy.css': 'p{--lazy-client-a:1}',
    'app/work/b/page.jsx': `import './heavy.css';export default()=> <main>B</main>`,
    'app/work/b/heavy.css': Array.from({length:800}, (_, index) => `.unused-b-${index}{--private-page-b:${index};color:rgb(${index%255},12,34)}`).join(''),
    'app/edge/page.jsx': `import './edge.css';export const runtime='edge';export default()=> <main>Edge</main>`,
    'app/edge/edge.css': 'main{--page-edge:1}',
    'app/global-error.jsx': `'use client';import './global-error.css';export default()=> <html><body>Fatal</body></html>`,
    'app/global-error.css': 'body{--fatal-only:1}',
  };
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive:true });
    await writeFile(path.join(root, name), source);
  }
  for (const dev of [false, true]) {
    const built = await build(root, { dev });
    const routes = new Map(built.routes.map(route => [route.pattern, route]));
    const css = async route => (await Promise.all(route.css.map(url => readFile(path.join(built.outputDirectory, 'assets', path.basename(url)), 'utf8')))).join('\n');
    const a = routes.get('/work/a'), b = routes.get('/work/b'), edge = routes.get('/edge');
    assert.equal(a.css[0], b.css[0], 'root layout stylesheet is reused');
    assert.equal(a.css[0], edge.css[0], 'Node and Edge routes share the same root stylesheet');
    assert.equal(a.css[1], b.css[1], 'nested layout stylesheet is reused');
    const text = await css(a);
    for (const sentinel of ['--root-layout', '--work-layout', '--page-a', '--client-a', '--lazy-client-a']) assert.ok(text.includes(sentinel), sentinel);
    assert.doesNotMatch(text, /--private-page-b|--page-edge|--fatal-only/);
    assert.doesNotMatch(await css(b), /--page-a|--client-a|--lazy-client-a|--fatal-only/);
    assert.match(await css(edge), /--page-edge/);
    assert.match(await css(built.app.globalError), /--fatal-only/);
    const allStyles = new Set([...routes.values()].flatMap(route => route.css));
    const allBytes = (await Promise.all([...allStyles].map(url => readFile(path.join(built.outputDirectory, 'assets', path.basename(url)))))).reduce((total, data) => total + data.length, 0);
    assert.ok(Buffer.byteLength(text) < allBytes / 10, 'a small route does not download the large sibling stylesheet');
    if (dev) {
      await writeFile(path.join(root, 'app/work/a/page.css'), 'main{--page-a:2;color:rgb(4,5,6)}');
      const updated = await tryDevCssUpdate({ root, source: built.outputDirectory, destination: path.join(root, '.prnext-style-update'), manifest: built, changed: ['app/work/a/page.css'], sequence:2, snapshot:snapshotDevelopmentBuild });
      // A project-wide global-error CSS override intentionally takes the safe
      // complete-build path, rather than publishing incomplete error styles.
      assert.equal(updated, undefined);
    }
  }
});
