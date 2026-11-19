import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {equalParams} from '../compat/navigation-values.cjs';
import {AppRouterProvider} from '../compat/app-context.cjs';
import {useParams, usePathname, useRouter, useSearchParams} from '../compat/navigation.cjs';

test('navigation params stabilize equivalent scalar and catchall values without reading object getters',()=>{
  assert.equal(equalParams({slug:'one',path:['a','b']},{path:['a','b'],slug:'one'}),true);
  assert.equal(equalParams({path:['a','b']},{path:['a','c']}),false);
  assert.equal(equalParams({path:['a','b']},{path:['b','a']}),false);
  assert.equal(equalParams({slug:'one'},{slug:'two'}),false);
  assert.equal(equalParams({slug:'one'},{}),false);
  assert.equal(equalParams(undefined,{}),false);
  let reads=0;const getter={get slug(){reads++;return'one'}};
  assert.equal(equalParams(getter,{slug:'one'}),false);assert.equal(reads,0);
  assert.equal(equalParams({path:Array(129).fill('a')},{path:Array(129).fill('a')}),false);
});

test('a warm Node SSR render reuses the navigation hook dependencies without keeping request values', () => {
  const navigation = new URL('../compat/navigation.cjs', import.meta.url).href;
  let resolutions = 0;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === navigation) resolutions++;
      return next(specifier, context);
    },
  });
  function Consumer() {
    assert.equal(typeof useRouter().push, 'function');
    return React.createElement('p', null, `${usePathname()} ${useParams().slug} ${useSearchParams().get('q')}`);
  }
  function render(slug) {
    return renderToString(React.createElement(AppRouterProvider, {
      router: { pathname: '/catalogue', search: '?q=' + slug, params: {slug} },
    }, Array.from({length: 256}, (_, key) => React.createElement(Consumer, {key}))));
  }
  try {
    assert.equal(render('one').split('/catalogue one one').length - 1, 256);
    resolutions = 0;
    assert.equal(render('two').split('/catalogue two two').length - 1, 256);
    assert.equal(resolutions, 0, 'warm SSR must not resolve CommonJS dependencies for every hook');
  } finally {
    hooks.deregister();
  }
});
