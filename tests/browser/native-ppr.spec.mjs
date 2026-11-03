import {test, expect} from '@playwright/test';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {partialFixture} from '../partial-fixture.mjs';
import {startServer} from '../support.mjs';

test('native public shells hydrate once and retain client state across a real Server Action and refresh', async ({page}) => {
  test.setTimeout(120000);
  const fixture = await partialFixture();
  let server;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  try {
    await writeFile(path.join(fixture.root, 'prnext.config.mjs'), 'export default {cacheComponents:true,experimental:{nativePprShell:true}}');
    const layout = path.join(fixture.root, 'app/layout.jsx');
    await writeFile(layout, "import './native-ppr.css';" + await readFile(layout, 'utf8'));
    await writeFile(path.join(fixture.root, 'app/native-ppr.css'), '[data-testid="shell"]{color:rgb(23,99,177)}');
    await fixture.build();
    server = await startServer(fixture.root);
    const response = await page.goto(server.url);
    expect(response.headers()['x-prnext-native-ppr']).toBe('1');
    await expect(page.getByTestId('personal')).toHaveText('guest');
    await expect(page.getByTestId('shell')).toHaveCSS('color', 'rgb(23, 99, 177)');
    await expect(page.getByTestId('pending')).toHaveCount(0);
    await expect(page.getByRole('heading', {name: 'Shared catalogue'})).toHaveCount(1);
    const shell = await page.getByTestId('shell').textContent();
    await page.getByRole('button', {name: 'Count 0', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Count 1', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Rename visitor', exact: true}).click();
    await expect(page.getByTestId('personal')).toHaveText('Action visitor');
    await expect(page.getByTestId('shell')).toHaveCSS('color', 'rgb(23, 99, 177)');
    await expect(page.getByRole('button', {name: 'Count 1', exact: true})).toBeVisible();
    const refresh = page.waitForResponse(result => result.request().headers().rsc === '1');
    await page.getByRole('button', {name: 'Refresh', exact: true}).click();
    expect((await refresh).headers()['x-prnext-native-ppr']).toBeUndefined();
    await expect(page.getByTestId('personal')).toHaveText('Action visitor');
    await expect(page.getByRole('button', {name: 'Count 1', exact: true})).toBeVisible();
    await expect(page.getByTestId('shell')).toHaveText(shell);
    const privateDocument = await page.reload();
    expect(privateDocument.headers()['x-prnext-native-ppr']).toBeUndefined();
    await expect(page.getByTestId('personal')).toHaveText('Action visitor');
    await expect(page.getByTestId('shell')).toHaveCSS('color', 'rgb(23, 99, 177)');
    expect(errors).toEqual([]);
  } finally {await server?.close(); await fixture.remove();}
});
