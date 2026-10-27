import test from 'node:test';
import assert from 'node:assert/strict';
import { appStyleManager } from './app-styles.mjs';
import { retainAppStyles, selectAppStyles } from './app-style-selection.mjs';

test('parallel CSS retains the active saved slot and its ancestors without retaining inactive main-page globals', () => {
  const saved = { branch:'work/@detail/a', url:'/work/a' };
  const previous = { routing:{ slots:{ main:{branch:'work/a',url:'/work/a'}, detail:saved } }, cssScopes:[
    {path:'',kind:'layout',css:['/root.css']},
    {path:'work',kind:'layout',css:['/work.css']},
    {path:'work/a',kind:'page',css:['/inactive-main-a.css']},
    {path:'work/@detail',kind:'layout',css:['/detail-layout.css']},
    {path:'work/@detail/a',kind:'page',css:['/saved-detail-a.css']},
    {path:'work/@detail/a',kind:'default',css:['/inactive-default.css']},
  ] };
  const model = { routing:{slots:{main:{branch:'work/b',url:'/work/b'},detail:saved}},
    css:['/root.css','/work.css','/main-b.css'],cssScopes:[
      {path:'',kind:'layout',css:['/root.css']},{path:'work',kind:'layout',css:['/work.css']},{path:'work/b',kind:'page',css:['/main-b.css']},
    ] };
  retainAppStyles(model, previous);
  assert.deepEqual(model.css, ['/root.css','/work.css','/main-b.css','/detail-layout.css','/saved-detail-a.css']);
  const replaced = {routing:{slots:{main:{branch:'work/b',url:'/work/b'},detail:{branch:'work/@detail/b',url:'/work/b'}}},css:['/b.css']};
  retainAppStyles(replaced, previous); assert.deepEqual(replaced.css,['/b.css']);
  const next = {routing:{slots:{detail:saved}},css:['/new-root.css'],cssScopes:[{path:'',kind:'layout',css:['/new-root.css']}]};
  retainAppStyles(next, model);
  assert.ok(!next.css.includes('/root.css'), 'new builds replace matching scope URLs');
  assert.ok(next.css.includes('/saved-detail-a.css'));
});

test('interception selects only the actual modal/default or canonical branches before HTML and Flight rendering', () => {
  const scopes=[{path:'',kind:'layout',css:['/root.css']},{path:'photo/[id]',kind:'page',css:['/canonical.css']},{path:'@modal',kind:'default',css:['/default.css']},{path:'@modal/(.)photo/[id]',kind:'page',css:['/modal.css']}];
  const canonical={routing:{slots:{main:{branch:'photo/[id]'},modal:{branch:'@modal#default'}}},cssScopes:scopes};
  selectAppStyles(canonical);assert.deepEqual(canonical.css,['/root.css','/canonical.css','/default.css']);
  const modal={routing:{slots:{main:{branch:'a'},modal:{branch:'@modal/(.)photo/[id]'}}},cssScopes:scopes};
  selectAppStyles(modal);assert.deepEqual(modal.css,['/root.css','/modal.css']);
});

function browser(t, options) {
  const links = [];
  const document = { baseURI: 'https://site.test/docs/page', querySelectorAll: () => links, createElement() {
    const link = Object.assign(new EventTarget(), { rel:'', href:'', media:'', dataset:{}, sheet:null, insertions:0,
      remove() { const index = links.indexOf(link); if (index >= 0) links.splice(index, 1); },
      compareDocumentPosition(other) { return links.indexOf(link) < links.indexOf(other) ? 4 : 2; },
      load() { link.sheet = {}; link.dispatchEvent(new Event('load')); },
      fail() { link.dispatchEvent(new Event('error')); },
    });
    return link;
  } };
  document.head = {
    append(link) { link.insertions++; if (links.includes(link)) link.sheet = null; link.remove(); links.push(link); },
    insertBefore(link, before) { link.insertions++; if (links.includes(link)) link.sheet = null; link.remove(); links.splice(links.indexOf(before), 0, link); },
  };
  const styles = appStyleManager(document, options);
  t.after(async () => { styles.release(); await Promise.resolve(); styles.cancel(); });
  return { document, links, styles, existing(href) { const link = document.createElement(); link.href = new URL(href, document.baseURI).href; link.rel = 'stylesheet'; link.sheet = {}; document.head.append(link); return link; } };
}

