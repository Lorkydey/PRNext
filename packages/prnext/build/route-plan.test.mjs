import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from './index.mjs';

test('production route scaffold supports immutable plans while development stays mutable', async () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(repository, '.prnext-route-plan-'));
  assert.equal(path.dirname(root), path.resolve(repository));
  try {
    const files = {
      'app/layout.jsx': `export const dynamic='force-dynamic';export default function Layout({children,team}){return <html><body>{children}{team}</body></html>}`,
      'app/page.jsx': `export default function Page(){return <h1>Main</h1>}`,
      'app/@team/default.jsx': `export default function Team(){return <aside>Team</aside>}`,
    };
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    for (const dev of [false, true]) {
      const manifest = await build(root, { dev });
      const route = manifest.routes.find(item => item.pattern === '/');
      const source = `import assert from 'node:assert/strict';
        import {appRoutePlan} from ${JSON.stringify(new URL('../runtime/app-route-plan.mjs', import.meta.url).href)};
        const entry=await import(${JSON.stringify(pathToFileURL(path.join(manifest.outputDirectory, route.module)).href)});
        assert.equal(Object.isFrozen(entry.routing),${!dev});
        assert.equal(Object.isFrozen(entry.routing.children),${!dev});
        assert.equal(Object.isFrozen(entry.routing.slots),${!dev});
        assert.equal(Object.isFrozen(entry.routing.files),${!dev});
        assert.equal(Object.isFrozen(entry.routing.slots.team),${!dev});
        assert.equal(Object.isFrozen(entry.routing.config),false);
        assert.equal(Object.isFrozen(entry.routing.files.layout.default),false);
        const plan=appRoutePlan(entry.routing);
        assert.equal(!!plan,${!dev});
        entry.routing.config.layout.instant={unstable_disableValidation:true};
        assert.equal(entry.routing.config.layout.instant.unstable_disableValidation,true);
        ${dev ? "entry.routing.pattern='/changed';assert.equal(entry.routing.pattern,'/changed');" : 'assert.equal(appRoutePlan(entry.routing),plan);'}
      `;
      const result = await promisify(execFile)(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', source], { timeout: 10000 });
      assert.equal(result.stderr, '');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
