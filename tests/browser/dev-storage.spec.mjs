import {test, expect} from '@playwright/test';
import {readFile, readdir, access} from 'node:fs/promises';
import path from 'node:path';
import {devFixture, counterSource} from '../dev-fixture.mjs';

test('development records worker ownership and retires old snapshots while preserving refresh state', async ({page}) => {
  test.setTimeout(90_000);
  const f = await devFixture();
  try {
    await page.goto(f.url + '/docs/pages');
    await page.waitForFunction(() => window.__PRNEXT_DEV__?.confirmed === true);
    await page.getByTestId('counter').click();
    const state = JSON.parse(await f.read('.prnext-dev.json'));
    const home = path.join(f.root, '.prnext-dev', state.session);
    const owner = () => readFile(path.join(home, '.owner.json'), 'utf8').then(JSON.parse);
    await expect.poll(async () => (await owner()).pending.length).toBe(0);
    const record = await owner();
    expect(record.pid).toBe(f.child.pid); expect(record.eligible).toBe(true);
    expect(record.children.length).toBeGreaterThanOrEqual(4);
    expect(record.children.every(value => Number.isSafeInteger(value) && value > 0)).toBe(true);
    await expect(access(path.join(home, '.recovery-disabled'))).rejects.toThrow();
    for (let i = 0; i < 5; i++) {
      await f.write('components/Counter.jsx', counterSource('Storage' + i));
      await expect(page.getByTestId('counter')).toHaveText('Storage' + i + ' 1', {timeout: 20_000});
      await page.waitForFunction(() => window.__PRNEXT_DEV__?.confirmed === true);
    }
    await expect.poll(async () => (await readdir(home)).filter(name => /^[a-f\d-]{36}$/.test(name)).length).toBeLessThanOrEqual(3);
    await expect.poll(async () => (await owner()).pending.length).toBe(0);
    expect((await owner()).eligible).toBe(true);
  } finally {await f.close();}
});