test('App stylesheet navigation keeps the old page styled until all new sheets load, then retires old globals in order', async t => {
  const { styles, links, existing } = browser(t);
  const root = existing('/root.css'), old = existing('/a.css');
  await styles.prepare(['/root.css', '/a.css']); styles.commit(['/root.css', '/a.css']);
  const ready = styles.prepare(['/root.css', '/nested.css', '/b.css']);
  assert.equal(links.length, 4);
  assert.equal(old.media, '');
  assert.deepEqual(links.slice(2).map(link => link.media), ['not all', 'not all']);
  links[3].load(); links[2].load(); await ready;
  assert.equal(old.media, '', 'loading does not change the visible old route');
  styles.commit(['/root.css', '/nested.css', '/b.css']);
  assert.deepEqual(links.map(link => link.href), ['root.css', 'nested.css', 'b.css'].map(name => 'https://site.test/' + name));
  assert.ok(links.every(link => link.media === ''));
  assert.equal(links[0], root, 'shared layout sheet is reused');
  assert.ok(!links.includes(old), 'obsolete global selectors leave the document');
});

test('App stylesheet loads deduplicate and failures preserve already committed layouts', async t => {
  const { styles, links, existing } = browser(t);
  existing('/root.css'); styles.commit(['/root.css']);
  const first = styles.prepare(['/root.css', '/broken.css']);
  const second = styles.prepare(['/broken.css']);
  assert.equal(links.length, 2);
  links[1].fail();
  await assert.rejects(first, /Could not load stylesheet/);
  await assert.rejects(second, /Could not load stylesheet/);
  assert.equal(links.length, 1); assert.equal(links[0].href, 'https://site.test/root.css');
  const retry = styles.prepare(['/broken.css']); links[1].load(); await retry;
  styles.commit(['/root.css', '/broken.css']);
  assert.equal(links.length, 2);
});

test('App stylesheet cancellation cannot activate a superseded route or leave a pending timer', async t => {
  const { styles, links, existing } = browser(t);
  const old = existing('/old.css'); styles.commit(['/old.css']);
  const abort = new AbortController(), pending = styles.prepare(['/new.css'], abort.signal);
  abort.abort(); styles.cancel();
  await assert.rejects(pending, { name:'AbortError' });
  assert.deepEqual(links, [old]);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(styles.prepare(['/never-requested.css'], cancelled.signal), { name:'AbortError' });
  assert.deepEqual(links, [old]);
});

test('App styles survive StrictMode replay and local reset restores loaded sheets without another request', async t => {
  const { styles, links, existing } = browser(t);
  const root = existing('/root.css'); styles.commit(['/root.css']);
  styles.release(); styles.commit(['/root.css']); await Promise.resolve();
  assert.deepEqual(links, [root]);
  styles.release(); await Promise.resolve(); assert.equal(root.media,'not all');
  styles.cancel(); styles.cancel();
  assert.deepEqual(links,[root], 'pagehide and a cancelled navigation preserve local-reset recovery sheets');
  styles.commit(['/root.css']);assert.deepEqual(links,[root]);assert.equal(root.media,'');
  assert.equal(root.insertions,1); assert.ok(root.sheet, 'commit never moves a loaded link');
});

test('App styles insert new main-page CSS before a retained slot during prepare without moving shared sheets', async t => {
  const { styles, links, existing } = browser(t);
  const root=existing('/root.css'), main=existing('/old-main.css'), slot=existing('/slot.css');
  styles.commit(['/root.css','/old-main.css','/slot.css']);
  const pending=styles.prepare(['/root.css','/new-main.css','/slot.css']);
  const next=links[2];
  assert.deepEqual(links,[root,main,next,slot]); assert.equal(next.media,'not all');
  assert.equal(root.insertions,1); assert.equal(slot.insertions,1);
  next.load(); await pending; styles.commit(['/root.css','/new-main.css','/slot.css']);
  assert.deepEqual(links,[root,next,slot]);
  for(const link of links){assert.equal(link.insertions,1);assert.ok(link.sheet);assert.equal(link.media,'');}
});

