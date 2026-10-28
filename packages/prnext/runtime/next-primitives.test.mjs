import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest,NextURL} from '../compat/server.cjs';
import {parseCookieHeader} from '../compat/cookies.cjs';

const config={basePath:'/docs',i18n:{locales:['en','fr'],defaultLocale:'en'}};
test('Next data URLs expose their logical pathname, locale and build identity and preserve them through mutations',()=>{
  const value=new NextURL('https://site.test/docs/_next/data/BUILD/fr/article.json?q=1#section',{nextConfig:config});
  assert.equal(value.pathname,'/article');assert.equal(value.buildId,'BUILD');assert.equal(value.locale,'fr');assert.equal(value.basePath,'/docs');
  assert.equal(value.href,'https://site.test/docs/_next/data/BUILD/fr/article.json?q=1#section');
  const clone=value.clone();clone.pathname='/other';clone.locale='en';clone.buildId='NEXT';
  assert.equal(clone.href,'https://site.test/docs/_next/data/NEXT/en/other.json?q=1#section');
  assert.equal(value.pathname,'/article');assert.equal(value.buildId,'BUILD');
  clone.buildId=undefined;assert.equal(clone.href,'https://site.test/docs/other?q=1#section');
  clone.href='https://site.test/outside';assert.equal(clone.buildId,undefined);assert.equal(clone.basePath,'');
});

test('root data URLs and explicitly forced default locales keep their public URL shapes',()=>{
  const root=new NextURL('https://site.test/_next/data/BUILD/index.json');
  assert.equal(root.pathname,'/');assert.equal(root.href,'https://site.test/_next/data/BUILD/index.json');
  const translated=new NextURL('https://site.test/docs/article',{nextConfig:config,forceLocale:true});
  assert.equal(translated.href,'https://site.test/docs/en/article');assert.equal(translated.clone().href,translated.href);
  const raw=new NextURL('https://site.test/docs/_next/data/BUILD/fr/article.json',{nextConfig:{...config,skipProxyUrlNormalize:true}});
  assert.equal(raw.pathname,'/_next/data/BUILD/fr/article.json');assert.equal(raw.href,'https://site.test/docs/_next/data/BUILD/fr/article.json');
});

test('web request cookies ignore malformed encodings without changing the legacy Pages API parser',()=>{
  const request=new NextRequest('https://site.test/',{headers:{cookie:'good=two%20words; broken=%E0%A4%A; percent=%xx; empty='}});
  assert.deepEqual(request.cookies.getAll(),[{name:'good',value:'two words'},{name:'empty',value:''}]);
  assert.equal(parseCookieHeader('broken=%xx').get('broken').value,'%xx');
});

test('request cookie mutation reports boolean deletion results and keeps headers synchronized without response attributes',()=>{
  const request=new NextRequest('https://site.test/',{headers:{cookie:'one=1; two=2; three=3'}});
  assert.equal(request.cookies.set({name:'new',value:'x y',path:'/ignored'}),request.cookies);
  assert.deepEqual(request.cookies.get('new'),{name:'new',value:'x y'});
  assert.deepEqual(request.cookies.delete(['two','missing']),[true,false]);
  assert.equal(request.cookies.delete('one'),true);assert.equal(request.cookies.delete('one'),false);
  assert.equal(request.headers.get('cookie'),'three=3; new=x%20y');
  assert.equal(request.cookies.clear(),request.cookies);assert.equal(request.cookies.size,0);assert.equal(request.headers.get('cookie'),'');
});
