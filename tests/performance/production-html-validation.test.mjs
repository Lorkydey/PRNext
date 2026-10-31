import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixtureTableRowCount, hasFixtureTable } from './production-html-validation.mjs';

function table(count) {
  return renderToStaticMarkup(createElement('table', null, createElement('tbody', null, Array.from({ length: count }, (_, index) => createElement('tr', { key: index }, createElement('td', null, index), createElement('td', null, 'row ' + index), createElement('td', null, index * 7))))));
}

test('all three cells of every real SSR row are required, with the heavy fixture using 1000 rows', () => {
  const normal = table(100), heavy = table(1000);
  for (const route of ['/ssr', '/legacy', '/guarded', '/static', '/ssr?value=1']) {
    assert.equal(fixtureTableRowCount(route), 100);
    assert.equal(hasFixtureTable(Buffer.from('<main>' + normal + '</main>'), route), true);
    for (const corrupted of [table(99), normal.replace('<td>row 42</td>', '<td>wrong</td>'), normal.replace('<td>294</td>', '<td>295</td>'), normal.replace('<td>0</td>', '')]) assert.equal(hasFixtureTable(Buffer.from(corrupted), route), false);
  }
  assert.equal(hasFixtureTable(Buffer.from(heavy), '/heavy'), true);
  assert.equal(hasFixtureTable(Buffer.from(normal), '/heavy'), false);
  assert.equal(hasFixtureTable(Buffer.from(heavy), '/ssr'), false);
});

test('a valid table serialized only inside script, raw text or a comment is not rendered SSR evidence', () => {
  const normal = table(100);
  for (const body of [`<script>${normal}</script>`, `<script>${normal}`, `<!--${normal}-->`, `<textarea>${normal}</textarea>`, `<plaintext>${normal}`]) assert.equal(hasFixtureTable(Buffer.from(body), '/ssr'), false);
  assert.equal(hasFixtureTable(Buffer.from('<script>bootstrap()</script><main>' + normal + '</main>'), '/ssr'), true);
  assert.equal(hasFixtureTable(Buffer.from('stream user:one completed:one'), '/stream?delay=40'), true);
  assert.equal(hasFixtureTable(Buffer.from('static payload'), '/payload.txt'), true);
});