test('App styles prepare reordered occurrences while keeping old globals active, then commit or cancel atomically', async t => {
  const { styles, links, existing } = browser(t);
  const a=existing('/a.css'), b=existing('/b.css'); styles.commit(['/a.css','/b.css']);
  const cancelled=styles.prepare(['/b.css','/a.css']);
  const abandoned=links[0];
  assert.deepEqual(links,[abandoned,a,b]); assert.equal(abandoned.media,'not all');
  assert.equal(a.media,'');assert.equal(b.media,'');
  styles.cancel(); await assert.rejects(cancelled,{name:'AbortError'});assert.deepEqual(links,[a,b]);
  const ready=styles.prepare(['/b.css','/a.css']), replacement=links[0];
  replacement.load(); await ready;
  assert.deepEqual(links,[replacement,a,b]);
  styles.commit(['/b.css','/a.css']);assert.deepEqual(links,[replacement,a]);
  assert.equal(a.insertions,1);assert.equal(b.insertions,1);assert.equal(replacement.insertions,1);
  assert.ok(links.every(link=>link.sheet&&link.media===''));
});

test('App global release retains only committed recovery styles and discards ready abandoned navigation sheets', async t => {
  const { styles, links, existing } = browser(t);
  const root=existing('/root.css');styles.commit(['/root.css']);
  const pending=styles.prepare(['/root.css','/abandoned.css']);links[1].load();await pending;
  styles.release();await Promise.resolve();styles.cancel();
  assert.deepEqual(links,[root]);assert.equal(root.media,'not all');
  styles.commit(['/root.css']);assert.equal(root.media,'');assert.equal(root.insertions,1);
});

test('App CSS handed to a suspended render survives cancellation and pins its exact prepared occurrences', async t => {
  const { styles, links, existing } = browser(t);
  const a=existing('/a.css'),b=existing('/b.css');styles.commit(['/a.css','/b.css']);
  await styles.prepare(['/a.css','/b.css']);styles.handoff(['/a.css','/b.css']);
  const later=styles.prepare(['/b.css','/a.css']),replacement=links[0];
  replacement.load();await later;
  styles.commit(['/a.css','/b.css']);assert.deepEqual(links,[a,b]);
  const reordered=styles.prepare(['/b.css','/a.css']),reserved=links[0];reserved.load();await reordered;styles.handoff(['/b.css','/a.css']);
  styles.release();await Promise.resolve();styles.cancel();
  assert.deepEqual(links,[reserved,a,b], 'fallback retains active and reserved occurrences at their original positions');
  styles.commit(['/b.css','/a.css']);assert.deepEqual(links,[reserved,a]);
  const next=styles.prepare(['/c.css']);const c=links.at(-1);c.load();await next;
  styles.handoff(['/c.css']);styles.cancel();assert.ok(links.includes(c));
  styles.release();await Promise.resolve();styles.cancel();
  assert.ok(links.includes(c));assert.equal(c.media,'not all');
  styles.commit(['/c.css']);assert.deepEqual(links,[c]);assert.equal(c.media,'');assert.equal(c.insertions,1);
  assert.ok(!links.includes(replacement));
});

test('App CSS handoff rejects pending sheets and only retains one supersedable ready render', async t => {
  const { styles, links } = browser(t);
  const a=styles.prepare(['/a.css']);assert.throws(()=>styles.handoff(['/a.css']),/not prepared/);links[0].load();await a;
  styles.handoff(['/a.css']);
  const b=styles.prepare(['/b.css']);const next=links.at(-1);next.load();await b;styles.handoff(['/b.css']);styles.cancel();
  assert.deepEqual(links,[next]);styles.commit(['/b.css']);assert.deepEqual(links,[next]);
});

test('App styles reject invalid lists and bound stalled network requests', async t => {
  const { styles, links } = browser(t, { timeout:5 });
  await assert.rejects(styles.prepare(['javascript:alert(1)']), /protocol/);
  await assert.rejects(styles.prepare(new Array(1025).fill('/a.css')), /list/);
  await assert.rejects(styles.prepare([null]), /URL/);
  await assert.rejects(styles.prepare(['/stalled.css']), /timed out/);
  assert.deepEqual(links, []);
});
