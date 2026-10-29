// Independent oracle for observable public URL/cookie/response contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as candidate from '../packages/prnext/compat/server.cjs';

const require=createRequire(import.meta.url);
const version=process.env.PRNEXT_NEXT_REFERENCE_VERSION || '16.4.3';
assert.ok(['16.4.1','16.4.3'].includes(version),'Use an explicitly tested reference version');
assert.ok(process.env.PRNEXT_NEXT_REFERENCE,'Set PRNEXT_NEXT_REFERENCE to the intended installed Next.js package');
const directory=path.resolve(process.env.PRNEXT_NEXT_REFERENCE);
assert.equal(JSON.parse(await readFile(path.join(directory,'package.json'),'utf8')).version,version);
const reference=require(path.join(directory,'server.js'));
const config={basePath:'/docs',i18n:{locales:['en','fr'],defaultLocale:'en'}};
const state=value=>({href:value.href,pathname:value.pathname,basePath:value.basePath,locale:value.locale,defaultLocale:value.defaultLocale,buildId:value.buildId,search:value.search,hash:value.hash});

test(`Next ${version} canonical data URLs, mounting, locales and independent clones match`,()=>{
  // Next's localized data URLs include a locale segment, including the root.
  for(const pathname of ['/hello/?q=1#x','/docs/fr/hello/?q=1','/_next/data/BUILD/hello.json','/docs/_next/data/BUILD/fr/hello.json','/_next/data/BUILD/en/index.json']){
    const observe=({NextRequest})=>{
      const request=new NextRequest('https://site.test'+pathname,{nextConfig:config}),initial=state(request.nextUrl),clone=request.nextUrl.clone();
      clone.pathname='/changed';clone.locale='fr';clone.buildId='OTHER';
      const changed=state(clone);clone.buildId=undefined;
      return{initial,changed,cleared:state(clone),original:state(request.nextUrl)};
    };
    assert.deepEqual(observe(candidate),observe(reference),pathname);
  }
  const root=({NextRequest})=>state(new NextRequest('https://site.test/_next/data/BUILD/index.json').nextUrl);
  assert.deepEqual(root(candidate),root(reference),'unlocalized root data URL');
});

test(`Next ${version} web request cookies match parsing, malformed input, mutation results and header synchronization`,()=>{
  const observe=({NextRequest})=>{
    const request=new NextRequest('https://site.test/',{headers:{cookie:'a=one; b=two%20words; a=last; empty=; bad=%E0%A4%A'}});
    const initial=request.cookies.getAll();
    const same=request.cookies.set({name:'new',value:'x y'})===request.cookies;
    const deleted=request.cookies.delete(['a','missing']);
    const absent=request.cookies.delete('a'),mutated=request.cookies.getAll(),header=request.headers.get('cookie');
    const cleared=request.cookies.clear()===request.cookies;
    return{initial,same,deleted,absent,mutated,header,cleared,final:request.cookies.getAll(),finalHeader:request.headers.get('cookie')};
  };
  assert.deepEqual(observe(candidate),observe(reference));
});

test(`Next ${version} response cookies match observable values and HTTP attribute semantics`,()=>{
  // Attribute order and case are insignificant in HTTP; keep cookie values and
  // path/domain case untouched while comparing the actual security attributes.
  const cookies=headers=>headers.getSetCookie().map(value=>{
    const [pair,...attributes]=value.split(';').map(value=>value.trim());
    return[pair,attributes.map(value=>{
      const split=value.indexOf('='),name=(split<0?value:value.slice(0,split)).toLowerCase(),data=split<0?null:value.slice(split+1);
      return[name,['samesite','priority'].includes(name)?data?.toLowerCase():data];
    }).sort(([left],[right])=>left.localeCompare(right))];
  });
  const observe=({NextResponse})=>{
    const response=NextResponse.json({ok:true});response.cookies.set('session','a b',{httpOnly:true,sameSite:'lax',secure:true});
    response.cookies.set({name:'other',value:'c',path:'/docs',expires:new Date('2030-01-01T00:00:00Z')});
    const before={all:response.cookies.getAll(),wire:cookies(response.headers)};
    response.cookies.delete('session');
    return{before,after:{all:response.cookies.getAll(),wire:cookies(response.headers)}};
  };
  assert.deepEqual(observe(candidate),observe(reference));
});

test(`Next ${version} response redirects, rewrites and request-header overrides match`,()=>{
  for(const operation of ['next','rewrite','redirect']){
    const observe=({NextResponse})=>{
      const init={headers:{'x-test':'ok'},request:{headers:new Headers({'x-user':'one'})}};
      const response=operation==='next'?NextResponse.next(init):operation==='rewrite'?NextResponse.rewrite(new URL('https://site.test/target?q=1'),init):NextResponse.redirect(new URL('https://site.test/target?q=1'),{status:308,headers:init.headers});
      return{status:response.status,headers:[...response.headers]};
    };
    assert.deepEqual(observe(candidate),observe(reference),operation);
  }
});
