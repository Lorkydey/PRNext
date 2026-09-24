import test from 'node:test';
import assert from 'node:assert/strict';
import {validateI18n,expandLocales,localizedStaticPaths} from './i18n.mjs';
import {localizedHref} from '../compat/locale.cjs';
import {NextURL} from '../compat/server-primitives.cjs';
const i18n=validateI18n({locales:['en','fr','nl'],defaultLocale:'en',domains:[{domain:'en.test',defaultLocale:'en'},{domain:'fr.test',defaultLocale:'fr',http:true}]});
test('locale validation, static path variants and domain-aware links preserve canonical paths',()=>{
  for(const config of [{locales:['fr','FR'],defaultLocale:'fr'},{locales:['fr'],defaultLocale:'en'},{locales:['fr'],defaultLocale:'fr',domains:[{domain:'https://fr.test',defaultLocale:'fr'}]}])assert.throws(()=>validateI18n(config));
  const manifest={config:{i18n},routes:[{id:'article',pattern:'/article/[id]',kind:'page',module:'shared.mjs',client:'shared.js'}]};expandLocales(manifest);
  const route=manifest.routes.find(route=>route.locale==='fr');
  assert.equal(route.pattern,'/fr/article/[id]');assert.equal(new Set(manifest.routes.map(route=>route.module)).size,1);
  assert.deepEqual(localizedStaticPaths(route,{paths:[{params:{id:'one'},locale:'fr'},{params:{id:'two'}}],fallback:false},i18n).paths,[{path:'/fr/article/one',params:{id:'one'}}]);
  assert.equal(localizedHref('/article/one',{i18n,domain:'fr.test',locale:'fr',basePath:'/docs'},'en'),'https://en.test/docs/article/one');
  assert.equal(localizedHref('/article/one',{i18n,domain:'fr.test',locale:'fr',basePath:'/docs'}),'/docs/article/one');
  assert.equal(localizedHref('/en/article/one',{i18n,locale:'fr'},false),'/en/article/one');
});
test('NextURL locale setters, domains, base paths and clones retain language identity',()=>{
  const url=new NextURL('http://fr.test/docs/article/one?q=1',{nextConfig:{basePath:'/docs',i18n}});
  assert.equal(url.locale,'fr');assert.equal(url.defaultLocale,'fr');assert.equal(url.pathname,'/article/one');
  url.locale='nl';assert.equal(url.href,'http://fr.test/docs/nl/article/one?q=1');
  const clone=url.clone();clone.pathname='/other';assert.equal(clone.href,'http://fr.test/docs/nl/other?q=1');assert.equal(url.pathname,'/article/one');assert.throws(()=>{url.locale='unknown'});
});
